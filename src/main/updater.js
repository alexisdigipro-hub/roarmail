// RoarMail updates itself, the same way RoarMe does: there is no paid Apple certificate yet, so Electron's own
// updater cannot be used. The app looks at the newest GitHub release, downloads the right installer in the
// background, and the page shows "Restart to update". On a Mac a small script swaps the .app; on Windows the
// installer runs silently and opens RoarMail again.
const { app, BrowserWindow, Notification, net, shell } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const REPO = 'alexisdigipro-hub/roarmail'
const EVERY = 2 * 3600e3

let state = { status: 'idle', version: '', progress: 0, error: '' }
let file = ''
let timer = null
let busy = false
let notified = ''
let hook = null // main.js: the menu bar's paw shows the update too (1.4.10)

const send = (patch) => {
  state = { ...state, ...patch }
  BrowserWindow.getAllWindows().forEach((w) => { try { w.webContents.send('mail:update', state) } catch { /* closing */ } })
  if (hook) try { hook(state) } catch { /* no menu */ }
}
const newer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  return false
}
// The newest release is read from GitHub's public release page, not its API: the API allows only 60 questions
// an hour per internet connection, which an office or a mobile network shares (0.2.1). github.com/<repo>/releases/latest
// forwards to the newest release's page; its address gives the tag and its title the version.
const SUFFIX = () => (process.platform === 'win32' ? 'Windows-Setup.exe' : process.arch === 'arm64' ? 'Mac-arm64.dmg' : 'Mac-x64.dmg')
const dir = () => path.join(app.getPath('userData'), 'updates')

