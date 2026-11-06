/* DSH Bridge — Zotero 10 bootstrap plugin.
 *
 * Press F12 or click the DSH toolbar button to send the selected library
 * item to the local DeepSeek Harness via the @local/zotero-bridge HTTP
 * endpoint. The endpoint is read from ~/.dsh/zotero-bridge.json, which the
 * DSH plugin rewrites on every launch (the DSH web port changes per run).
 *
 * Zotero 10 notes:
 *  - The plugin sandbox exposes Services, Zotero, IOUtils, PathUtils, but
 *    NOT Ci/Cc/Components/FileUtils. Use Zotero.File.pathToFile() to build
 *    nsIFile objects, and Zotero.File.getContents/putContents for IO.
 *  - ChromeUtils.import() is removed; nothing here depends on it.
 */

var DSH_BRIDGE = {
  endpoint: null,
  origin: null,
  openUrl: null,
  statusUrl: null,
  uiOpened: false,      // only open the DSH UI once per Zotero session
  notifierID: null,
  logPath: '~/.dsh/zotero-bridge-plugin.log',
  // DeepSeek Harness app icon (20px) embedded as a data URI for the toolbar button.
  ICON_DATA_URI: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAEWElEQVR4nJ1VW2xURRj+Zs45W7al7W4r2JZ4KS1gSkHUBxWID4QWWjCIIKGABUUeADHRSAJGTbxEsZJowIQQUTBVGxJqfOCmNT6Y2lhpGxMsmgAbS1u20C7sbnf33Oc3M6e2Xt78czJzZuY/33/75j+MiDhjTCSTyWg4HK5jjEV9HwB8Jkchh3+8BMI5SNM0ENFt0zQ7IpHIbYmlDnO53BLP82L0P8V1vZjEkFgslUqVhsPhi4ZhlLuu60njjEnDAEkNYmAgOQFEE3uBlwTIXTEtL6RbthN3bGuBbhhG/QSYzxjTlaIEoyBGCSEEgTMOxmVEpKwxJg0p4aZl++FpeeWe69TrRFQyZRMQQkDjHJoRwr9FBhCcabAdByQCcE1TqSOAl0iPZAmCAgiBUCgE13Xxe/9vMC1LrX/s6saMGXdg7ROrcf36CL77/gc807xx0pBl2XJinHNfnwIj5OWFcKGnD2+98z5isT/Unq7ruDk6hud37VDeZbNZvHfwEIaGrmPtmkZ0X+jD6FgC+17eA993g5xJkWCXL1/B9h27kB7PIBqNgGQ5BGFWRRnaTrajoCAfL76wE/cvrMGJ1ja0f30aIzdu4sDbrykMz/MwCSjl0xOtMAwDc6pnY3BwGIII+fn5StHQNRxo+RAkBN58fR+2bt+NO2fOxN6XdmPDujUTTuVB9wMWI2eauBqL4fgnRzCrogK9fb+g9Ys2/NTdAyMUQtXsSmzZvAFHj51AZ1c3bNvGc89uxuOrVsK2nUmnuCcCevi+QCqVVt6Ulpagvm4Zjh87gq3Nm+BYFuLxOB56YBFa3n0D3T/3qMrec/ddqpB/Iwm4vFKSd4XTC1CQn4+zZ8+rg0wmA845Xt2/Fw0NdYjHR9By8AN0dnYp3eqqSsybW61oI/UmZfRWcqftqhvkHf/sc5o7r5YGrg2qjUQiQY7jUDo9TkseW073Vs2nOfctooUPLqZz33QoHcuypY4n37PZ7E4u/CDk1HgO69evQ23tfDQ1bcHAwCAIHM3bduDKlav4+OhHKCubCduxsaJuGVbWL1d81QJST4Xs+0S+ILhewO9Dhw+hrLwcDY2rsW//K+jt68WTT23EufPfYlXjCiyYX4Nf+/vRdvKU4qiYqMGEELs2NLo7WlJy2DSzMpuaLL3My1ftp3Dm9BlYtq0+LC4uxratT2Pxo49gLDGm8l1YWKh0icg3DIPncrk97NrwzaaiSPTLbCbj67pqcJB9rqioAL4nkMmMq3W0eHpwzWwHIcNQTUNyEqqZKEDNNM1N7NLQUGmxXnAxEo2UJ5NJjzF5JZnMMXTOoeua6iwyNM6gcibXnKtuwzhnIhQK6a7rxk3TXKAsDAzfWHorbcWSGYeSWZdSWY/SOZ8ypk9ZS5DpEEkmuD6RJ4jEfxqsG0un00tVh/jrF9DV1VVSWV1T75OIyupBgIEDmhyCB1yTn2iQheUaJ0Pn0Bi7fWlwsOPhmpqExPoThzGRWsy9f3AAAAAASUVORK5CYII=',

  log(msg) {
    try { Zotero.debug('[DSH Bridge] ' + msg) } catch (e) {}
    try {
      const home = Services.env.get('HOME') || Services.dirsvc.get('Home', Ci.nsIFile).path
      this.logPath = home + '/.dsh/zotero-bridge-plugin.log'
      let old = ''
      try { old = Zotero.File.getContents(this.logPath) } catch (e) { old = '' }
      if (old && !old.endsWith('\n')) old += '\n'
      const file = Zotero.File.pathToFile(this.logPath)
      Zotero.File.putContents(file, old + new Date().toISOString() + ' ' + msg + '\n')
    } catch (e) {}
  },

  loadEndpoint() {
    try {
      const home = Services.env.get('HOME') || Services.dirsvc.get('Home', Ci.nsIFile).path
      const path = home + '/.dsh/zotero-bridge.json'
      const text = Zotero.File.getContents(path)
      if (!text) return null
      const data = JSON.parse(text)
      this.origin = data.origin || null
      this.openUrl = data.openUrl || data.origin || null
      this.statusUrl = data.status || (data.origin ? data.origin + '/zotero-bridge/status' : null)
      return data.chat || (data.origin ? data.origin + '/zotero-bridge/chat' : null)
    } catch (e) {
      this.log('endpoint discovery failed: ' + e)
      return null
    }
  },

  openDSH(win) {
    if (!this.openUrl) this.loadEndpoint()
    const url = this.openUrl
    if (!url) {
      this.notify(win, 'DSH Bridge', '找不到 DSH 页面地址，请先启动 DeepSeek Harness。')
      return
    }
    // Open the DSH UI only once per Zotero session; subsequent clicks reuse
    // the already-open window instead of spawning new ones.
    if (this.uiOpened) return
    try {
      Zotero.launchURL(url)
      this.uiOpened = true
    } catch (e) {
      try {
        const uri = Services.io.newURI(url)
        Zotero.launchURL(uri.spec)
        this.uiOpened = true
      } catch (e2) {
        this.notify(win, 'DSH Bridge', '打开页面失败：' + e2)
      }
    }
  },

  notify(win, title, body) {
    try {
      const pw = new Zotero.ProgressWindow({ closeOnClick: true })
      pw.changeHeadline(title)
      pw.addDescription(body)
      pw.show()
      pw.startCloseTimer(4500)
    } catch (e) {
      try { win.alert(title + '\n\n' + body) } catch (e2) {}
    }
  },

  async postJSON(url, payload) {
    const response = await Zotero.HTTP.request('POST', url, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 20000,
    })
    const text = response.responseText || ''
    let body = {}
    try { body = JSON.parse(text) } catch (e) {}
    return { ok: response.status >= 200 && response.status < 300, status: response.status, body }
  },

  async getJSON(url) {
    const response = await Zotero.HTTP.request('GET', url, { timeout: 15000 })
    const text = response.responseText || ''
    let body = {}
    try { body = JSON.parse(text) } catch (e) {}
    return body
  },

  // Find or create the dedicated "阅读笔记" child note under a regular item.
  async getOrCreateNote(item) {
    const NOTE_TITLE = '阅读笔记'
    for (const noteID of item.getNotes()) {
      const note = Zotero.Items.get(noteID)
      if (note && note.getNoteTitle && note.getNoteTitle() === NOTE_TITLE) {
        return note
      }
    }
    const note = new Zotero.Item('note')
    note.libraryID = item.libraryID
    note.parentItemID = item.id
    note.setNote(NOTE_TITLE)
    await note.saveTx()
    return note
  },

  // Append a dated summary block to the note, keeping only the important
  // points rather than the full conversation.
  async appendNoteSummary(item, text) {
    if (!text || !text.trim()) return
    const note = await this.getOrCreateNote(item)
    const date = new Date().toISOString().slice(0, 10)
    const header = `\n\n## ${date}\n`
    // Keep the note bounded: trim old content if it grows too large.
    let existing = note.getNote()
    const plain = existing.replace(/<[^>]+>/g, '')
    const MAX = 20000
    if (plain.length + text.length > MAX) {
      existing = existing.slice(0, Math.floor(existing.length * 0.6))
    }
    note.setNote(existing + header + text)
    await note.saveTx()
  },

  async sendSelected(win) {
    const zp = win.ZoteroPane || Zotero.getActiveZoteroPane()
    const items = zp ? zp.getSelectedItems() : []
    if (!items.length) {
      this.openDSH(win)
      return
    }
    const item = items.find(i => i.isRegularItem && i.isRegularItem()) || items[0]
    if (!this.endpoint) this.endpoint = this.loadEndpoint()
    if (!this.endpoint) {
      this.notify(win, 'DSH Bridge',
        '找不到 DSH 端点。请确认 DeepSeek Harness 正在运行且 zotero-bridge 插件已启用。')
      return
    }
    const title = item.getDisplayTitle ? item.getDisplayTitle() : item.getField('title')
    try {
      const res = await this.postJSON(this.endpoint, {
        itemKey: item.key,
        title,
        message:
          '我在 Zotero 中选中了文献《' + title + '》（key: ' + item.key + '）。' +
          '请用 zotero_get_item 读取它的元数据、笔记和批注，然后给我一个简要解读。',
      })
      const body = res.body
      if (res.ok && body.ok) {
        this.notify(win, '已发送到 DSH ✓', '《' + title + '》\n正在生成解读并写入阅读笔记…')
        // Only open the UI once per item; afterwards reuse the existing session.
        this.openDSH(win)
        // Poll for the reply, then write it back as the reading note.
        void this.pollAndWriteNote(item)
      } else {
        this.notify(win, 'DSH Bridge 发送失败', String(body.error || ('HTTP ' + res.status)))
      }
    } catch (e) {
      this.endpoint = null
      this.notify(win, 'DSH Bridge 连接失败', '无法连接 DSH（' + e + '）。请确认 DSH 正在运行。')
    }
  },

  // Poll the item's session status until the assistant reply is complete,
  // then append it to the item's reading note.
  async pollAndWriteNote(item) {
    if (!this.statusUrl) this.loadEndpoint()
    if (!this.statusUrl) return
    const statusUrl = this.statusUrl + '?itemKey=' + encodeURIComponent(item.key)
    let last = ''
    let idle = 0
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 3000))
      try {
        const st = await this.getJSON(statusUrl)
        if (st.reply && st.reply !== last) {
          last = st.reply
          idle = 0
        } else {
          idle++
        }
        if (st.reply && !st.running && idle >= 2) {
          await this.appendNoteSummary(item, st.reply)
          this.log('note written for ' + item.key)
          return
        }
      } catch (e) {
        idle++
      }
      if (idle >= 10) return
    }
  },

  onKey(event) {
    if (event.key !== 'F12') return
    event.preventDefault()
    event.stopPropagation()
    const win = event.view || event.target.ownerGlobal
    void DSH_BRIDGE.sendSelected(win)
  },

  installWindow(win) {
    win.removeEventListener('keydown', this.onKey, true)
    win.addEventListener('keydown', this.onKey, true)
    this.addMenuItem(win)
    this.addToolbarButton(win)
  },

  uninstallWindow(win) {
    win.removeEventListener('keydown', this.onKey, true)
    win.document.getElementById('dsh-bridge-menuitem')?.remove()
    win.document.getElementById('dsh-bridge-toolbar-button')?.remove()
  },

  addToolbarButton(win) {
    try {
      const doc = win.document
      if (doc.getElementById('dsh-bridge-toolbar-button')) return
      const candidates = [
        'zotero-items-toolbar',
        'zotero-toolbar',
        'zotero-tb-advanced-search',
        'toolbar',
      ]
      const toolbar = candidates.map(id => doc.getElementById(id)).find(Boolean)
        || doc.querySelector('toolbar')
      if (!toolbar) {
        this.log('toolbar not found; Tools menu remains available')
        return
      }
      const button = doc.createXULElement('toolbarbutton')
      button.id = 'dsh-bridge-toolbar-button'
      button.className = 'toolbarbutton-1'
      button.setAttribute('label', '')
      button.setAttribute('tooltiptext', '发送选中文献到 DeepSeek Harness 并打开会话（F12）')
      // Icon-only button using the DeepSeek Harness whale icon. Use a CSS
      // background-image (data URI works there) so no chrome registration is
      // required and no text label renders.
      button.style.cssText = [
        'list-style-image: url(' + DSH_BRIDGE.ICON_DATA_URI + ')',
        '-moz-image-region: auto',
        'width: 20px',
        'height: 20px',
        'padding: 1px',
      ].join(';')
      button.addEventListener('command', () => void this.sendSelected(win))
      toolbar.appendChild(button)
      this.log('toolbar button installed in ' + toolbar.id)
    } catch (e) {
      this.log('toolbar button failed: ' + e)
    }
  },

  addMenuItem(win) {
    try {
      const doc = win.document
      const popup = doc.getElementById('menu_ToolsPopup')
      if (!popup || doc.getElementById('dsh-bridge-menuitem')) return
      const item = doc.createXULElement('menuitem')
      item.id = 'dsh-bridge-menuitem'
      item.setAttribute('label', '发送选中条目到 DSH')
      item.setAttribute('acceltext', 'F12')
      item.addEventListener('command', () => void this.sendSelected(win))
      popup.appendChild(item)
    } catch (e) {
      this.log('menuitem failed: ' + e)
    }
  },

  // Generate an initial reading note for a newly imported item without
  // opening the UI. Used by the item-added observer.
  async generateNoteForItem(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) return
    // Only auto-generate once per item: skip if a reading note already exists.
    const existing = item.getNotes().map(id => Zotero.Items.get(id))
      .filter(n => n && n.getNoteTitle && n.getNoteTitle() === '阅读笔记')
    if (existing.length) return
    if (!this.endpoint) this.endpoint = this.loadEndpoint()
    if (!this.endpoint) return
    const title = item.getDisplayTitle ? item.getDisplayTitle() : item.getField('title')
    try {
      const res = await this.postJSON(this.endpoint, {
        itemKey: item.key,
        title,
        message:
          '我刚在 Zotero 中导入了文献《' + title + '》（key: ' + item.key + '）。' +
          '请用 zotero_get_item 读取它的元数据、摘要和 PDF（如可读取），' +
          '参考库中同类文献的阅读笔记风格，为它生成一份初步阅读笔记，' +
          '要求：分"研究问题/方法/主要结论/我的思考"几个部分，使用客观的学术语言，' +
          '不出现任何"AI 生成""辅助生成"等字样，并在开头标注入库时间。',
      })
      if (res.ok && res.body.ok) {
        this.log('note generation requested for ' + item.key)
        void this.pollAndWriteNote(item)
      }
    } catch (e) {
      this.log('generateNoteForItem failed: ' + e)
    }
  },

  // Observe item-added events and auto-generate a reading note for new
  // regular items (papers, books, etc.).
  registerNotifier() {
    if (this.notifierID) return
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event, type, ids) => {
          if (event !== 'add') return
          for (const id of ids) {
            try {
              const item = Zotero.Items.get(id)
              if (item && item.isRegularItem && item.isRegularItem()) {
                void this.generateNoteForItem(item)
              }
            } catch (e) {}
          }
        },
      },
      ['item'],
    )
    this.log('notifier registered')
  },

  unregisterNotifier() {
    if (this.notifierID) {
      try { Zotero.Notifier.unregisterObserver(this.notifierID) } catch (e) {}
      this.notifierID = null
    }
  },
}

