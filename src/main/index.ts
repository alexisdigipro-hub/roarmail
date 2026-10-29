// RoarMail's main process: the window, the mail engine and the IPC door the screens use.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, shell, systemPreferences, Tray } from 'electron'
import fs from 'fs'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import os from 'os'
import path from 'path'
import { openStore } from './store'
import { MailService } from './mail'
import { autodetect } from './autodetect'
import { readCsv, readVcf } from './contacts'
import { RoarMe } from './roarme'
import type { LockState, MailEvent, MessageRow, NewMailSound, RoarTransferFile } from '../shared/api'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const updater = require('./updater.js')

if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | null = null
let quitting = false
let pendingMailto: string | null = null
let pendingLink: string | null = null
let openLink: (url: string) => void = (url) => { pendingLink = url }
let shownOnce = false
let locked = false
let tray: Tray | null = null
let background = false // keep running in the menu bar / tray when the window closes

// App lock (Touch ID on a Mac). While locked the main process answers nothing but these, so a locked
// window cannot read mail even through its developer tools.
const OPEN_WHEN_LOCKED = new Set(['mail:platform', 'mail:lockState', 'mail:unlock'])
const lockAvailable = () => process.platform === 'darwin' && systemPreferences.canPromptTouchID()
function handle(channel: string, fn: (e: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) {
  ipcMain.handle(channel, (e, ...args) => {
    if (locked && !OPEN_WHEN_LOCKED.has(channel)) throw new Error('locked')
    return fn(e, ...args)
  })
}

const emit = (e: MailEvent) => { win?.webContents.send('mail:event', e) }

function show() {
  // the Dock or a second launch can ask before Electron is ready ("Cannot create BrowserWindow before app is
  // ready", 0.19.5): then the window that whenReady opens is the answer
  if (!app.isReady()) return
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show(); win.focus()
}

// the window opens where and as big as it was left (Alex, 29 Oct: "keep the size I made it, every time"), kept in
// window.json in the app's data folder; a place no longer on any screen falls back to the screen's middle
const WIN_FILE = () => path.join(app.getPath('userData'), 'window.json')
function savedBounds(): { x?: number; y?: number; width: number; height: number; maximized?: boolean } {
  const fallback = { width: 1360, height: 860 }
  try {
    const b = JSON.parse(fs.readFileSync(WIN_FILE(), 'utf8'))
    if (!(b.width >= 900 && b.height >= 560)) return fallback
    const { screen } = require('electron')
    const onScreen = typeof b.x === 'number' && screen.getAllDisplays().some((d: Electron.Display) => {
      const a = d.workArea
      return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 20 && b.y < a.y + a.height - 60
    })
    return onScreen ? b : { width: b.width, height: b.height, maximized: b.maximized }
  } catch { return fallback }
}
function keepBounds(w: BrowserWindow) {
  let t: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    clearTimeout(t)
    t = setTimeout(() => {
      if (w.isDestroyed() || w.isFullScreen() || w.isMinimized()) return
      const maximized = w.isMaximized()
      const b = maximized ? w.getNormalBounds() : w.getBounds()
      try { fs.writeFileSync(WIN_FILE(), JSON.stringify({ ...b, maximized })) } catch { /* the next move tries again */ }
    }, 400)
  }
  w.on('resize', save); w.on('move', save); w.on('maximize', save); w.on('unmaximize', save); w.on('close', save)
}

function createWindow() {
  const mac = process.platform === 'darwin'
  const { maximized: keptMax, ...kept } = savedBounds()
  win = new BrowserWindow({
    ...kept, minWidth: 900, minHeight: 560, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1e23' : '#eceef1',
    title: 'RoarMail',
    ...(mac
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 20, y: 13 } } // in the 40px strip above the columns (styles.css, --mac-top)
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: nativeTheme.shouldUseDarkColors ? { color: '#1b1e23', symbolColor: '#eef0f3', height: 40 } : { color: '#eceef1', symbolColor: '#1b1f25', height: 40 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true,
    },
  })
  if (keptMax) win.maximize()
  keepBounds(win)
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  // opened at login: stay in the menu bar until asked
  // (a Mac login item gets no arguments: a start in the first two minutes after the computer starts counts as one)
  const hidden = process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().openAtLogin && os.uptime() < 120)
  win.once('ready-to-show', () => { if (!hidden || shownOnce) win?.show(); shownOnce = true })
  // nothing ever navigates the app window; links go to the system browser
  win.webContents.setWindowOpenHandler(({ url }) => { openSafe(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); openSafe(url) } })
  editMenu(win)
  win.on('close', (e) => { if ((process.platform === 'darwin' || background) && !quitting) { e.preventDefault(); win?.hide() } })
  win.on('closed', () => { win = null })
  // full screen hides the Mac buttons, so the page drops the strip they sit in
  const fullscreen = (on: boolean) => win?.webContents.executeJavaScript(`document.documentElement.classList.toggle('fullscreen', ${on})`).catch(() => {})
  win.on('enter-full-screen', () => fullscreen(true))
  win.on('leave-full-screen', () => fullscreen(false))
  win.webContents.on('did-finish-load', () => {
    if (pendingMailto) { emit(mailtoEvent(pendingMailto)); pendingMailto = null }
  })
}