async function latest() {
  const r = await net.fetch(`https://github.com/${REPO}/releases/latest`, { headers: { 'User-Agent': 'RoarMail', Accept: 'text/html' } })
  if (!r.ok) throw new Error(`GitHub ${r.status}`)
  const html = await r.text()
  const tag = decodeURIComponent((String(r.url).match(/\/releases\/tag\/([^/?#]+)/) || html.match(/\/releases\/tag\/([^"'/?#]+)/) || [])[1] || '')
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || ''
  const version = (title.match(/RoarMail (\d+\.\d+\.\d+)/) || tag.match(/(\d+\.\d+\.\d+)/) || [])[1] || ''
  return { tag, version }
}

async function check() {
  if (!app.isPackaged || busy || state.status === 'ready') return state
  busy = true
  try {
    send({ status: 'checking', error: '' })
    const { tag, version } = await latest()
    if (!tag || !version || !newer(version, app.getVersion())) { send({ status: 'idle', version: '' }); return state }
    const name = `RoarMail-${version}-beta-${SUFFIX()}`
    fs.mkdirSync(dir(), { recursive: true })
    // anything older left from before goes
    for (const f of fs.readdirSync(dir())) if (!f.includes(version)) { try { fs.rmSync(path.join(dir(), f), { force: true, recursive: true }) } catch { /* in use */ } }
    const target = path.join(dir(), name)
    // the file only gets its final name once complete, so one that is there is whole
    if (!fs.existsSync(target)) {
      send({ status: 'downloading', version, progress: 0 })
      const res = await net.fetch(`https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/${name}`, { headers: { 'User-Agent': 'RoarMail' } })
      if (res.status === 404) { send({ status: 'idle', version: '' }); return state }
      if (!res.ok || !res.body) throw new Error(`download ${res.status}`)
      const total = Number(res.headers.get('content-length')) || 0
      const part = `${target}.part`
      const out = fs.createWriteStream(part)
      const reader = res.body.getReader()
      let got = 0, last = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        got += value.length
        if (!out.write(Buffer.from(value))) await new Promise((ok) => out.once('drain', ok))
        const p = total ? Math.floor((got / total) * 100) : 0
        if (p !== last) { last = p; send({ progress: p }) }
      }
      await new Promise((ok, bad) => { out.end(); out.on('finish', ok); out.on('error', bad) })
      if (total && fs.statSync(part).size !== total) throw new Error('incomplete download')
      fs.renameSync(part, target)
    }
    file = target
    send({ status: 'ready', version, progress: 100 })
    if (notified !== version && Notification.isSupported()) {
      notified = version
      const n = new Notification({ title: `RoarMail ${version} is ready`, body: 'Restart RoarMail to update. It takes a few seconds.' })
      n.on('click', () => { BrowserWindow.getAllWindows()[0]?.show() })
      n.show()
    }
  } catch (e) {
    send({ status: 'error', error: String(e?.message || e) })
  } finally {
    busy = false
  }
  return state
}

// where this RoarMail.app lives (…/RoarMail.app/Contents/MacOS/RoarMail)
const macBundle = () => path.resolve(path.dirname(process.execPath), '..', '..')
const canReplace = (bundle) => {
  if (!/\.app$/.test(bundle) || bundle.includes('/Volumes/') || bundle.includes('AppTranslocation')) return false
  try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); fs.accessSync(bundle, fs.constants.W_OK); return true } catch { return false }
}

/* swap the app for the downloaded one; relaunch after a restart, not after a quit */
function install(relaunch) {
  if (state.status !== 'ready' || !file || !fs.existsSync(file)) return false
  if (process.platform === 'darwin') {
    const bundle = macBundle()
    if (!canReplace(bundle)) { shell.openPath(file); return false }
    const script = path.join(dir(), 'swap.sh')
    fs.writeFileSync(script, MAC_SWAP, { mode: 0o755 })
    spawn('/bin/bash', [script, String(process.pid), file, bundle, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' }).unref()
  } else if (process.platform === 'win32') {
    spawn(file, relaunch ? ['/S', '--force-run'] : ['/S'], { detached: true, stdio: 'ignore' }).unref()
  } else return false
  state = { ...state, status: 'installing' }
  return true
}

// waits for RoarMail to close, puts the new RoarMail.app in place of the old (the old stays if anything fails), opens it
const MAC_SWAP = `#!/bin/bash
PID="$1"; DMG="$2"; APP="$3"; RELAUNCH="$4"
for i in $(seq 1 100); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
MNT="$(mktemp -d /tmp/roarmail-update.XXXXXX)"
if hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$DMG" >/dev/null 2>&1; then
  SRC="$(ls -d "$MNT"/*.app 2>/dev/null | head -1)"
  if [ -n "$SRC" ] && ditto "$SRC" "$APP.new" && [ -x "$APP.new/Contents/MacOS/RoarMail" ]; then
    rm -rf "$APP.old" && mv "$APP" "$APP.old" && mv "$APP.new" "$APP" && rm -rf "$APP.old"
    [ -d "$APP" ] || mv "$APP.old" "$APP"
    xattr -dr com.apple.quarantine "$APP" 2>/dev/null
    rm -f "$DMG"
  else
    rm -rf "$APP.new"
  fi
  hdiutil detach "$MNT" -quiet -force >/dev/null 2>&1
fi
rmdir "$MNT" 2>/dev/null
[ "$RELAUNCH" = "1" ] && open "$APP"
exit 0
`

// restart into the new version now (the page's Restart to update and the paw's menu)
function restart(onQuitting) {
  if (!install(true)) return false
  onQuitting()
  setTimeout(() => app.quit(), 200)
  return true
}

function start(ipcMain, onQuitting, onState) {
  hook = onState || null
  ipcMain.handle('mail:update-state', () => state)
  ipcMain.handle('mail:update-check', () => check())
  ipcMain.handle('mail:update-install', () => restart(onQuitting))
  // quitting with an update waiting installs it (no reopening)
  app.on('will-quit', () => { if (state.status === 'ready') install(false) })
  setTimeout(check, 15e3)
  timer = setInterval(check, EVERY)
}

module.exports = { start, check, restart, getState: () => state, MAC_SWAP }
