// RoarMail's main process: the window, the mail engine and the IPC door the screens use.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, powerMonitor, shell } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openStore } from './store'
import { MailService } from './mail'
import { autodetect } from './autodetect'
import type { MailEvent, MessageRow } from '../shared/api'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const updater = require('./updater.js')

if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | null = null
let quitting = false
let pendingMailto: string | null = null

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
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 28, y: 30 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#1b1e23', symbolColor: '#eef0f3', height: 40 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true,
    },
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.once('ready-to-show', () => win?.show())
  // nothing ever navigates the app window; links go to the system browser
  win.webContents.setWindowOpenHandler(({ url }) => { openSafe(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); openSafe(url) } })
  win.on('close', (e) => { if (process.platform === 'darwin' && !quitting) { e.preventDefault(); win?.hide() } })
  win.on('closed', () => { win = null })
  win.webContents.on('did-finish-load', () => {
    if (pendingMailto) { emit(mailtoEvent(pendingMailto)); pendingMailto = null }
  })
}

function openSafe(url: string) {
  if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url)
}

function mailtoEvent(url: string): MailEvent {
  const u = new URL(url)
  return { type: 'compose', to: decodeURIComponent(u.pathname), subject: u.searchParams.get('subject') || undefined, body: u.searchParams.get('body') || undefined }
}

function handleMailto(url: string) {
  if (!url?.toLowerCase().startsWith('mailto:')) return
  if (win && !win.webContents.isLoading()) { emit(mailtoEvent(url)); show() } else pendingMailto = url
}

app.on('open-url', (e, url) => { e.preventDefault(); handleMailto(url) })
app.on('second-instance', (_e, argv) => { const m = argv.find((a) => a.startsWith('mailto:')); if (m) handleMailto(m); show() })
app.on('activate', () => show())
app.on('before-quit', () => { quitting = true })

app.whenReady().then(() => {
  app.setName('RoarMail')
  const startMailto = process.argv.find((a) => a.toLowerCase().startsWith('mailto:'))
  if (startMailto) pendingMailto = startMailto
  const db = openStore()

  const notify = (accountId: string, rows: MessageRow[]) => {
    if (!Notification.isSupported() || win?.isFocused()) return
    const list = rows.slice(0, 3)
    for (const r of list) {
      const n = new Notification({ title: r.fromName || r.fromEmail, body: r.subject || '(no subject)', silent: false })
      n.on('click', () => { show(); emit({ type: 'open', messageId: r.threadId || r.id }) })
      n.show()
    }
    if (rows.length > list.length) new Notification({ title: 'RoarMail', body: `+${rows.length - list.length}` }).show()
  }

  const mail = new MailService(db, emit, notify)

  ipcMain.handle('mail:platform', () => process.platform)
  ipcMain.handle('mail:autodetect', (_e, email: string) => autodetect(email))
  ipcMain.handle('mail:testAccount', (_e, cfg, pass) => mail.test(cfg, pass))
  ipcMain.handle('mail:addAccount', (_e, cfg, pass) => mail.add(cfg, pass))
  ipcMain.handle('mail:removeAccount', (_e, id) => mail.remove(id))
  ipcMain.handle('mail:accounts', () => mail.accounts())
  ipcMain.handle('mail:folders', (_e, id) => mail.folders(id))
  ipcMain.handle('mail:messages', async (_e, scope, before) => {
    if (scope.folderId && before == null) mail.openFolder(scope.folderId).catch(() => {})
    return mail.list(scope, before)
  })
  ipcMain.handle('mail:message', (_e, id) => mail.message(id))
  ipcMain.handle('mail:search', (_e, q, a) => mail.search(q, a))
  ipcMain.handle('mail:contacts', (_e, q) => mail.contacts(q))
  ipcMain.handle('mail:thread', (_e, key) => mail.thread(key))
  ipcMain.handle('mail:act', (_e, ids, action, target) => mail.act(ids, action, target))
  ipcMain.handle('mail:undo', (_e, token) => mail.undo(token))
  ipcMain.handle('mail:allowImages', (_e, s) => mail.allowImages(s))
  ipcMain.handle('mail:send', (_e, d) => mail.send(d))
  ipcMain.handle('mail:cancelSend', (_e, id) => mail.cancelSend(id))
  ipcMain.handle('mail:retrySend', (_e, id) => mail.retrySend(id))
  ipcMain.handle('mail:outbox', () => mail.outbox())
  ipcMain.handle('mail:saveDraft', (_e, d, toServer) => mail.saveDraft(d, toServer))
  ipcMain.handle('mail:discardDraft', (_e, id) => mail.discardDraft(id))
  ipcMain.handle('mail:draftFromMessage', (_e, id) => mail.draftFromMessage(id))
  ipcMain.handle('mail:updateAccount', (_e, id, patch) => mail.updateAccount(id, patch))
  ipcMain.handle('mail:signatures', () => mail.signatures())
  ipcMain.handle('mail:saveSignature', (_e, sig) => mail.saveSignature(sig))
  ipcMain.handle('mail:deleteSignature', (_e, id) => mail.deleteSignature(id))
  ipcMain.handle('mail:settings', () => mail.settings())
  ipcMain.handle('mail:setSetting', (_e, k, v) => mail.setSetting(k, v))
  ipcMain.handle('mail:refresh', (_e, id) => mail.refresh(id))
  ipcMain.handle('mail:openExternal', (_e, url) => openSafe(url))
  ipcMain.handle('mail:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('mail:openAttachment', async (_e, id) => {
    const a = await mail.attachment(id)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roarmail-'))
    const file = path.join(dir, a.filename)
    fs.writeFileSync(file, a.content)
    await shell.openPath(file)
  })
  ipcMain.handle('mail:saveAttachment', async (_e, id) => {
    const a = await mail.attachment(id)
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('downloads'), a.filename) })
    if (!r.canceled && r.filePath) fs.writeFileSync(r.filePath, a.content)
  })

  createWindow()
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

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