function openSafe(url: string) {
  if (/^roarmail:/i.test(url)) openLink(url)
  else if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url, { activate: !linksInBackground() })
  else if (/^tel:[\d+]+$/i.test(url)) shell.openExternal(url)
}
// Settings > General > Open links in the background (Mac): set once the settings are read
let linksInBackground = () => false

function mailtoEvent(url: string): MailEvent {
  const u = new URL(url)
  return { type: 'compose', to: decodeURIComponent(u.pathname), subject: u.searchParams.get('subject') || undefined, body: u.searchParams.get('body') || undefined }
}

function handleMailto(url: string) {
  if (!url?.toLowerCase().startsWith('mailto:')) return
  if (win && !win.webContents.isLoading()) { emit(mailtoEvent(url)); show() } else pendingMailto = url
}

// roarmail://message/<id>?mid=<Message-ID> (Oct 2026): a RoarMe task made from an email links back to it
const isLink = (a: string) => /^roarmail:/i.test(a)
app.on('open-url', (e, url) => { e.preventDefault(); if (isLink(url)) openLink(url); else handleMailto(url) })
app.on('second-instance', (_e, argv) => {
  const m = argv.find((a) => a.startsWith('mailto:'))
  if (m) handleMailto(m)
  const l = argv.find(isLink)
  if (l) openLink(l)
  show()
})
if (process.defaultApp) { if (process.argv.length >= 2) app.setAsDefaultProtocolClient('roarmail', process.execPath, [path.resolve(process.argv[1])]) }
else app.setAsDefaultProtocolClient('roarmail')
app.on('activate', () => show())
app.on('before-quit', () => { quitting = true })

