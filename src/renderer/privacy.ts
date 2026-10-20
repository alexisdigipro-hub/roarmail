// Privacy helpers for the reader: spotting tracking pixels, cleaning tracking tags off links, and checking
// a link before it opens (real address, text that shows another site, look-alike letters).

// services whose only job in a mail is to report the opening
const TRACKER_HOSTS = [
  'mailtrack.io', 'mltrk.io', 'mailstat.us', 'getnotify.com', 'bananatag.com', 'yesware.com', 'mailfoogae.appspot.com',
  'track.mixmax.com', 'r.superhuman.com', 'app.salesloft.com', 'outreach.io', 'polymail.io', 'cirrusinsight.com',
  'mailbutler.io', 'boomerangapp.com', 'clickmeter.com', 'pixel.watch', 'mandrillapp.com', 'list-manage.com',
  'hubspotemail.net', 'hs-analytics.net', 'customeriomail.com', 'sendibt3.com', 'sendibw',
  'exct.net', 'rs6.net', 'ct.sendgrid.net', 'email.mg.', 'mailgun.org', 'emltrk.com', 'trk.klclick', 'klaviyomail.com',
  'pardot.com', 'mktoresp.com', 'eloqua.com', 'tracking.tldrnewsletter', 'beacon.', 'pixel.',
]
// paths that open-tracking services use
const TRACKER_PATH = /\/(wf\/open|track\/open|open\.(gif|png|aspx|php)|e\/o\/|o\/[A-Za-z0-9_-]{20,}|pixel(\.(gif|png))?(?=[/?#]|$)|beacon(?=[/?#.]|$)|trk(?=[/?#]|$)|tracking\/open|imp(?=[/?#]|$)|open\?)/i

export function isTracker(img: Element): boolean {
  const src = img.getAttribute('src') || img.getAttribute('data-blocked-src') || ''
  if (!/^(https?:)?\/\//i.test(src)) return false
  const num = (v: string | null) => (v == null ? NaN : parseFloat(v))
  const w = num(img.getAttribute('width')), h = num(img.getAttribute('height'))
  const style = (img.getAttribute('style') || '').toLowerCase()
  const sw = num((style.match(/(?:^|;)\s*width:\s*([\d.]+)px/) || [])[1] ?? null)
  const sh = num((style.match(/(?:^|;)\s*height:\s*([\d.]+)px/) || [])[1] ?? null)
  const tiny = (w <= 3 && h <= 3) || (sw <= 3 && sh <= 3) || ((w <= 3 || sw <= 3) && (h <= 3 || sh <= 3))
  const hidden = /display:\s*none|visibility:\s*hidden|opacity:\s*0(\.0+)?\s*(;|$)/.test(style)
  let host = '', path = ''
  try { const u = new URL(src.startsWith('//') ? `https:${src}` : src); host = u.hostname.toLowerCase(); path = u.pathname + u.search } catch { /* bad url */ }
  const known = TRACKER_HOSTS.some((t) => (t.endsWith('.') ? host.startsWith(t) || host.includes(`.${t}`) : host === t || host.endsWith(`.${t}`)))
  return tiny || hidden || known || TRACKER_PATH.test(path)
}

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|oly_anon_id|oly_enc_id|vero_conv|vero_id|wickedid|yclid|igshid|__s|ss_source|ref_src)$/i

export function stripTracking(href: string): string {
  try {
    const u = new URL(href)
    if (!/^https?:$/.test(u.protocol)) return href
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k)
    return u.toString()
  } catch { return href }
}

export type LinkWarning = 'mismatch' | 'lookalike' | 'ip' | 'insecure'

/** the last two parts of a host (three for co.uk-style endings), to compare sites */
function site(host: string) {
  const p = host.toLowerCase().replace(/^www\./, '').split('.')
  return p.slice(/^(co|com|org|net|gov|ac|edu)$/.test(p[p.length - 2] || '') ? -3 : -2).join('.')
}

export function checkLink(href: string, text: string): { url: string; host: string; warnings: LinkWarning[] } {
  const warnings: LinkWarning[] = []
  let host = ''
  try {
    const u = new URL(href)
    host = u.hostname
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) warnings.push('ip')
    if (/(^|\.)xn--/.test(host) || /[^\x00-\x7f]/.test(host)) warnings.push('lookalike')
    if (u.protocol === 'http:') warnings.push('insecure')
    // the text shows one site, the link goes to another
    const shown = (text.trim().match(/^(?:https?:\/\/)?((?:[\w-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?$/i) || [])[1]
    if (shown && site(shown) !== site(host)) warnings.push('mismatch')
  } catch { /* mailto and the like */ }
  return { url: href, host, warnings }
}
