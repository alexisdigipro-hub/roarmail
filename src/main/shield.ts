// The shield (Alex, 1 Nov 2026): phishing and dangerous mail caught on this computer, nothing asked of anyone.
// Plain functions (no database, no Electron), so test/shield.test.ts checks them; mail.ts gives them a parsed
// message and what the database knows about its sender, and the reader shows what comes back.
import type { Security } from '../shared/api'

// senders at these are people, not companies: their picture is their Gravatar
export const PERSONAL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.gr', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'zoho.com', 'yandex.com', 'otenet.gr', 'hol.gr', 'windowslive.com'])
/** mail.news.example.co.uk -> example.co.uk */
export function baseDomain(host: string) {
  const p = host.split('.').filter(Boolean)
  if (p.length <= 2) return p.join('.')
  const second = ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'gr'].includes(p[p.length - 2]) && p[p.length - 1].length === 2
  return p.slice(second ? -3 : -2).join('.')
}
/** as store.ts fold: lower case without accents, final sigma as sigma (store.ts opens the database, so not imported here) */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ς/g, 'σ')

/** a brand phishing likes to wear: the words that claim it (folded), the words a subject may use (ambiguous ones like
 *  "ups" or "nova" only count in the sender's name), and the address names and endings that really are it */
interface Brand { name: string; words: RegExp; subject: RegExp | null; labels: string[]; ends?: string[] }
const word = (...w: string[]) => new RegExp(`(?:^|[^a-z0-9\\u03b1-\\u03c9])(?:${w.join('|')})(?![a-z0-9\\u03b1-\\u03c9])`)
const brand = (name: string, words: string[], labels: string[], subject: string[] | null = words, ends?: string[]): Brand =>
  ({ name, words: word(...words), subject: subject && subject.length ? word(...subject) : null, labels, ends })
const BRANDS: Brand[] = [
  brand('PayPal', ['paypal'], ['paypal']),
  brand('Apple', ['apple', 'icloud', 'itunes'], ['apple', 'icloud', 'me', 'mac', 'itunes'], ['apple id', 'apple account', 'icloud', 'itunes']),
  brand('Microsoft', ['microsoft', 'outlook', 'office 365', 'office365', 'onedrive', 'hotmail'],
    ['microsoft', 'outlook', 'office', 'office365', 'live', 'hotmail', 'microsoftonline', 'onedrive', 'sharepoint', 'msn', 'windows', 'xbox', 'skype'],
    ['microsoft', 'office 365', 'office365', 'onedrive', 'hotmail']),
  brand('Google', ['google', 'gmail'], ['google', 'gmail', 'googlemail', 'youtube', 'withgoogle']),
  brand('Amazon', ['amazon'], ['amazon']),
  brand('Netflix', ['netflix'], ['netflix']),
  brand('DHL', ['dhl'], ['dhl']),
  brand('FedEx', ['fedex'], ['fedex']),
  brand('UPS', ['ups'], ['ups'], null),
  brand('Facebook', ['facebook'], ['facebook', 'facebookmail', 'fb', 'meta', 'metamail']),
  brand('Instagram', ['instagram'], ['instagram', 'facebookmail', 'meta', 'metamail']),
  brand('Meta', ['meta'], ['meta', 'metamail', 'facebook', 'facebookmail', 'fb'], null),
  brand('WhatsApp', ['whatsapp'], ['whatsapp', 'facebookmail', 'meta']),
  brand('Dropbox', ['dropbox'], ['dropbox', 'dropboxmail']),
  brand('DocuSign', ['docusign'], ['docusign']),
  brand('WeTransfer', ['wetransfer'], ['wetransfer']),
  brand('LinkedIn', ['linkedin'], ['linkedin']),
  brand('Eurobank', ['eurobank'], ['eurobank']),
  brand('Alpha Bank', ['alpha bank', 'alphabank', 'alpha τραπεζα'], ['alpha', 'alphabank']),
  brand('Piraeus Bank', ['piraeus', 'πειραιωσ'], ['piraeusbank', 'piraeus', 'winbank'], ['piraeus bank', 'piraeusbank', 'τραπεζα πειραιωσ', 'winbank']),
  brand('NBG', ['εθνικη τραπεζα', 'nbg', 'national bank of greece'], ['nbg'], ['εθνικη τραπεζα', 'national bank of greece']),
  brand('Cosmote', ['cosmote'], ['cosmote', 'ote']),
  brand('Vodafone', ['vodafone'], ['vodafone']),
  brand('Nova', ['nova'], ['nova'], null),
  brand('ELTA', ['elta', 'ελτα', 'ελληνικα ταχυδρομεια'], ['elta', 'elta-courier']),
  brand('ACS', ['acs', 'acs courier'], ['acscourier', 'acs'], ['acs courier']),
  brand('gov.gr', ['gov\\.gr', 'gov gr'], [], ['gov\\.gr'], ['gov.gr']),
  brand('AADE', ['aade', 'ααδε', 'taxisnet'], ['aade', 'gsis'], ['aade', 'ααδε', 'taxisnet'], ['gov.gr']),
]
// the names checked for one or two letters off: long and unusual enough that a real company is not caught
// (office, windows, live, icloud are left to the 0/o 1/l rn/m test: offices.gr and pcloud.com are real)
const CLOSE = new Set(['paypal', 'microsoft', 'google', 'amazon', 'netflix', 'facebook', 'instagram', 'whatsapp', 'dropbox', 'docusign',
  'wetransfer', 'linkedin', 'eurobank', 'alphabank', 'piraeusbank', 'cosmote', 'vodafone', 'youtube', 'office365', 'onedrive', 'sharepoint', 'outlook'])

