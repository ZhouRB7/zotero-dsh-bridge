// @local/zotero-bridge — two-way bridge between DeepSeek Harness and Zotero.
//
// DSH → Zotero: agent tools that read the local Zotero library
//   (zotero_search, zotero_get_item, zotero_get_note, zotero_get_selected,
//    zotero_get_pdf_text).
// Zotero → DSH: HTTP bridge endpoints on the DSH web server
//   (GET /zotero-bridge/health, POST /zotero-bridge/chat) that receive prompts
//   from a Zotero plugin (e.g. a Better Notes template) and deliver them into
//   a dedicated DSH chat session.

import { randomUUID } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createZotero } from './zotero.js'

export const inject = ['tools', 'agents', 'sessions', 'webServer', 'sessionController', 'connection', 'workspaceRegistry', 'webApp']

// Well-known file the Zotero-side plugin reads to discover the current DSH
// endpoint (the web port changes on every DSH restart).
const ENDPOINT_FILE = join(homedir(), '.dsh', 'zotero-bridge.json')

const textResult = text => [{ type: 'text', text }]
const jsonResult = value => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
const toJson = value => JSON.parse(JSON.stringify(value))

const PLAIN_TEXT = {
  schema: { type: 'string' },
  render: (_args, value) => textResult(typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
}
const JSON_OUT = {
  schema: { type: 'object' },
  render: (_args, value) => jsonResult(value),
}

export function apply(ctx, config) {
  const zotero = createZotero(config)

  // -------------------------------------------------------------------------
  // Agent tools (DSH → Zotero)
  // -------------------------------------------------------------------------

  ctx.effect(() => ctx.tools.register({
    name: 'zotero_search',
    description:
      "Search the user's local Zotero library (works while Zotero is running). "
      + 'Matches title, creator names, and tags. Returns item keys, titles, creators, '
      + 'dates, collections, and abstract snippets. Use zotero_get_item with a returned '
      + 'key for full details including notes and PDF annotations.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword matched against title, creator, and tag.' },
        itemType: {
          type: 'string',
          description: "Optional Zotero item type filter such as 'journalArticle' or 'book'.",
        },
        limit: { type: 'integer', description: 'Maximum number of results (default 10, max 25).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: JSON_OUT,
    async execute(args) {
      const limit = Math.min(Math.max(1, args?.limit ?? 10), 25)
      const result = await zotero.searchItems({ query: args?.query ?? '', itemType: args?.itemType, limit })
      return toJson(result)
    },
    isConcurrencySafe: () => true,
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'zotero_get_item',
    description:
      'Get full details of one Zotero library item by its key: metadata fields, tags, '
      + 'collections, abstract, plain-text notes, PDF annotations (highlighted text with '
      + 'comments and page labels), and PDF attachment keys for zotero_get_pdf_text.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The Zotero item key (e.g. "ABCD2345").' },
      },
      required: ['key'],
      additionalProperties: false,
    },
    output: JSON_OUT,
    async execute(args) {
      return toJson(await zotero.getItem({ key: String(args?.key ?? '') }))
    },
    isConcurrencySafe: () => true,
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'zotero_get_note',
    description:
      'Read one Zotero note as plain text by its note key. Note keys appear in the '
      + '"notes" array of zotero_get_item results. Use this when a note was truncated '
      + 'in zotero_get_item or when the user references a specific note.',
    parameters: {
      type: 'object',
      properties: {
        noteKey: { type: 'string', description: 'The Zotero note item key.' },
      },
      required: ['noteKey'],
      additionalProperties: false,
    },
    output: JSON_OUT,
    async execute(args) {
      return toJson(await zotero.getNote({ noteKey: String(args?.noteKey ?? '') }))
    },
    isConcurrencySafe: () => true,
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'zotero_get_selected',
    description:
      'List the items currently selected in the Zotero application window. Use when the '
      + 'user says "this paper", "the selected items", or similar. Requires Zotero to be '
      + 'running with the library window focused; on Zotero 7.1+ it also requires '
      + '"Allow other applications on this computer to communicate with Zotero" in '
      + 'Settings → Advanced.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: JSON_OUT,
    async execute() {
      return toJson(await zotero.getSelectedItems())
    },
    isConcurrencySafe: () => true,
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'zotero_get_pdf_text',
    description:
      'Extract the full text of a PDF attachment by its attachment key (from the "pdfs" '
      + 'array of zotero_get_item). Requires pdftotext (brew install poppler) configured '
      + 'in the Zotero bridge plugin settings. Prefer notes/annotations first; use this '
      + 'only when full text is actually needed.',
    parameters: {
      type: 'object',
      properties: {
        attachmentKey: { type: 'string', description: 'The Zotero PDF attachment item key.' },
      },
      required: ['attachmentKey'],
      additionalProperties: false,
    },
    output: JSON_OUT,
    timeoutMs: 90000,
    async execute(args) {
      return toJson(await zotero.getPdfText({ attachmentKey: String(args?.attachmentKey ?? '') }))
    },
    isConcurrencySafe: () => true,
  }))

  // -------------------------------------------------------------------------
  // Chat bridge (Zotero → DSH)
  // -------------------------------------------------------------------------

  const sessionTitlePrefix = config.sessionTitlePrefix || 'Zotero'
  let bridgeWorkspaceId = null
  // One dedicated session per Zotero item (keyed by itemKey), plus a
  // fallback "general" session for messages without an item.
  const itemSessions = new Map()

  function jsonResponse(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    })
    res.end(payload)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', chunk => {
        data += chunk
        if (data.length > 1024 * 1024) {
          reject(new Error('Request body too large'))
          req.destroy()
        }
      })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
  }

  async function ensureWorkspace() {
    if (bridgeWorkspaceId) return bridgeWorkspaceId
    const dir = join(homedir(), '.dsh', 'zotero-dsh-bridge')
    await mkdir(dir, { recursive: true })
    const workspace = await ctx.workspaceRegistry.create(dir, 'zotero-dsh-bridge')
    bridgeWorkspaceId = workspace.id
    return workspace.id
  }

  // Reuse or create a session for one item key. The session lives in the
  // fixed "zotero-dsh-bridge" workspace.
  async function ensureItemSession(itemKey) {
    const key = itemKey || 'general'
    if (itemSessions.has(key)) {
      const sid = itemSessions.get(key)
      const resolved = await ctx.sessionController.resolveAgent(sid)
      if (resolved.agent) return sid
      itemSessions.delete(key)
    }
    const workspaceId = await ensureWorkspace()
    const created = await ctx.sessionController.create({ workspaceId })
    itemSessions.set(key, created.sessionId)
    return created.sessionId
  }

  async function handleChat(req, res) {
    if (req.method === 'OPTIONS') return jsonResponse(res, 204, {})
    if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'POST only' })
    let body
    try {
      body = JSON.parse(await readBody(req) || '{}')
    } catch {
      return jsonResponse(res, 400, { error: 'Invalid JSON body' })
    }
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message) return jsonResponse(res, 400, { error: 'Missing "message" string' })
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null
    const itemKey = typeof body.itemKey === 'string' && body.itemKey.trim() ? body.itemKey.trim() : null
    try {
      const sessionId = await ensureItemSession(itemKey)
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if (!resolved.agent) {
        throw new Error(String(resolved.error?.message || resolved.error?.code || 'session unavailable'))
      }
      await ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: title ? `【来自 Zotero：${title}】\n${message}` : `【来自 Zotero】\n${message}` }],
      }, new AbortController().signal)
      jsonResponse(res, 200, { ok: true, sessionId, itemKey: itemKey || 'general' })
    } catch (error) {
      jsonResponse(res, 502, { ok: false, error: String(error?.message || error) })
    }
  }

  function handleHealth(req, res) {
    if (req.method === 'OPTIONS') return jsonResponse(res, 204, {})
    jsonResponse(res, 200, {
      ok: true,
      sessionCount: itemSessions.size,
      sessionTitlePrefix,
      zoteroDb: zotero.dbPath,
      openUrl: openUrl(),
    })
  }

  function openUrl() {
    try {
      const advertised = ctx.webApp?.getAdvertisedUrl?.()
      const origin = ctx.webServer.getOrigin()
      const authed = ctx.connection.authenticatedUrl(advertised || origin)
      return authed
    } catch (e) {
      try { return ctx.webServer.getOrigin() } catch { return null }
    }
  }

  function handleDebug(req, res) {
    if (req.method === 'OPTIONS') return jsonResponse(res, 204, {})
    const out = {}
    try { out.getAdvertisedUrl = ctx.webApp?.getAdvertisedUrl?.() } catch (e) { out.getAdvertisedUrl = 'ERR:' + e.message }
    try { out.getOrigin = ctx.webServer.getOrigin() } catch (e) { out.getOrigin = 'ERR:' + e.message }
    try { out.authenticated = ctx.connection.authenticatedUrl(out.getOrigin || 'http://127.0.0.1') } catch (e) { out.authenticated = 'ERR:' + e.message }
    try { out.authenticated2 = ctx.connection.authenticatedUrl(out.getAdvertisedUrl || 'http://127.0.0.1') } catch (e) { out.authenticated2 = 'ERR:' + e.message }
    try { out.env = { DSH_WEB_URL: process.env.DSH_WEB_URL } } catch (e) {}
    jsonResponse(res, 200, out)
  }

  function handleStatus(req, res) {
    if (req.method === 'OPTIONS') return jsonResponse(res, 204, {})
    // status now takes an optional itemKey query param to read that item's session
    const url = new URL(req.url, 'http://localhost')
    const itemKey = url.searchParams.get('itemKey') || 'general'
    const sessionId = itemSessions.get(itemKey)
    if (!sessionId) return jsonResponse(res, 200, { ok: true, sessionId: null, itemKey, openUrl: openUrl() })
    const session = ctx.sessions.get(sessionId)
    if (!session) return jsonResponse(res, 200, { ok: true, sessionId, itemKey, available: false })
    const messages = session.deriveMessages()
    const latestAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    const assistantText = latestAssistant
      ? (Array.isArray(latestAssistant.content) ? latestAssistant.content : [])
          .filter(block => block.type === 'text').map(block => block.text).join('\n')
      : ''
    const agent = ctx.agents.get(sessionId)
    jsonResponse(res, 200, {
      ok: true,
      sessionId,
      itemKey,
      available: true,
      running: agent ? agent.status === 'running' : false,
      reply: assistantText,
      seq: Number(session.seq),
      openUrl: openUrl(),
    })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/zotero-bridge/health', handler: handleHealth }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/zotero-bridge/chat', handler: handleChat }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/zotero-bridge/status', handler: handleStatus }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/zotero-bridge/debug', handler: handleDebug }))

  // Publish the current endpoint so Zotero-side integrations can discover it
  // without hardcoding the (per-launch random) port.
  ctx.effect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      try {
        const origin = ctx.webServer.getOrigin()
        void mkdir(join(homedir(), '.dsh'), { recursive: true })
          .then(() => writeFile(ENDPOINT_FILE, JSON.stringify({
            origin,
            openUrl: openUrl(),
            chat: `${origin}/zotero-bridge/chat`,
            status: `${origin}/zotero-bridge/status`,
            health: `${origin}/zotero-bridge/health`,
            updatedAt: new Date().toISOString(),
          }, null, 2)))
          .catch(() => {})
      } catch { /* origin not ready yet */ }
    }, 1000)
    return () => { cancelled = true; clearTimeout(timer) }
  })

  // A direct tool so the agent itself can inspect/route the bridge.
  ctx.effect(() => ctx.tools.register({
    name: 'zotero_bridge_status',
    description:
      'Check the Zotero bridge status: whether Zotero is reachable, the database path, '
      + 'and which DSH session receives chat messages sent from Zotero.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: PLAIN_TEXT,
    async execute() {
      const running = await zotero.getSelectedItems().then(() => true).catch(() => false)
      const origin = (() => { try { return ctx.webServer.getOrigin() } catch { return null } })()
      return [
        `Zotero connector reachable: ${running}`,
        `Zotero database: ${zotero.dbPath}`,
        `Bridge sessions: ${itemSessions.size} (one per item)`,
        origin ? `Bridge endpoint: POST ${origin}/zotero-bridge/chat` : 'Bridge endpoint: (web server origin unavailable)',
      ].join('\n')
    },
    isConcurrencySafe: () => true,
  }))
}
