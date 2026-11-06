// Zotero access layer for @local/zotero-bridge.
//
// Reads the local Zotero SQLite database directly (read-only). Zotero keeps
// its own connection in WAL mode, so a read-only connection opened from
// another process is safe and does not block the running application.
// Selected-items and PDF text extraction go through Zotero's HTTP connector
// server on 127.0.0.1:23119, or pdftotext for full text.

import { execFile, spawn } from 'node:child_process'
import { access, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Resolve a Python 3 interpreter. Prefer an explicit override, then the
// bundled DSH runtime Python, then any python3 on PATH.
function resolvePython() {
  if (process.env.DSH_ZOTERO_PYTHON) return process.env.DSH_ZOTERO_PYTHON
  const dshRuntime = process.env.DSH_RUNTIME_PYTHON
    || join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'bin', 'python3')
  return dshRuntime
}
const PYTHON = resolvePython()
const CONNECTOR = 'http://127.0.0.1:23119'

// ---------------------------------------------------------------------------
// Python helper: one process per query, JSON request on stdin, JSON on stdout.
// ---------------------------------------------------------------------------

const HELPER = String.raw`
import json, re, sqlite3, sys

TAG_RE = re.compile(r'<[^>]+>')
WS_RE = re.compile(r'[ \t]+')

def html_to_text(s):
    if not s:
        return ''
    s = re.sub(r'<(br|/p|/div|/li|/h[1-6])[^>]*>', '\n', s, flags=re.I)
    s = TAG_RE.sub('', s)
    s = (s.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
           .replace('&quot;', '"').replace('&#39;', "'").replace('&nbsp;', ' '))
    lines = [WS_RE.sub(' ', ln).strip() for ln in s.split('\n')]
    return '\n'.join(ln for ln in lines if ln)

def esc_like(q):
    return q.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')

def load_creators(db, ids):
    out = {}
    marks = ','.join('?' * len(ids))
    for iid, last, first in db.execute(
        'SELECT ic.itemID, c.lastName, c.firstName FROM itemCreators ic '
        'JOIN creators c ON c.creatorID = ic.creatorID WHERE ic.itemID IN (' + marks + ') '
        'ORDER BY ic.itemID, ic.orderIndex', ids):
        name = ((last or '') + ((' ' + first) if first else '')) if last else (first or '')
        out.setdefault(iid, []).append(name.strip())
    return out

def load_collections(db, ids):
    out = {}
    marks = ','.join('?' * len(ids))
    for iid, name in db.execute(
        'SELECT ci.itemID, c.collectionName FROM collectionItems ci '
        'JOIN collections c ON c.collectionID = ci.collectionID '
        'WHERE ci.itemID IN (' + marks + ')', ids):
        out.setdefault(iid, []).append(name)
    return out

def load_abstracts(db, ids):
    out = {}
    marks = ','.join('?' * len(ids))
    for iid, val in db.execute(
        "SELECT d.itemID, v.value FROM itemData d JOIN itemDataValues v ON v.valueID = d.valueID "
        "JOIN fields f ON f.fieldID = d.fieldID WHERE f.fieldName = 'abstractNote' "
        'AND d.itemID IN (' + marks + ')', ids):
        out[iid] = val
    return out

def base_select():
    return (
        "SELECT i.itemID, i.key, it.typeName, dv.value, "
        "(SELECT ddv.value FROM itemData dd JOIN fields fd ON fd.fieldID = dd.fieldID "
        "AND fd.fieldName = 'date' JOIN itemDataValues ddv ON ddv.valueID = dd.valueID "
        "WHERE dd.itemID = i.itemID) "
        "FROM items i JOIN itemTypes it ON it.itemTypeID = i.itemTypeID "
        "JOIN itemData dt ON dt.itemID = i.itemID "
        "JOIN fields ft ON ft.fieldID = dt.fieldID AND ft.fieldName = 'title' "
        "JOIN itemDataValues dv ON dv.valueID = dt.valueID "
        "WHERE i.itemID NOT IN (SELECT itemID FROM deletedItems) "
    )

def search(db, query, item_type, limit):
    sql = base_select() + "AND it.typeName NOT IN ('note','attachment','annotation') "
    params = []
    if item_type:
        sql += 'AND it.typeName = ? '
        params.append(item_type)
    if query:
        like = '%' + esc_like(query) + '%'
        sql += ("AND (dv.value LIKE ? ESCAPE '\\' "
                'OR i.itemID IN (SELECT ic.itemID FROM itemCreators ic JOIN creators c '
                "ON c.creatorID = ic.creatorID WHERE c.lastName LIKE ? ESCAPE '\\' "
                "OR c.firstName LIKE ? ESCAPE '\\') "
                'OR i.itemID IN (SELECT it2.itemID FROM itemTags it2 JOIN tags t '
                "ON t.tagID = it2.tagID WHERE t.name LIKE ? ESCAPE '\\')) ")
        params += [like, like, like, like]
    sql += 'ORDER BY i.dateAdded DESC LIMIT ?'
    params.append(limit * 4)
    hits, seen = [], set()
    for iid, key, type_name, title, date in db.execute(sql, params):
        if key in seen:
            continue
        seen.add(key)
        hits.append((iid, key, type_name, title, date))
        if len(hits) >= limit:
            break
    ids = [h[0] for h in hits]
    if not ids:
        return []
    creators = load_creators(db, ids)
    colls = load_collections(db, ids)
    abstracts = load_abstracts(db, ids)
    return [{
        'key': key, 'itemType': type_name, 'title': title or '',
        'creators': creators.get(iid, []), 'date': date or '',
        'collections': colls.get(iid, []),
        'abstract': html_to_text(abstracts.get(iid, ''))[:500],
    } for iid, key, type_name, title, date in hits]

def item(db, key, note_limit, anno_limit):
    row = db.execute(base_select() + 'AND i.key = ?', [key]).fetchone()
    if not row:
        return None
    creators = load_creators(db, [row[0]])
    colls = load_collections(db, [row[0]])
    abstracts = load_abstracts(db, [row[0]])
    iid, ikey, type_name, title, date = row
    fields = {}
    for fname, val in db.execute(
            'SELECT f.fieldName, v.value FROM itemData d JOIN fields f ON f.fieldID = d.fieldID '
            'JOIN itemDataValues v ON v.valueID = d.valueID WHERE d.itemID = ?', [iid]):
        fields[fname] = val
    tags = [r[0] for r in db.execute(
        'SELECT t.name FROM itemTags it2 JOIN tags t ON t.tagID = it2.tagID WHERE it2.itemID = ?', [iid])]
    notes = []
    for nkey, ntext in db.execute(
            'SELECT ni.key, n.note FROM itemNotes n JOIN items ni ON ni.itemID = n.itemID '
            'WHERE n.parentItemID = ? AND ni.itemID NOT IN (SELECT itemID FROM deletedItems)', [iid]):
        notes.append({'key': nkey, 'text': html_to_text(ntext)[:note_limit]})
    annotations = []
    for akey, atext, acomment, alabel in db.execute(
            'SELECT ai.key, a.text, a.comment, a.pageLabel FROM itemAnnotations a '
            'JOIN items ai ON ai.itemID = a.itemID WHERE a.parentItemID IN '
            '(SELECT itemID FROM itemAttachments WHERE parentItemID = ?) '
            'AND ai.itemID NOT IN (SELECT itemID FROM deletedItems) LIMIT ?', [iid, anno_limit]):
        annotations.append({'key': akey, 'text': atext or '', 'comment': acomment or '',
                            'pageLabel': alabel or ''})
    pdfs = []
    for akey, path in db.execute(
            'SELECT ai.key, a.path FROM itemAttachments a JOIN items ai ON ai.itemID = a.itemID '
            "WHERE a.parentItemID = ? AND a.contentType = 'application/pdf' "
            'AND ai.itemID NOT IN (SELECT itemID FROM deletedItems)', [iid]):
        pdfs.append({'key': akey, 'path': path or ''})
    return {
        'key': ikey, 'itemType': type_name, 'title': title or '',
        'creators': creators.get(iid, []), 'date': date or '',
        'collections': colls.get(iid, []), 'tags': tags,
        'abstract': html_to_text(abstracts.get(iid, '')),
        'fields': {k: v for k, v in fields.items() if k not in ('title', 'date', 'abstractNote')},
        'notes': notes, 'annotations': annotations, 'pdfs': pdfs,
    }

def note(db, key, limit):
    row = db.execute(
        'SELECT n.note, n.parentItemID FROM itemNotes n JOIN items i ON i.itemID = n.itemID '
        'WHERE i.key = ? AND i.itemID NOT IN (SELECT itemID FROM deletedItems)', [key]).fetchone()
    if not row:
        return None
    text, parent = row
    parent_key = None
    if parent:
        prow = db.execute('SELECT key FROM items WHERE itemID = ?', [parent]).fetchone()
        parent_key = prow[0] if prow else None
    return {'key': key, 'parentKey': parent_key, 'text': html_to_text(text)[:limit]}

def attachment(db, key):
    return db.execute(
        'SELECT a.path, a.contentType FROM itemAttachments a JOIN items i ON i.itemID = a.itemID '
        'WHERE i.key = ? AND i.itemID NOT IN (SELECT itemID FROM deletedItems)', [key]).fetchone()

def connect_ro(path):
    # Read-only with a busy timeout, so a brief Zotero write transaction
    # delays the query instead of failing with "database is locked".
    db = sqlite3.connect('file:' + path + '?mode=ro', uri=True, timeout=8.0)
    db.execute('PRAGMA busy_timeout = 8000')
    return db

def main():
    req = json.load(sys.stdin)
    db = connect_ro(req['dbPath'])
    try:
        op = req['op']
        if op == 'search':
            out = search(db, req.get('query', ''), req.get('itemType'), int(req.get('limit', 10)))
        elif op == 'item':
            out = item(db, req['key'], int(req.get('noteLimit', 4000)), int(req.get('annoLimit', 20)))
        elif op == 'note':
            out = note(db, req['key'], int(req.get('limit', 20000)))
        elif op == 'attachment':
            out = attachment(db, req['key'])
        else:
            raise SystemExit('unknown op: ' + str(op))
        json.dump(out, sys.stdout, ensure_ascii=False)
    finally:
        db.close()

main()
`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Query strategy: read a point-in-time snapshot copy of the database files.
// Zotero holds long write transactions on its WAL-mode database (it never
// auto-checkpoints while running), and a second reader — even read-only with
// a busy timeout — stalls for the whole transaction. Copying db + wal + shm
// costs ~50 ms and is always consistent for reads at one instant.
async function runPython(dbPath, request) {
  let lastError
  try {
    return await runOnSnapshot(dbPath, request)
  } catch (error) {
    lastError = error
  }
  // Snapshot copy failed (disk pressure, transient race) — try the live file.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await runPythonOnce(dbPath, request)
    } catch (error) {
      lastError = error
      if (!/locked/i.test(String(error?.message))) throw error
      await sleep(400 * (attempt + 1))
    }
  }
  throw lastError
}