/** the name under the ending: mail.paypal.co.uk -> paypal */
const labelOf = (domain: string) => baseDomain(domain).split('.')[0] || ''
const owns = (b: Brand, domain: string) => b.labels.includes(labelOf(domain)) || !!b.ends?.some((e) => domain === e || domain.endsWith(`.${e}`))

/** edit distance (letters added, dropped or changed), stopping early once the lengths are too far apart */
export function distance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

/** the brand an address is made to look like: paypa1, arnazon, g00gle, paypal-secure, one or two letters off */
export function lookalikeOf(domain: string): string | null {
  domain = domain.toLowerCase()
  if (PERSONAL.has(domain) || BRANDS.some((b) => owns(b, domain))) return null
  const l = labelOf(domain)
  const swapped = l.replace(/0/g, 'o').replace(/1/g, 'l').replace(/rn/g, 'm').replace(/vv/g, 'w')
  for (const b of BRANDS) {
    for (const x of b.labels) {
      if (x.length < 4 || l === x) continue
      if (swapped === x) return b.name
      if (!CLOSE.has(x)) continue
      if (swapped.split('-').includes(x)) return b.name
      const d = distance(l, x)
      if ((d === 1 && x.length >= 6) || (d === 2 && x.length >= 8)) return b.name
    }
  }
  return null
}

/** the brand a sender's name (or subject) claims while the address is not that brand's */
export function claimedBrand(name: string, subject: string, domain: string, withSubject: boolean): string | null {
  const said = fold(name), sub = fold(subject)
  domain = domain.toLowerCase()
  return BRANDS.find((b) => !owns(b, domain) && (b.words.test(said) || (withSubject && !!b.subject?.test(sub))))?.name || null
}

// files that can run something, or hide what they are; an archive only when the text gives its password (scanners cannot open it)
const RISKY_FILE = /\.(exe|scr|js|jse|vbs|vbe|bat|cmd|com|pif|ps1|msi|hta|jar|iso|img|vhdx?|html?|shtml|svg|lnk|one|docm|xlsm|pptm|reg|wsf)$/i
const ARCHIVE_FILE = /\.(zip|rar|7z)$/i
const DOUBLE_EXT = /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|txt|rtf|csv)\.[a-z0-9]{2,5}$/i
const PASSWORD_TEXT = /password|passcode|κωδικ|συνθηματικ/i
/** the attachments that should not be opened without a second look */
export function riskyFiles(names: string[], text: string): string[] {
  const password = PASSWORD_TEXT.test(fold(text))
  return names.filter((raw) => {
    const f = raw.trim().replace(/[. ]+$/, '')
    return /[‪-‮⁦-⁩]/.test(raw) || RISKY_FILE.test(f) || DOUBLE_EXT.test(f) || (password && ARCHIVE_FILE.test(f))
  })
}

const URGENT_TEXT = word('verify', 'verification', 'suspended', 'locked', 'password', 'urgent', 'invoice overdue', 'overdue invoice', 'payment failed',
  'confirm your account', 'unusual activity', 'επαληθευσ\\S*', 'επαληθευστε', 'κλειδωθηκε', 'ανεσταλη', 'αναστολη', 'κωδικ\\S*', 'επειγον\\S*',
  'πληρωμη απετυχε', 'αποτυχια πληρωμησ', 'ληξιπροθεσμ\\S*', 'επιβεβαιωστε', 'ασυνηθιστη δραστηριοτητα')