function install(data, reason) { DSH_BRIDGE.log('install reason=' + reason) }

async function startup({ id, version, rootURI }, reason) {
  DSH_BRIDGE.log('startup begin reason=' + reason)
  try {
    await Zotero.initializationPromise
    DSH_BRIDGE.endpoint = DSH_BRIDGE.loadEndpoint()
    DSH_BRIDGE.log('startup, endpoint=' + DSH_BRIDGE.endpoint)

    for (const win of Zotero.getMainWindows()) {
      DSH_BRIDGE.installWindow(win)
    }
    DSH_BRIDGE.registerNotifier()
    DSH_BRIDGE.log('startup complete, windows=' + Zotero.getMainWindows().length)
  } catch (e) {
    DSH_BRIDGE.log('startup FAILED: ' + e + '\n' + (e && e.stack))
    throw e
  }
}

function onMainWindowLoad({ window }) {
  DSH_BRIDGE.log('onMainWindowLoad')
  DSH_BRIDGE.installWindow(window)
}

function onMainWindowUnload({ window }) {
  DSH_BRIDGE.uninstallWindow(window)
}

function shutdown(data, reason) {
  DSH_BRIDGE.log('shutdown reason=' + reason)
  if (reason === APP_SHUTDOWN) return
  DSH_BRIDGE.unregisterNotifier()
  for (const win of Zotero.getMainWindows()) {
    DSH_BRIDGE.uninstallWindow(win)
  }
}

function uninstall(data, reason) {}
