// Contacts (29 Oct 2026): reading a person's card out of the signature at the foot of their mail, and reading
// .vcf / .csv files from other address books. Plain functions, no database: mail.ts keeps the results.

export interface CardFields { name?: string; phone?: string; company?: string; title?: string; website?: string; notes?: string; emails?: string[] }

const FREE = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|gmx|mail|yandex|otenet|hol|windowslive|zoho)\./i
const PHONE = /(?:\+|00)?\d[\d\s().\-/]{7,}\d/
const WEB = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|gr|net|org|io|co|eu|uk|de|fr|it|tv|film|studio|agency|me|app)(?:\/[^\s]*)?\b/i
const QUOTE = /^(>|On .+wrote:|Στις .+έγραψε|-----\s*Original Message|From:|Από:|Sent from my|Εστάλη από)/i
const NOTICE = /(confidential|disclaimer|important notice|intended only|privileged|εμπιστευτικ|unsubscribe|this e-?mail)/i

/** the signature: the last lines of the person's own words, before any quoted reply */
function tail(text: string): string[] {
  const lines = text.replace(/\r/g, '').split('\n')
  const cut = lines.findIndex((l) => QUOTE.test(l.trim()))
  const own = (cut >= 0 ? lines.slice(0, cut) : lines).map((l) => l.trim()).filter(Boolean)
  return own.slice(-14).filter((l) => !NOTICE.test(l) && l.length < 140)
}

/** what a signature tells about its sender; name is how they sign, email their address */
export function readSignature(text: string, name: string, email: string): CardFields {
  const out: CardFields = {}
  const lines = tail(text)
  if (!lines.length) return out
  const first = (name || '').split(/\s+/)[0]?.toLowerCase()
  const at = first ? lines.findIndex((l) => l.toLowerCase().includes(first) && l.length < 90) : -1
  const from = at >= 0 ? lines.slice(at) : lines.slice(-8)
  for (const l of from) {
    if (!out.phone) { const label = /\b(t|tel|m|mob|mobile|phone|τηλ|κιν|κινητό)\b\.?:?/i.test(l); const m = l.match(PHONE); if (m && (label || m[0].replace(/\D/g, '').length >= 10) && !l.includes('@')) out.phone = m[0].replace(/[^\d+ ]/g, ' ').replace(/\s+/g, ' ').trim() }
    if (!out.website) { const w = l.replace(/\S+@\S+/g, '').match(WEB); if (w) out.website = w[0].replace(/^https?:\/\//i, '').replace(/\/$/, '') }
  }
  // the line with the name often carries the role after a | or a comma; else the next short plain line
  if (at >= 0) {
    const own = lines[at]
    const parts = own.split(/\s*[|·•,–]\s*/).filter(Boolean)
    if (parts.length > 1) out.title = parts.slice(1).join(', ')
    const plain = (l: string) => l.length < 60 && !/[@\d]/.test(l) && !WEB.test(l) && !/^(kind|best|regards|thanks|με εκτίμηση|φιλικά|χαιρετισμούς)/i.test(l)
    const next = lines.slice(at + 1).filter(plain)
    if (!out.title && next[0]) out.title = next.shift()
    if (next[0]) out.company = next[0]
  }
  if (!out.company) {
    const d = email.split('@')[1] || ''
    if (d && !FREE.test(d)) { const base = d.split('.').slice(-2, -1)[0] || ''; if (base.length > 2) out.company = base.charAt(0).toUpperCase() + base.slice(1) }
  }
  for (const k of Object.keys(out) as (keyof CardFields)[]) if (typeof out[k] === 'string' && !(out[k] as string).trim()) delete out[k]
  return out
}

/** vCard 3/4: one card per BEGIN:VCARD … END:VCARD, folded lines joined */
export function readVcf(text: string): CardFields[] {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/)
  const cards: CardFields[] = []
  let c: CardFields | null = null
  const val = (l: string) => l.slice(l.indexOf(':') + 1).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim()
  for (const l of lines) {
    const key = l.split(':')[0].split(';')[0].toUpperCase().replace(/^ITEM\d+\./, '')
    if (key === 'BEGIN') c = { emails: [] }
    else if (key === 'END' && c) { if (c.emails?.length) cards.push(c); c = null }
    else if (!c) continue
    else if (key === 'FN') c.name = val(l)
    else if (key === 'N' && !c.name) { const [last, firstN] = val(l).split(';'); c.name = [firstN, last].filter(Boolean).join(' ') }
    else if (key === 'EMAIL') c.emails!.push(val(l).toLowerCase())
    else if (key === 'TEL' && !c.phone) c.phone = val(l)
    else if (key === 'ORG') c.company = val(l).split(';').filter(Boolean).join(', ')
    else if (key === 'TITLE') c.title = val(l)
    else if (key === 'URL' && !c.website) c.website = val(l).replace(/^https?:\/\//i, '')
    else if (key === 'NOTE') c.notes = val(l)
  }
  return cards
}

/** a CSV from Google Contacts, Outlook or a spreadsheet: the columns are found by their names */
export function readCsv(text: string): CardFields[] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  const sep = text.slice(0, 2000).split('\n')[0].includes(',') ? ',' : ';'
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') q = false; else cell += ch }
    else if (ch === '"') q = true
    else if (ch === sep) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase())
  const col = (...names: RegExp[]) => head.findIndex((h) => names.some((n) => n.test(h)))
  const iName = col(/^name$/, /^full name$/, /^display name$/, /^όνομα$/), iFirst = col(/^first name$/, /^given name$/), iLast = col(/^last name$/, /^family name$/)
  const iMails = head.map((h, i) => (/e-?mail/.test(h) && !/type|label/.test(h) ? i : -1)).filter((i) => i >= 0)
  const iPhone = col(/^phone 1 - value$/, /mobile phone/, /^phone$/, /^mobile$/, /τηλέφωνο/), iOrg = col(/organization 1 - name/, /^company$/, /^organization$/, /εταιρεία/)
  const iTitle = col(/organization 1 - title/, /^job title$/, /^title$/), iWeb = col(/website 1 - value/, /web page/, /^website$/), iNote = col(/^notes$/)
  return rows.map((r) => ({
    name: (iName >= 0 ? r[iName] : [r[iFirst], r[iLast]].filter(Boolean).join(' ')) || undefined,
    emails: iMails.flatMap((i) => (r[i] || '').split(/\s*:::\s*|\s*;\s*/)).map((e) => e.trim().toLowerCase()).filter((e) => /@/.test(e)),
    phone: iPhone >= 0 ? r[iPhone] || undefined : undefined, company: iOrg >= 0 ? r[iOrg] || undefined : undefined,
    title: iTitle >= 0 ? r[iTitle] || undefined : undefined, website: iWeb >= 0 ? r[iWeb] || undefined : undefined, notes: iNote >= 0 ? r[iNote] || undefined : undefined,
  })).filter((c) => c.emails.length)
}
