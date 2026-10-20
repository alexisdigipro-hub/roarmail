// Runs before the screens load: in a browser (no desktop app around) the web demo takes the place of the
// mail engine, and a small pill points to the downloads.
import { createDemo } from './demo'
import { applyLook, LOOK_DEFAULTS } from './look'

const web = !window.roarmail
if (web) (window as any).roarmail = createDemo()
document.documentElement.dataset.platform = window.roarmail.platform || 'web'
// the default look at once (no flash), then the saved one as soon as it is read
applyLook({ ...LOOK_DEFAULTS, appearance: 'system' } as any)
window.roarmail.settings().then(applyLook).catch(() => {})

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