app.whenReady().then(() => {
  app.setName('RoarMail')
  const startMailto = process.argv.find((a) => a.toLowerCase().startsWith('mailto:'))
  if (startMailto) pendingMailto = startMailto
  const startLink = process.argv.find(isLink)
  if (startLink) pendingLink = startLink
  const db = openStore()

  // the email a roarmail:// link names: by RoarMail's own id on this computer, else by its Message-ID (another computer)
  openLink = (url: string) => {
    let u: URL
    try { u = new URL(url) } catch { return }
    if (u.protocol !== 'roarmail:' || u.hostname !== 'message') return
    const id = decodeURIComponent(u.pathname.replace(/^\//, ''))
    const mid = u.searchParams.get('mid') || ''
    const row = (db.prepare('select id, thread_id, subject from messages where id = ?').get(id)
      || (mid ? db.prepare('select id, thread_id, subject from messages where message_id = ? order by date desc limit 1').get(mid) : undefined)) as { id: string; thread_id: string | null; subject: string } | undefined
    show()
    if (!row) return
    // it may be in any folder: the screen finds it by its subject
    const ev: MailEvent = { type: 'open', messageId: row.thread_id || row.id, subject: row.subject || '' }
    if (win && !win.webContents.isLoading()) emit(ev)
    else win?.webContents.once('did-finish-load', () => setTimeout(() => emit(ev), 300))
  }

  // Settings > General: who notifies, and which sound plays (RoarMail's own sounds play in the window, even when it is in front)
  const known = db.prepare('select 1 from contacts where email = ? and use_count > 0')
  // Settings > General > Reply in notifications (Mac): the answer goes out like any reply, through the outbox
  const quickReply = async (id: string, text: string) => {
    try {
      const m = await mail.message(id)
      const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
      mail.send({
        accountId: m.accountId, to: m.replyTo || (m.fromName ? `${m.fromName.replace(/[",]/g, '')} <${m.fromEmail}>` : m.fromEmail),
        subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`, html: esc.replace(/\n/g, '<br>'), text,
        inReplyTo: m.messageId, references: [m.references, m.messageId].filter(Boolean).join(' ') || undefined, replyToMessageId: m.id,
      })
    } catch { /* the message is gone: nothing to answer */ }
  }
  const notify = (accountId: string, all: MessageRow[]) => {
    const s = mail.settings()
    const rows = s.notifyFor === 'none' ? [] : s.notifyFor === 'known' ? all.filter((r) => known.get(r.fromEmail.toLowerCase())) : all
    if (!rows.length) return
    const own = s.newMailSound !== 'system' && s.newMailSound !== 'none'
    if (own) emit({ type: 'sound', sound: s.newMailSound as NewMailSound })
    if (!Notification.isSupported() || win?.isFocused()) return
    const silent = s.newMailSound !== 'system'
    const list = rows.slice(0, 3)
    for (const r of list) {
      const n = locked
        ? new Notification({ title: 'RoarMail', body: '✉︎', silent })
        : new Notification({ title: r.fromName || r.fromEmail, body: r.subject || '(no subject)', silent, hasReply: s.notifyReply && process.platform === 'darwin' })
      n.on('reply', (_e, text) => { if (text.trim()) quickReply(r.id, text) })
      n.on('click', () => { show(); emit({ type: 'open', messageId: r.threadId || r.id }) })
      n.show()
    }
    if (rows.length > list.length) new Notification({ title: 'RoarMail', body: `+${rows.length - list.length}`, silent: true }).show()
  }

  const mail = new MailService(db, emit, notify)
  menuLanguage = () => mail.settings().language

  // Settings > General > Appearance: the whole app (and the system's own controls) follow it
  const applyAppearance = (v: string) => {
    nativeTheme.themeSource = v === 'dark' || v === 'light' ? v : 'system'
    if (process.platform === 'win32') {
      const dark = nativeTheme.shouldUseDarkColors
      win?.setTitleBarOverlay?.({ color: dark ? '#1b1e23' : '#eceef1', symbolColor: dark ? '#eef0f3' : '#1b1f25', height: 40 })
    }
  }
  applyAppearance(mail.settings().appearance)

  // snoozes coming back and reminders: a notification that opens the app
  mail.alert = (title, body) => {
    if (!Notification.isSupported()) return
    const n = locked ? new Notification({ title: 'RoarMail', body: '⏰' }) : new Notification({ title, body })
    n.on('click', () => show())
    n.show()
  }

  // start with the computer, waiting in the menu bar (tray on Windows), so scheduled things happen on time
  const applyLogin = (on: boolean) => {
    background = on
    try { app.setLoginItemSettings({ openAtLogin: on, args: on ? ['--hidden'] : [] }) } catch { /* not allowed here */ }
    if (on) makeTray(); else if (process.platform !== 'darwin') { tray?.destroy(); tray = null }
  }
  const makeTray = () => {
    if (tray) return
    const img = process.platform === 'darwin'
      ? nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'trayTemplate.png'))
      : nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 16, height: 16 })
    if (process.platform === 'darwin') img.setTemplateImage(true)
    tray = new Tray(img)
    tray.setToolTip('RoarMail')
    const menu = () => Menu.buildFromTemplate([
      { label: 'RoarMail', click: () => show() },
      { label: 'New Message', click: () => { show(); emit({ type: 'compose', to: '' }) } },
      { label: 'Check Mail', click: () => mail.refresh().catch(() => {}) },
      { type: 'separator' },
      { label: 'Quit RoarMail', click: () => { quitting = true; app.quit() } },
    ])
    tray.setContextMenu(menu())
    if (process.platform === 'win32') tray.on('click', () => show())
  }
  // the unread count next to the envelope in the menu bar
  setInterval(() => {
    if (!tray || process.platform !== 'darwin') return
    const n = app.getBadgeCount()
    tray.setTitle(n ? ` ${n}` : '')
  }, 5e3)
  applyLogin(mail.settings().runAtLogin)
  linksInBackground = () => process.platform === 'darwin' && mail.settings().linksInBackground

  // Settings > General (Mac): in the Dock and the menu bar, only the Dock, or only the menu bar
  const applyDock = (mode: string) => {
    if (process.platform !== 'darwin') return
    if (mode === 'menubar') { makeTray(); app.dock?.hide() } else { app.dock?.show(); if (mode === 'dock' && !background) { tray?.destroy(); tray = null } else makeTray() }
  }
  applyDock(mail.settings().dockMode)

  handle('mail:platform', () => process.platform)
  handle('mail:autodetect', (_e, email: string) => autodetect(email))
  handle('mail:testAccount', (_e, cfg, pass) => mail.test(cfg, pass))
  handle('mail:addAccount', (_e, cfg, pass) => mail.add(cfg, pass))
  handle('mail:addMicrosoft', (_e, cfg) => mail.addMicrosoft(cfg))
  handle('mail:removeAccount', (_e, id) => mail.remove(id))
  handle('mail:accounts', () => mail.accounts())
  handle('mail:folders', (_e, id) => mail.folders(id))
  handle('mail:messages', async (_e, scope, before) => {
    if (scope.folderId && before == null) mail.openFolder(scope.folderId).catch(() => {})
    return mail.list(scope, before)
  })
  handle('mail:message', (_e, id) => mail.message(id))
  handle('mail:search', (_e, q, a) => mail.search(q, a))
  handle('mail:searchOnline', (_e, q, a) => mail.searchOnline(q, a))
  handle('mail:resetSettings', () => { mail.resetSettings(); const s = mail.settings(); applyAppearance(s.appearance); applyLogin(s.runAtLogin); applyDock(s.dockMode) })
  handle('mail:clearCache', () => mail.clearCache())
  handle('mail:contacts', (_e, q) => mail.contacts(q))
  handle('mail:thread', (_e, key) => mail.thread(key))
  handle('mail:act', (_e, ids, action, target) => mail.act(ids, action, target))
  handle('mail:undo', (_e, token) => mail.undo(token))
  handle('mail:allowImages', (_e, s) => mail.allowImages(s))
  handle('mail:send', (_e, d, opts) => mail.send(d, opts))
  handle('mail:cancelSend', (_e, id) => mail.cancelSend(id))
  handle('mail:retrySend', (_e, id) => mail.retrySend(id))
  handle('mail:outbox', () => mail.outbox())
  handle('mail:saveDraft', (_e, d, toServer) => mail.saveDraft(d, toServer))
  handle('mail:discardDraft', (_e, id) => mail.discardDraft(id))
  handle('mail:draftFromMessage', (_e, id) => mail.draftFromMessage(id))
  handle('mail:updateAccount', (_e, id, patch) => mail.updateAccount(id, patch))
  handle('mail:allAccounts', () => mail.allAccounts())
  handle('mail:updateServer', (_e, id, cfg, pass) => mail.updateServer(id, cfg, pass || undefined))
  handle('mail:addAlias', (_e, id, email, name) => mail.addAlias(id, email, name))
  handle('mail:removeAlias', (_e, id) => mail.removeAlias(id))
  handle('mail:serverFolders', (_e, id) => mail.serverFolders(id))
  handle('mail:unifiedFolders', () => mail.unifiedFolders())
  // a folder's right-click menu: the Mac's own menu, built here; the window does what was picked
  handle('mail:folderMenu', (_e, folderId: string, l: Record<string, string>) => new Promise((resolve) => {
    const f = mail.folders(String(mail.folderAccount(folderId))).find((x) => x.id === folderId)
    if (!f || !win) return resolve(null)
    let picked: string | null = null
    const pick = (v: string) => () => { picked = v }
    const fixed = !!f.role
    const colours: [string, string][] = [['#ff453a', l.red], ['#ff9f0a', l.orange], ['#ffd60a', l.yellow], ['#30d158', l.green], ['#0a84ff', l.blue], ['#bf5af2', l.purple]]
    Menu.buildFromTemplate([
      { label: l.new, click: pick('new') },
      { label: l.sub, click: pick('sub') },
      { label: l.rename, enabled: !fixed, click: pick('rename') },
      { type: 'separator' },
      ...colours.map(([hex, label]) => ({ label, type: 'checkbox' as const, checked: f.color === hex, click: pick(`c:${hex}`) })),
      { label: l.custom, click: pick('custom') },
      ...(f.color ? [{ label: l.nocolor, click: pick('nocolor') }] : []),
      { type: 'separator' },
      { label: l.hide, enabled: f.role !== 'inbox', click: pick('hide') },
      { type: 'separator' },
      { label: l.read, enabled: f.unread > 0, click: pick('read') },
      ...(f.role === 'trash' || f.role === 'spam' ? [{ label: l.empty, enabled: f.total > 0, click: pick('empty') }] : []),
      { type: 'separator' },
      { label: l.sync, click: pick('sync') },
      { label: l.rules, click: pick('rules') },
      { type: 'separator' },
      { label: l.delete, enabled: !fixed, click: pick('delete') },
    ]).popup({ window: win, callback: () => setTimeout(() => resolve(picked), 0) })
  }))
  handle('mail:popMenu', (_e, items: ({ id: string; label: string; enabled?: boolean } | null)[]) => new Promise((resolve) => {
    if (!win) return resolve(null)
    let picked: string | null = null
    Menu.buildFromTemplate(items.map((x) => x ? { label: String(x.label), enabled: x.enabled !== false, click: () => { picked = String(x.id) } } : { type: 'separator' as const }))
      .popup({ window: win, callback: () => setTimeout(() => resolve(picked), 0) })
  }))
  handle('mail:createFolder', (_e, accountId, parentId, name) => mail.createFolder(accountId, parentId, name))
  handle('mail:renameFolder', (_e, id, name) => mail.renameFolder(id, name))
  handle('mail:deleteFolder', (_e, id) => mail.deleteFolder(id))
  handle('mail:setFolderColor', (_e, id, color) => mail.setFolderColor(id, color))
  handle('mail:hideFolder', (_e, id, hidden) => mail.hideFolder(id, !!hidden))
  handle('mail:hiddenFolders', (_e, accountId) => mail.folders(accountId, true))
  handle('mail:markFolderRead', (_e, id) => mail.markFolderRead(id))
  handle('mail:stats', (_e, accountId) => mail.stats(String(accountId || 'all')))
  handle('mail:emptyFolder', (_e, target) => mail.emptyFolder(target || {}))
  handle('mail:syncFolderAll', (_e, id) => mail.syncFolderAll(id))
  handle('mail:syncEverything', (_e, accountId) => mail.syncEverything(String(accountId || 'all')))
  handle('mail:senderIcons', (_e, emails: string[]) => mail.senderIcons(Array.isArray(emails) ? emails : []))
  handle('mail:emojiPanel', () => { if (app.isEmojiPanelSupported()) app.showEmojiPanel() })
  // Settings > Accounts > Picture: any image, cut to the middle square and made small (160 px) before it is kept
  handle('mail:pickAvatar', async (_e, id: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'heic', 'gif', 'webp', 'tiff'] }] })
    if (r.canceled || !r.filePaths[0]) return false
    let img = nativeImage.createFromPath(r.filePaths[0])
    if (img.isEmpty()) img = await nativeImage.createThumbnailFromPath(r.filePaths[0], { width: 480, height: 480 }).catch(() => nativeImage.createEmpty())
    if (img.isEmpty()) throw new Error('not-an-image')
    const { width, height } = img.getSize()
    const side = Math.min(width, height)
    const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side })
    mail.setAvatar(id, square.resize({ width: 160, height: 160, quality: 'best' }).toDataURL())
    return true
  })
  // the crop window (Alex, 29 Oct: "crop and move where we upload pictures"): the file comes back whole, the page
  // frames it, and what it sends is drawn again here as a 160 px square, so only a real small picture is kept
  handle('mail:pickImage', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'heic', 'gif', 'webp', 'tiff'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    let img = nativeImage.createFromPath(r.filePaths[0])
    if (img.isEmpty()) img = await nativeImage.createThumbnailFromPath(r.filePaths[0], { width: 1200, height: 1200 }).catch(() => nativeImage.createEmpty())
    if (img.isEmpty()) throw new Error('not-an-image')
    const { width, height } = img.getSize()
    const k = Math.min(1, 1200 / Math.max(width, height))
    return (k < 1 ? img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' }) : img).toDataURL()
  })
  handle('mail:setAvatar', (_e, id: string, dataUrl: string) => {
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(dataUrl) || dataUrl.length > 4e6) throw new Error('not-an-image')
    const img = nativeImage.createFromDataURL(dataUrl)
    if (img.isEmpty()) throw new Error('not-an-image')
    mail.setAvatar(String(id), img.resize({ width: 160, height: 160, quality: 'best' }).toDataURL())
  })
  // Contacts
  handle('mail:contactList', (_e, q: string, group: string) => mail.contactList(String(q || ''), String(group || '')))
  handle('mail:contactCard', (_e, email: string) => mail.contactCard(String(email)))
  handle('mail:saveContact', (_e, email: string, patch) => mail.saveContact(String(email), patch || {}))
  handle('mail:importContacts', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'Contacts', extensions: ['vcf', 'csv'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    const file = r.filePaths[0], text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return mail.importContacts(/\.csv$/i.test(file) ? readCsv(text) : readVcf(text))
  })
  // Move to another computer: the setup in one file, sealed with the person's passphrase (scrypt + AES-256-GCM), since
  // it carries the mail passwords; without the passphrase the file is noise
  const KDF = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
  handle('mail:exportSetup', async (_e, pass: string) => {
    if (typeof pass !== 'string' || pass.length < 6) throw new Error('short-pass')
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('desktop'), `RoarMail setup ${new Date().toISOString().slice(0, 10)}.roarmail`), filters: [{ name: 'RoarMail setup', extensions: ['roarmail'] }] })
    if (r.canceled || !r.filePath) return null
    const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(pass, salt, 32, KDF)
    const c = createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([c.update(JSON.stringify(mail.exportSetup()), 'utf8'), c.final()])
    fs.writeFileSync(r.filePath, JSON.stringify({ format: 'roarmail-setup-sealed', version: 1, kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }))
    return r.filePath
  })
  handle('mail:importSetup', async (_e, pass: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'RoarMail setup', extensions: ['roarmail'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    let box: any
    try { box = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')) } catch { throw new Error('not-a-setup') }
    if (box?.format !== 'roarmail-setup-sealed') throw new Error('not-a-setup')
    let json: string
    try {
      const key = scryptSync(String(pass), Buffer.from(box.salt, 'base64'), 32, KDF)
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'))
      d.setAuthTag(Buffer.from(box.tag, 'base64'))
      json = Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8')
    } catch { throw new Error('bad-pass') }
    return mail.importSetup(JSON.parse(json))
  })
  // Settings > General > Default mail app: mailto: links open RoarMail (the packaged app declares mailto, see package.json)
  handle('mail:isDefaultMail', () => app.isDefaultProtocolClient('mailto'))
  handle('mail:makeDefaultMail', () => { app.setAsDefaultProtocolClient('mailto'); return app.isDefaultProtocolClient('mailto') })
  handle('mail:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0] || null
  })
  // Settings > Rules and Settings > Templates
  handle('mail:rules', () => mail.rules())
  handle('mail:saveRule', (_e, rule) => mail.saveRule(rule))
  handle('mail:deleteRule', (_e, id) => mail.deleteRule(String(id)))
  handle('mail:orderRules', (_e, ids) => mail.orderRules(ids))
  handle('mail:runRules', (_e, folderId) => mail.runRules(String(folderId)))
  handle('mail:templates', () => mail.templates())
  handle('mail:saveTemplate', (_e, tpl) => mail.saveTemplate(tpl))
  handle('mail:deleteTemplate', (_e, id) => mail.deleteTemplate(String(id)))
  // calendar invitations: the answer goes to the organizer; Add to Calendar opens the .ics in the system's calendar app
  handle('mail:answerInvite', (_e, id, answer) => mail.answerInvite(String(id), answer))
  handle('mail:inviteToCalendar', async (_e, id) => {
    const text = await mail.calendarOf(String(id))
    if (!text) throw new Error('no-invite')
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roarmail-')), 'invite.ics')
    fs.writeFileSync(file, text)
    const err = await shell.openPath(file)
    if (err) throw new Error(err)
  })
  // Print and Save as PDF: the message as the reader shows it (the window has cleaned it and put its header on top), in
  // a hidden window of its own that runs no script and goes nowhere
  const fileName = (s: string, fallback: string) => String(s || '').replace(/[/\\:*?"<>|\r\n\t]/g, '_').trim().slice(0, 120) || fallback
  const printable = async (html: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roarmail-print-'))
    const file = path.join(dir, 'message.html')
    fs.writeFileSync(file, String(html || ''))
    const w = new BrowserWindow({ show: false, width: 820, height: 1100, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    w.webContents.on('will-navigate', (e) => e.preventDefault())
    await w.loadFile(file)
    return { w, done: () => { if (!w.isDestroyed()) w.destroy(); fs.rmSync(dir, { recursive: true, force: true }) } }
  }
  handle('mail:printMessage', async (_e, html: string) => {
    const p = await printable(html)
    try { await new Promise<void>((resolve) => p.w.webContents.print({ printBackground: true }, () => resolve())) } finally { p.done() }
  })
  handle('mail:saveMessagePdf', async (_e, html: string, name: string) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('downloads'), `${fileName(name, 'Message')}.pdf`), filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (r.canceled || !r.filePath) return null
    const p = await printable(html)
    try { fs.writeFileSync(r.filePath, await p.w.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })) } finally { p.done() }
    return r.filePath
  })
  // Save as .eml: the message exactly as the server has it
  handle('mail:saveMessageEml', async (_e, id: string) => {
    const m = await mail.rawSource(String(id))
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('downloads'), `${fileName(m.subject, 'Message')}.eml`), filters: [{ name: 'Email', extensions: ['eml'] }] })
    if (r.canceled || !r.filePath) return null
    fs.writeFileSync(r.filePath, m.source)
    return r.filePath
  })
  handle('mail:signatures', () => mail.signatures())
  handle('mail:saveSignature', (_e, sig) => mail.saveSignature(sig))
  handle('mail:deleteSignature', (_e, id) => mail.deleteSignature(id))
  handle('mail:settings', () => mail.settings())
  handle('mail:setSetting', (_e, k, v) => { mail.setSetting(k, v); if (k === 'appearance') applyAppearance(v); if (k === 'runAtLogin') applyLogin(!!v); if (k === 'dockMode') applyDock(v) })
  handle('mail:snooze', (_e, ids, until) => mail.snooze(ids, until))
  handle('mail:snoozed', () => mail.snoozed())
  handle('mail:unsnooze', (_e, id) => mail.unsnooze(id))
  handle('mail:refresh', (_e, id) => mail.refresh(id))
  handle('mail:openExternal', (_e, url) => openSafe(url))
  handle('mail:unsubscribe', (_e, id) => mail.unsubscribe(id))

  // RoarMe: the account, sharing into chats, tasks and the calendar
  const roarme = new RoarMe(() => emit({ type: 'roarme' }))
  handle('mail:roarmeStatus', () => roarme.status())
  handle('mail:roarmeSignIn', (_e, email, pass) => roarme.signIn(email, pass))
  handle('mail:roarmeVerify', (_e, code) => roarme.verify(code))
  handle('mail:roarmeSignOut', () => roarme.signOut())
  handle('mail:roarmeRooms', () => roarme.rooms())
  handle('mail:roarmeContacts', () => roarme.contacts())
  handle('mail:roarmeTask', (_e, task) => roarme.makeTask(task))
  handle('mail:roarmeTaskStatus', (_e, id, status) => roarme.setTaskStatus(id, status))
  handle('mail:roarmeWork', () => roarme.work())
  handle('mail:roarmeOpen', (_e, where) => roarme.open(where || {}))
  // big attachments as RoarTransfer links: only files the person picked in the composer (a draft's attachments)
  const transfers = new Map<string, { stopped?: boolean }>()
  handle('mail:roarmeTransfer', async (_e, file: string, days?: number) => {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('roarme-no-file')
    const stop = {}
    transfers.set(file, stop)
    let last = 0
    try {
      return await roarme.transfer(file, (p) => { const now = Date.now(); if (p === 1 || now - last > 250) { last = now; emit({ type: 'transfer', file, progress: p }) } }, stop, days === 1 ? 1 : 3)
    } finally { transfers.delete(file) }
  })
  // one link for an email's transfers (the files' tokens come back from roarmeTransfer; roartransfer-r2 checks they are the sender's)
  handle('mail:roarmeTransferBundle', (_e, files: RoarTransferFile[], opts: { title?: string; password?: string; notify?: boolean }) => {
    const list = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.token === 'string').slice(0, 200)
    if (!list.length) throw new Error('roarme-no-file')
    const o = opts && typeof opts === 'object' ? opts : {}
    return roarme.transferBundle(list, { title: String(o.title || '').slice(0, 120), password: String(o.password || '').slice(0, 100), notify: !!o.notify })
  })
  handle('mail:roarmeCancelTransfer', (_e, file: string) => { const s = transfers.get(file); if (s) s.stopped = true })
  handle('mail:fileSizes', (_e, files: string[]) => (Array.isArray(files) ? files : []).map((f) => { try { return fs.statSync(String(f)).size } catch { return -1 } }))
  handle('mail:roarmeShare', async (_e, roomId: string, messageId: string, note: string, withFiles: boolean) => {
    const m = await mail.message(messageId)
    const files = withFiles ? await Promise.all(m.attachments.map(async (a) => { const x = await mail.attachment(a.id); return { name: x.filename, type: a.mime, content: x.content } })) : []
    return roarme.share(roomId, { subject: m.subject, from: m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail, date: m.date, snippet: m.snippet || (m.text || '').slice(0, 600), messageId: m.messageId }, note || '', files)
  })
  handle('mail:blockSender', (_e, email, blocked) => mail.blockSender(email, blocked))
  handle('mail:blockedSenders', () => mail.blockedSenders())

  const lockState = (): LockState => ({ available: lockAvailable(), enabled: mail.settings().lock && lockAvailable(), locked, method: lockAvailable() ? 'touchid' : 'none' })
  const setLocked = (v: boolean) => { locked = v; emit({ type: 'lock', locked: v }) }
  const lock = () => { if (mail.settings().lock && lockAvailable() && !locked) setLocked(true) }
  handle('mail:lockState', () => lockState())
  handle('mail:lockNow', () => lock())
  handle('mail:unlock', async () => {
    if (!locked) return true
    try { await systemPreferences.promptTouchID('ξεκλειδώσει το RoarMail'); setLocked(false); return true } catch { return false }
  })
  // locked from the start, after sleep or the screen locking, and after some minutes away
  locked = mail.settings().lock && lockAvailable()
  powerMonitor.on('suspend', lock)
  powerMonitor.on('lock-screen', lock)
  setInterval(() => {
    const s = mail.settings()
    if (s.lock && s.lockAfter > 0 && powerMonitor.getSystemIdleTime() >= s.lockAfter * 60) lock()
  }, 30e3)
  handle('mail:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })
  handle('mail:openAttachment', async (_e, id) => {
    const a = await mail.attachment(id)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roarmail-'))
    const file = path.join(dir, a.filename)
    fs.writeFileSync(file, a.content)
    // Mac: shown in Quick Look over the window (29 Oct 2026), which also has a button to open it in its app
    if (process.platform === 'darwin' && win) win.previewFile(file, a.filename)
    else await shell.openPath(file)
  })
  // Settings > General > Downloads folder: saved straight there (a free name), or asked every time
  handle('mail:saveAttachment', async (_e, id) => {
    const a = await mail.attachment(id)
    const dir = mail.settings().downloadsFolder
    if (dir && fs.existsSync(dir)) {
      const ext = path.extname(a.filename), base = path.basename(a.filename, ext)
      let file = path.join(dir, a.filename)
      for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base} ${i}${ext}`)
      fs.writeFileSync(file, a.content)
      return file
    }
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('downloads'), a.filename) })
    if (r.canceled || !r.filePath) return null
    fs.writeFileSync(r.filePath, a.content)
    return r.filePath
  })

  createWindow()
  if (pendingLink) { const l = pendingLink; pendingLink = null; openLink(l) }
  mail.startAll()
  mail.badge()
  powerMonitor.on('resume', () => setTimeout(() => mail.reconnectAll(), 3e3))
  updater.start(ipcMain, () => { quitting = true })
  // Settings > Updates > Update by itself: a downloaded update installs when RoarMail is not being used
  // (window closed or in the background and nobody at the computer for two minutes), then RoarMail opens again
  setInterval(() => {
    if (!mail.settings().autoUpdate || updater.getState().status !== 'ready') return
    const away = !win || !win.isVisible() || (!win.isFocused() && powerMonitor.getSystemIdleTime() >= 120)
    if (away) updater.restart(() => { quitting = true })
  }, 60e3)

  const mac = process.platform === 'darwin'
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Message', accelerator: 'CmdOrCtrl+N', click: () => emit({ type: 'compose', to: '' }) },
        { label: 'Check Mail', accelerator: 'CmdOrCtrl+Shift+N', click: () => mail.refresh().catch(() => {}) },
        { type: 'separator' },
        mac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]))
})