async function runOnSnapshot(dbPath, request) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zotero-'))
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      await copyFile(dbPath + suffix, join(dir, 'zotero.sqlite' + suffix)).catch(() => {})
    }
    return await runPythonOnce(join(dir, 'zotero.sqlite'), request)
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function runPythonOnce(dbPath, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-c', HELPER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Zotero database query timed out'))
    }, 20000)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => {
      clearTimeout(timer)
      reject(new Error('Failed to start python3 for Zotero access: ' + e.message))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error('Zotero query failed: ' + (err.trim() || 'exit ' + code)))
      else {
        try { resolve(JSON.parse(out)) } catch { reject(new Error('Zotero query returned bad JSON')) }
      }
    })
    child.stdin.end(JSON.stringify({ dbPath, ...request }))
  })
}

// ---------------------------------------------------------------------------
// Public access object
// ---------------------------------------------------------------------------

export function createZotero(config) {
  const dataDir = config.dataDir || join(homedir(), 'Zotero')
  const dbPath = join(dataDir, 'zotero.sqlite')
  const connectorBase = (config.connectorUrl || CONNECTOR).replace(/\/+$/, '')
  const pdftotextPath = config.pdftotextPath || ''

  async function ensureReadable() {
    try {
      await access(dbPath)
    } catch {
      throw new Error(`Cannot read the Zotero database at ${dbPath}. `
        + 'Check the dataDir setting of the Zotero bridge plugin.')
    }
  }

  async function zoteroRunning() {
    try {
      const res = await fetch(connectorBase + '/connector/ping', { signal: AbortSignal.timeout(3000) })
      return res.ok
    } catch {
      return false
    }
  }

  return {
    dbPath,
    connectorBase,

    async searchItems({ query = '', itemType, limit = 10 }) {
      await ensureReadable()
      const items = await runPython(dbPath, { op: 'search', query, itemType, limit })
      return { items, zoteroRunning: await zoteroRunning() }
    },

    async getItem({ key }) {
      await ensureReadable()
      const found = await runPython(dbPath, { op: 'item', key })
      if (!found) throw new Error(`No Zotero item with key ${key}`)
      return found
    },

    async getNote({ noteKey }) {
      await ensureReadable()
      const found = await runPython(dbPath, { op: 'note', key: noteKey })
      if (!found) throw new Error(`No Zotero note with key ${noteKey}`)
      return found
    },

    async getSelectedItems() {
      const res = await fetch(connectorBase + '/connector/getSelectedItems?t=' + Date.now(), {
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        throw new Error(
          'Could not read the Zotero selection (HTTP ' + res.status + '). '
          + 'Make sure Zotero is running with the library window focused. '
          + 'On Zotero 7.1+ this endpoint additionally requires "Allow other applications '
          + 'on this computer to communicate with Zotero" under Settings → Advanced; '
          + 'otherwise pick entries with zotero_search instead.',
        )
      }
      const body = await res.json()
      return Array.isArray(body) ? body : (body.items ?? [])
    },

    async getPdfText({ attachmentKey }) {
      if (!pdftotextPath) {
        throw new Error(
          'PDF text extraction needs pdftotext. Install it with "brew install poppler" '
          + 'and set pdftotextPath in the Zotero bridge plugin settings, '
          + "or read the item's notes and annotations instead.",
        )
      }
      await ensureReadable()
      const row = await runPython(dbPath, { op: 'attachment', key: attachmentKey })
      if (!row || !row[0]) throw new Error(`No attachment with key ${attachmentKey}`)
      let path = row[0]
      if (path.startsWith('storage:')) path = join(dataDir, 'storage', attachmentKey, path.slice(8))
      else if (!path.startsWith('/')) path = join(dataDir, 'storage', attachmentKey, path)
      const { stdout: text } = await execFileAsync(pdftotextPath, [path, '-'], {
        timeout: 60000,
        maxBuffer: 8 * 1024 * 1024,
      })
      return { attachmentKey, path, text: text.slice(0, 200000) }
    },
  }
}
