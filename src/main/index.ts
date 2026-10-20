// RoarMail's main process: the window, the mail engine and the IPC door the screens use.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, shell, systemPreferences, Tray } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openStore } from './store'
import { MailService } from './mail'
import { autodetect } from './autodetect'
import { RoarMe } from './roarme'
import type { LockState, MailEvent, MessageRow, NewMailSound } from '../shared/api'
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
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show(); win.focus()
}

function createWindow() {
  const mac = process.platform === 'darwin'
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 560, show: false,
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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  // opened at login: stay in the menu bar until asked
  // (a Mac login item gets no arguments: a start in the first two minutes after the computer starts counts as one)
  const hidden = process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().openAtLogin && os.uptime() < 120)
  win.once('ready-to-show', () => { if (!hidden || shownOnce) win?.show(); shownOnce = true })
  // nothing ever navigates the app window; links go to the system browser
  win.webContents.setWindowOpenHandler(({ url }) => { openSafe(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); openSafe(url) } })
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
  else if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url)
}

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
        : new Notification({ title: r.fromName || r.fromEmail, body: r.subject || '(no subject)', silent })
      n.on('click', () => { show(); emit({ type: 'open', messageId: r.threadId || r.id }) })
      n.show()
    }
    if (rows.length > list.length) new Notification({ title: 'RoarMail', body: `+${rows.length - list.length}`, silent: true }).show()
  }

  const mail = new MailService(db, emit, notify)

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

  handle('mail:platform', () => process.platform)
  handle('mail:autodetect', (_e, email: string) => autodetect(email))
  handle('mail:testAccount', (_e, cfg, pass) => mail.test(cfg, pass))
  handle('mail:addAccount', (_e, cfg, pass) => mail.add(cfg, pass))
  handle('mail:removeAccount', (_e, id) => mail.remove(id))
  handle('mail:accounts', () => mail.accounts())
  handle('mail:folders', (_e, id) => mail.folders(id))
  handle('mail:messages', async (_e, scope, before) => {
    if (scope.folderId && before == null) mail.openFolder(scope.folderId).catch(() => {})
    return mail.list(scope, before)
  })
  handle('mail:message', (_e, id) => mail.message(id))
  handle('mail:search', (_e, q, a) => mail.search(q, a))
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
  // Settings > General > Default mail app: mailto: links open RoarMail (the packaged app declares mailto, see package.json)
  handle('mail:isDefaultMail', () => app.isDefaultProtocolClient('mailto'))
  handle('mail:makeDefaultMail', () => { app.setAsDefaultProtocolClient('mailto'); return app.isDefaultProtocolClient('mailto') })
  handle('mail:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0] || null
  })
  handle('mail:signatures', () => mail.signatures())
  handle('mail:saveSignature', (_e, sig) => mail.saveSignature(sig))
  handle('mail:deleteSignature', (_e, id) => mail.deleteSignature(id))
  handle('mail:settings', () => mail.settings())
  handle('mail:setSetting', (_e, k, v) => { mail.setSetting(k, v); if (k === 'appearance') applyAppearance(v); if (k === 'runAtLogin') applyLogin(!!v) })
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
  handle('mail:roarmeTransfer', async (_e, file: string) => {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('roarme-no-file')
    const stop = {}
    transfers.set(file, stop)
    let last = 0
    try {
      return await roarme.transfer(file, (p) => { const now = Date.now(); if (p === 1 || now - last > 250) { last = now; emit({ type: 'transfer', file, progress: p }) } }, stop)
    } finally { transfers.delete(file) }
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
    await shell.openPath(file)
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

app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !background) app.quit() })
