// Runs before the screens load: in a browser (no desktop app around) the web demo takes the place of the
// mail engine, and a small pill points to the downloads.
import { createDemo } from './demo'
import { applyLook, LOOK_DEFAULTS } from './look'

const web = !window.roarmail
if (web) (window as any).roarmail = createDemo()
document.documentElement.dataset.platform = window.roarmail.platform || 'web'
// the default look at once (no flash), then the saved one as soon as it is read
applyLook({ ...LOOK_DEFAULTS, appearance: 'system' } as any)
// Every window keeps the saved look (Alex, 4 Nov 2026: "the window is red and Settings say blue"). The first read can come
// before the app is ready (a window opened while it starts, after an update) or while it is locked: then it is tried again
// until it works, and read again after any change, any sync and an unlock, in every window (main, panels, messages).
const wear = (tries = 0) => {
  window.roarmail.settings().then(applyLook).catch(() => { if (tries < 40) setTimeout(() => wear(tries + 1), 500) })
}
wear()
try {
  window.roarmail.on?.((e: any) => {
    // the Settings window wears what is picked in it at once (and its Day/Night reveal): it waits only for a sync or an unlock
    const own = /panel=settings/.test(location.hash)
    if ((e?.type === 'settings' && !own) || e?.type === 'roarSync' || (e?.type === 'lock' && !e.locked)) wear()
  })
} catch { /* the web demo */ }

if (web) {
  const el = (navigator.language || '').toLowerCase().startsWith('el')
  const pill = document.createElement('a')
  pill.className = 'demo-pill'
  pill.href = 'https://github.com/alexisdigipro-hub/roarmail/releases/latest'
  pill.target = '_blank'
  pill.rel = 'noopener'
  pill.innerHTML = el ? '<b>Demo</b> με δείγματα · Κατέβασε για Mac / Windows' : '<b>Demo</b> with sample mail · Download for Mac / Windows'
  if (document.body) document.body.appendChild(pill)
  else addEventListener('DOMContentLoaded', () => document.body.appendChild(pill))
}
