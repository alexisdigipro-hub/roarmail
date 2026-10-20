// Finds the server settings for an address: known providers first, then the public Thunderbird
// autoconfig database (the same one Thunderbird uses), then the usual mail.<domain> guess.
import { net } from 'electron'
import dns from 'dns/promises'
import type { ServerConfig } from '../shared/api'

type Preset = Omit<ServerConfig, 'email' | 'displayName' | 'username'>

const GMAIL: Preset = {
  provider: 'gmail', imapHost: 'imap.gmail.com', imapPort: 993, imapTls: 'tls', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpTls: 'tls',
  hint: 'gmail',
}
const MICROSOFT: Preset = {
  provider: 'microsoft', imapHost: 'outlook.office365.com', imapPort: 993, imapTls: 'tls', smtpHost: 'smtp-mail.outlook.com', smtpPort: 587, smtpTls: 'starttls',
  hint: 'microsoft',
}
const ICLOUD: Preset = {
  provider: 'icloud', imapHost: 'imap.mail.me.com', imapPort: 993, imapTls: 'tls', smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpTls: 'starttls',
  hint: 'icloud',
}
const YAHOO: Preset = {
  provider: 'yahoo', imapHost: 'imap.mail.yahoo.com', imapPort: 993, imapTls: 'tls', smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpTls: 'tls',
  hint: 'yahoo',
}

const BY_DOMAIN: Record<string, Preset> = {
  'gmail.com': GMAIL, 'googlemail.com': GMAIL,
  'outlook.com': MICROSOFT, 'hotmail.com': MICROSOFT, 'live.com': MICROSOFT, 'msn.com': MICROSOFT,
  'icloud.com': ICLOUD, 'me.com': ICLOUD, 'mac.com': ICLOUD,
  'yahoo.com': YAHOO, 'yahoo.gr': YAHOO, 'ymail.com': YAHOO,
}

const tlsOf = (socketType: string): ServerConfig['imapTls'] =>
  /ssl|tls/i.test(socketType) ? 'tls' : /starttls/i.test(socketType) ? 'starttls' : 'none'

async function ispdb(domain: string): Promise<Preset | null> {
  try {
    const r = await net.fetch(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`)
    if (!r.ok) return null
    const xml = await r.text()
    const block = (kind: string) => {
      const m = xml.match(new RegExp(`<${kind}Server type="(imap|smtp)">([\\s\\S]*?)</${kind}Server>`))
      if (!m) return null
      const tag = (t: string) => (m[2].match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1] || ''
      return { host: tag('hostname'), port: Number(tag('port')), tls: tlsOf(tag('socketType')) }
    }
    const i = block('incoming'), o = block('outgoing')
    if (!i || !o || !/imap/i.test(xml.match(/<incomingServer type="(\w+)"/)?.[1] || '')) return null
    return { provider: 'imap', imapHost: i.host, imapPort: i.port || 993, imapTls: i.tls, smtpHost: o.host, smtpPort: o.port || 465, smtpTls: o.tls }
  } catch {
    return null
  }
}

export async function autodetect(email: string): Promise<ServerConfig> {
  const domain = email.split('@')[1]?.toLowerCase().trim() || ''
  const base = { email, displayName: '', username: email }
  if (BY_DOMAIN[domain]) return { ...base, ...BY_DOMAIN[domain] }

  // Google Workspace and Microsoft 365 domains are told apart by their MX records
  let mx: string[] = []
  try { mx = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase()) } catch { /* no MX */ }
  if (mx.some((h) => h.endsWith('google.com') || h.endsWith('googlemail.com'))) return { ...base, ...GMAIL }
  if (mx.some((h) => h.endsWith('outlook.com'))) return { ...base, ...MICROSOFT }

  const found = await ispdb(domain)
  if (found) return { ...base, ...found }

  // the usual guess; on shared hosting (Plesk, cPanel) the certificate may carry the server's own name,
  // which testAccount() notices and fixes
  const host = mx[0] && !mx[0].includes('google') ? mx[0] : `mail.${domain}`
  return { ...base, provider: 'imap', imapHost: host, imapPort: 993, imapTls: 'tls', smtpHost: host, smtpPort: 465, smtpTls: 'tls' }
}