/**
 * The right-click menu everywhere the page does not draw its own (Alex, 29 Oct: "right click does nothing anywhere"):
 * in a message, in the writing window and in every field. Copy for a selection, Cut / Copy / Paste and the spelling
 * fixes where one types, Open / Copy Link on a link, Copy Image on a picture. The message list, the folders and the
 * accounts have their own menus (they call preventDefault, so this one does not show there).
 */
/** the language setting, once the mail engine is there (the menu is in English until then) */
let menuLanguage: () => string = () => 'auto'
function editMenu(w: BrowserWindow) {
  w.webContents.on('context-menu', (_e, p) => {
    const set = menuLanguage()
    const el = set === 'el' || (set !== 'en' && app.getLocale().startsWith('el'))
    const L = (en: string, gr: string) => (el ? gr : en)
    const items: Electron.MenuItemConstructorOptions[] = []
    const line = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }) }
    if (p.isEditable && p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => w.webContents.replaceMisspelling(s) })
      items.push({ label: L('Add to Dictionary', 'Προσθήκη στο λεξικό'), click: () => w.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) })
      line()
    }
    if (p.linkURL && /^(https?|mailto):/i.test(p.linkURL)) {
      items.push({ label: L('Open Link', 'Άνοιγμα συνδέσμου'), click: () => openSafe(p.linkURL) })
      items.push({ label: L('Copy Link', 'Αντιγραφή συνδέσμου'), click: () => clipboard.writeText(p.linkURL.replace(/^mailto:/i, '')) })
      line()
    }
    if (p.mediaType === 'image' && p.hasImageContents) {
      items.push({ label: L('Copy Image', 'Αντιγραφή εικόνας'), click: () => w.webContents.copyImageAt(p.x, p.y) })
      line()
    }
    if (p.isEditable) {
      items.push({ role: 'undo', label: L('Undo', 'Αναίρεση'), enabled: p.editFlags.canUndo }, { role: 'redo', label: L('Redo', 'Επανάληψη'), enabled: p.editFlags.canRedo })
      line()
      items.push(
        { role: 'cut', label: L('Cut', 'Αποκοπή'), enabled: p.editFlags.canCut },
        { role: 'copy', label: L('Copy', 'Αντιγραφή'), enabled: p.editFlags.canCopy },
        { role: 'paste', label: L('Paste', 'Επικόλληση'), enabled: p.editFlags.canPaste },
        { role: 'pasteAndMatchStyle', label: L('Paste as Plain Text', 'Επικόλληση ως απλό κείμενο'), enabled: p.editFlags.canPaste },
        { role: 'selectAll', label: L('Select All', 'Επιλογή όλων'), enabled: p.editFlags.canSelectAll },
      )
    } else if (p.selectionText.trim()) {
      items.push({ role: 'copy', label: L('Copy', 'Αντιγραφή') })
      if (process.platform === 'darwin') items.push({ label: L(`Look Up “${p.selectionText.trim().slice(0, 24)}”`, `Αναζήτηση «${p.selectionText.trim().slice(0, 24)}»`), click: () => w.webContents.showDefinitionForSelection() })
      items.push({ label: L('Search with Google', 'Αναζήτηση στο Google'), click: () => openSafe(`https://www.google.com/search?q=${encodeURIComponent(p.selectionText.trim().slice(0, 200))}`) })
    } else if (!items.length) {
      items.push({ role: 'selectAll', label: L('Select All', 'Επιλογή όλων') })
    }
    if (items[items.length - 1]?.type === 'separator') items.pop()
    Menu.buildFromTemplate(items).popup({ window: w })
  })
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !background) app.quit() })