/** the words of a mail that pushes: verify, suspended, password, payment failed (Greek too) */
export const urgent = (subject: string, text: string) => URGENT_TEXT.test(`${fold(subject)} ${fold(text.slice(0, 6000))}`)

const strip = (h: string) => h.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#x?[0-9a-f]+;/gi, '').trim()
/** links whose text is the address of one site while the link opens another: <a href="https://evil.example">www.paypal.com</a> */
export function mismatchedLinks(html: string): number {
  let n = 0
  for (const a of html.slice(0, 400e3).matchAll(/<a\b[^>]*?\bhref\s*=\s*["']?([^"'\s>]+)[^>]*>([\s\S]*?)<\/a>/gi)) {
    const shown = strip(a[2]).toLowerCase()
    const m = shown.match(/^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?$/)
    if (!m) continue
    let host = ''
    try {
      const u = new URL(a[1].replace(/&amp;/gi, '&'))
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue
      host = u.hostname.toLowerCase()
    } catch { continue }
    if (baseDomain(m[1].replace(/^www\./, '')) !== baseDomain(host.replace(/^www\./, ''))) n++
  }
  return n
}

/** what the shield looks at: the message's headers and text, and what the database knows about the sender */
export interface ShieldInput {
  /** the first Authentication-Results header ('' when none) */
  authResults: string
  fromName: string; fromEmail: string; replyTo?: string
  subject: string; text: string; html?: string
  /** the names of the attached files (not the pictures inside the text) */
  files: string[]
  /** no other mail from this address here, and never written to */
  firstTime: boolean
  /** written to, or a VIP: brand claims are left alone */
  known: boolean
  /** a list's mail (List-Unsubscribe) */
  list: boolean
}

/** sender checks from the receiving server's Authentication-Results, the common tricks, and the shield's checks */
export function shield(x: ShieldInput): Security {
  const res = (k: string) => (x.authResults.match(new RegExp(`\\b${k}=(\\w+)`, 'i')) || [])[1]?.toLowerCase()
  const dmarc = res('dmarc'), spf = res('spf'), dkim = res('dkim')
  const auth: Security['auth'] = !x.authResults ? 'none'
    : dmarc === 'fail' || (spf === 'fail' && (dkim === 'fail' || !dkim)) ? 'fail' : 'pass'
  const fromEmail = x.fromEmail.toLowerCase()
  const warnings: Security['warnings'] = []
  if (auth === 'fail') warnings.push('auth')
  // a display name that is itself an address, but not the real one: "paypal@paypal.com" <x@evil.example>
  const inName = (x.fromName.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0]?.toLowerCase()
  if (inName && inName !== fromEmail) warnings.push('nameSpoof')
  const replyTo = x.replyTo?.toLowerCase()
  const dom = (a?: string) => (a || '').split('@')[1]?.split('.').slice(-2).join('.')
  if (replyTo && fromEmail && dom(replyTo) !== dom(fromEmail)) warnings.push('replyTo')
  const domain = fromEmail.split('@')[1] || ''
  let claimed: string | undefined
  // a brand in the sender's name while the address is not that brand's; in the subject only from a first-time sender and
  // with pushing words ("PayPal: confirm your account"; "WeTransfer με τα rushes" from a new client is fine). People you
  // write to are left alone (a colleague "Maria, Google" is not phishing)
  if (domain && !x.known) {
    const b = claimedBrand(x.fromName, x.subject, domain, x.firstTime && urgent(x.subject, ''))
    if (b) { warnings.push('brand'); claimed = b }
  }
  if (domain) {
    const puny = /(^|\.)xn--/.test(domain)
    const look = puny ? null : lookalikeOf(domain)
    if (puny || look) { warnings.push('lookalike'); claimed = claimed || look || undefined }
  }
  const files = riskyFiles(x.files, `${x.subject} ${x.text.slice(0, 20e3)}`)
  if (files.length) warnings.push('attachment')
  const links = x.html ? mismatchedLinks(x.html) : 0
  if (links) warnings.push('links')
  if (x.firstTime && urgent(x.subject, x.text)) warnings.push('urgent')
  const strong = warnings.some((w) => w === 'auth' || w === 'nameSpoof' || w === 'brand' || w === 'lookalike' || w === 'attachment')
  // a newsletter that checks out often has its reply address elsewhere and tracked links: that pair alone is no danger
  const usual = auth === 'pass' && x.list && warnings.every((w) => w === 'replyTo' || w === 'links')
  const level: Security['level'] = strong || (warnings.length >= 2 && !usual) ? 'danger' : warnings.length ? 'notice' : 'ok'
  return { auth, warnings, replyTo, level, brand: claimed, files: files.length ? files : undefined, links: links || undefined }
}
