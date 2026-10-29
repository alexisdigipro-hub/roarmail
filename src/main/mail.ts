// The mail engine. Talks IMAP and SMTP straight from this computer to the user's own mail servers:
// no RoarMail server sits in between. Mail is cached in the local database (headers, text for search)
// and as .eml files (the full message, parsed again when opened).
//
// Every change the user makes (read, star, archive, move, send) is written to the local database at once
// and queued; a small runner takes the queue to the server. That gives undo (archive, trash and move wait a
// few seconds, sending waits the "undo send" delay) and offline use (the queue waits for the connection).
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import { simpleParser, type ParsedMail } from 'mailparser'
import tls from 'tls'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { app, net, shell } from 'electron'
import type { DB } from './store'
import { fold, now, uuid } from './store'
import { seal, open } from './vault'
import { OAUTH_PREFIX, refresh as msRefresh, signIn as msSignIn } from './microsoft'
import { cleanRule, plan } from './rules'
import { readSignature, type CardFields } from './contacts'
import { attendeeFor, buildReply, readInvite } from './ics'
import type {
  Account, AccountPatch, Action, Address, Contact, ContactFull, ContactPatch, Draft, MailFile, Folder, FolderRole, Invite, InviteAnswer, ListScope, MailEvent, MessageFull, MessageRow, OutboxItem,
  MailStats, Rule, Security, ServerConfig, Settings, Signature, SnoozedItem, Template,
} from '../shared/api'

// senders at these are people, not companies: their picture is their Gravatar
const PERSONAL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.gr', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'zoho.com', 'yandex.com', 'otenet.gr', 'hol.gr', 'windowslive.com'])
/** mail.news.example.co.uk -> example.co.uk */
function baseDomain(host: string) {
  const p = host.split('.').filter(Boolean)
  if (p.length <= 2) return p.join('.')
  const second = ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'gr'].includes(p[p.length - 2]) && p[p.length - 1].length === 2
  return p.slice(second ? -3 : -2).join('.')
}
function iconKey(email: string): string | null {
  const m = email.match(/^[^@\s]+@([a-z0-9.-]+\.[a-z]{2,})$/)
  if (!m) return null
  return PERSONAL.has(m[1]) ? `g:${email}` : `d:${baseDomain(m[1])}`
}
async function fetchIcon(key: string): Promise<string | null> {
  // a person: their Gravatar. A company: Google's icon service at 128 px (sharp in the list), else DuckDuckGo's;
  // both answer 404 when they have none, and neither is the sender, so nobody learns that a mail was looked at
  const urls = key.startsWith('g:')
    ? [`https://www.gravatar.com/avatar/${createHash('md5').update(key.slice(2)).digest('hex')}?s=96&d=404`]
    : [`https://www.google.com/s2/favicons?domain=${encodeURIComponent(key.slice(2))}&sz=128`, `https://icons.duckduckgo.com/ip3/${encodeURIComponent(key.slice(2))}.ico`]
  for (const url of urls) {
    const r = await net.fetch(url, { headers: { 'User-Agent': 'RoarMail' } }).catch(() => null)
    if (!r || !r.ok) continue
    const type = (r.headers.get('content-type') || '').split(';')[0].trim()
    if (!/^image\//.test(type)) continue
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 120 || buf.length > 300e3) continue
    return `data:${type};base64,${buf.toString('base64')}`
  }
  return null
}

const COLORS = ['#d40000', '#ff8a00', '#2f9bff', '#33c27f', '#b04cff', '#ff4fa3', '#00b8b0', '#c9a227']
const FIRST_SYNC_LIMIT = 300
const PREFETCH = 40
const UNDO_MS = 5e3

/** every setting and its default; stored as text in the settings table */
const SETTINGS: Settings = {
  undoSendSeconds: 5, swipeLeft: 'trash', swipeRight: 'archive',
  blockTrackers: true, stripTracking: true, lock: false, lockAfter: 15,
  runAtLogin: false, appearance: 'system',
  theme: 'simba', accent: 'red', font: 'system', density: 'standard', radius: 12,
  motion: true, focusRings: false, glass: true, textSize: 2, lite: false,
  checkEvery: 5, newMailSound: 'system', actionSounds: false, dockBadge: 'inbox', notifyFor: 'inbox',
  downloadsFolder: '', retrySending: true, remoteImages: true, searchTrash: true, searchJunk: true,
  listFont: 'system', listSize: 14, messageFont: 'system', monoFont: 'mono', plainMono: false,
  quoteColors: true, quote1: '#6d5dfc', quote2: '#1fa3b8', quote3: '#3fae49',
  language: 'auto', unifiedInbox: true, linksInBackground: false, dockMode: 'both', notifyReply: true, markRead: 'open',
  accountColours: true, accountBadges: true, inboxCounter: 'unread', folderCounter: 'unread',
  privacyMode: false, searchConversations: false, exactSearch: false, onlineSearch: false, detectLinks: true,
  autoUpdate: true, senderPictures: true, previewLines: 2, listAvatars: true, threadOrder: 'oldest',
  unifiedShown: 'inbox,snoozed,flagged,drafts,sent,archive,all,spam,trash', unifiedOrder: '',
  accountOrder: '',
}
const ROLE_KEYS = ['drafts', 'sent', 'spam', 'trash', 'archive'] as const
/** only accounts that are switched on show anywhere */
const ON = 'f.account_id in (select id from accounts where enabled = 1)'

type Row = Record<string, any>
/** what Move to another computer carries (exportSetup / importSetup), before index.ts encrypts it */
export interface SetupBundle { format: 'roarmail-setup'; version: number; at: number; tables: Record<string, Row[]> }
type MoveKind = 'archive' | 'trash' | 'move' | 'delete'

const ROLE_BY_USE: Record<string, FolderRole> = {
  '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash', '\\Junk': 'spam',
  '\\Archive': 'archive', '\\All': 'all', '\\Flagged': 'flagged',
}

const mailDir = () => path.join(app.getPath('userData'), 'mail')
const emlPath = (id: string) => path.join(mailDir(), `${id}.eml`)

/** a list row from a grouped query (conversation) or a plain message row */
/** what kind of file an attachment is, by its name first and its type second */
function fileKind(name: string, mime: string): MailFile['kind'] {
  const e = (name.split('.').pop() || '').toLowerCase()
  if (e === 'pdf' || mime === 'application/pdf') return 'pdf'
  if (/^(fdx|fountain|celtx|highland|fadein|wdz)$/.test(e)) return 'script'
  if (/^(jpe?g|png|gif|heic|heif|webp|tiff?|bmp|svg|psd|raw|cr2|cr3|nef|arw|dng)$/.test(e) || mime.startsWith('image/')) return 'image'
  if (/^(mov|mp4|m4v|avi|mkv|webm|mxf|prores|r3d|braw)$/.test(e) || mime.startsWith('video/')) return 'video'
  if (/^(mp3|wav|aiff?|m4a|aac|flac|ogg)$/.test(e) || mime.startsWith('audio/')) return 'audio'
  if (/^(xlsx?|csv|numbers|ods)$/.test(e)) return 'sheet'
  if (/^(pptx?|key|odp)$/.test(e)) return 'slides'
  if (/^(docx?|pages|rtf|txt|odt|md)$/.test(e)) return 'doc'
  if (/^(zip|rar|7z|tar|gz|tgz|dmg)$/.test(e)) return 'archive'
  return 'other'
}

const contactOf = (r: Row): Contact => ({
  email: r.email, name: r.name || '', phone: r.phone || '', company: r.company || '', title: r.title || '', website: r.website || '',
  notes: r.notes || '', groups: String(r.groups || '').split(',').filter(Boolean), vip: !!r.vip, blocked: !!r.blocked, count: r.n || 0, last: r.last || 0,
})

const toRow = (r: Row): MessageRow => ({
  id: r.id, accountId: r.account_id, threadId: r.thread_id || null,
  fromName: r.from_name || '', fromEmail: r.from_email || '',
  subject: r.subject || '', snippet: cleanText(r.snippet || '').replace(/\s+/g, ' ').trim(), date: r.date,
  seen: r.unread_n != null ? r.unread_n === 0 : !!r.seen,
  flagged: r.flag_n != null ? r.flag_n > 0 : !!r.flagged,
  answered: !!r.answered,
  hasAttachments: r.att_n != null ? r.att_n > 0 : !!r.has_attachments,
  ids: r.ids ? String(r.ids).split(',') : [r.id],
  count: r.n || 1,
})

const toAccount = (r: Row, state: Account['state'], error: string | undefined, aliases: Account['aliases']): Account => ({
  id: r.id, email: r.email, displayName: r.display_name, color: r.color, provider: r.provider,
  imapHost: r.imap_host, imapPort: r.imap_port, imapTls: r.imap_tls,
  smtpHost: r.smtp_host, smtpPort: r.smtp_port, smtpTls: r.smtp_tls, username: r.username,
  signatureId: r.signature_id || null, state, error,
  enabled: !!r.enabled, description: r.description || '', aliases,
  attachments: ['all', 'recent', 'none'].includes(r.attachments) ? r.attachments : 'recent',
  roles: (() => { try { return JSON.parse(r.roles_json || '{}') } catch { return {} } })(),
  trashDays: r.trash_days || 0, junkDays: r.junk_days || 0, unread: r.inbox_unread || 0, avatar: r.avatar || null,
})

// the text version of HTML mail carries [image: …] and [https://…] marks; a snippet reads better without them
const cleanText = (s: string) => s.replace(/\[(?:image:[^\]]*|https?:[^\]\s]*|cid:[^\]]*)\]/gi, ' ')
const snippetOf = (text: string) => cleanText(text).replace(/\s+/g, ' ').trim().slice(0, 220)
const msgIds = (s: string | null | undefined) => (s ? s.match(/<[^>]+>/g) || [] : [])
const fmtAddr = (a: Address) => (a.name ? `${a.name.replace(/[",]/g, '')} <${a.address}>` : a.address)
const json = (s: string | null | undefined, fallback: any = []) => { try { return JSON.parse(s || '') } catch { return fallback } }
/** a calendar invitation's part: a text/calendar alternative, or an .ics file */
const isCalendar = (a: { contentType?: string; filename?: string }) => /^(text\/calendar|application\/ics)$/i.test(a.contentType || '') || /\.ics$/i.test(a.filename || '')

function hasAttachment(node: any): boolean {
  if (!node) return false
  if (node.disposition === 'attachment') return true
  // a named file that is not shown inside the text counts too (many senders give no disposition)
  if (!(Array.isArray(node.childNodes) && node.childNodes.length) && (node.dispositionParameters?.filename || node.parameters?.name)
    && node.disposition !== 'inline' && !String(node.type || '').startsWith('text/')) return true
  return Array.isArray(node.childNodes) && node.childNodes.some(hasAttachment)
}

/** a password, or a Microsoft access token (Sign in with Microsoft) */
type Cred = string | { accessToken: string }

function imapOptions(cfg: { imapHost: string; imapPort: number; imapTls: string; username: string }, cred: Cred) {
  return {
    host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapTls === 'tls', doSTARTTLS: cfg.imapTls === 'starttls' ? true : undefined,
    auth: typeof cred === 'string' ? { user: cfg.username, pass: cred } : { user: cfg.username, accessToken: cred.accessToken }, logger: false as const, emitLogs: false,
    tls: { servername: cfg.imapHost }, connectionTimeout: 20e3, greetingTimeout: 15e3, socketTimeout: 5 * 60e3,
  }
}

function smtpTransport(cfg: { smtpHost: string; smtpPort: number; smtpTls: string; username: string }, cred: Cred) {
  return nodemailer.createTransport({
    host: cfg.smtpHost, port: cfg.smtpPort, secure: cfg.smtpTls === 'tls', requireTLS: cfg.smtpTls === 'starttls',
    auth: typeof cred === 'string' ? { user: cfg.username, pass: cred } : { type: 'OAuth2', user: cfg.username, accessToken: cred.accessToken }, tls: { servername: cfg.smtpHost }, connectionTimeout: 20e3,
  })
}

// Shared hosting (Plesk, cPanel) answers on mail.<domain> with a certificate in the server's own name
// (e.g. linux207.papaki.gr). Read that name so the account can use it instead of skipping the TLS check.
function certificateHost(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 10e3 }, () => {
      const alt = String(s.getPeerCertificate()?.subjectaltname || '')
      s.end()
      const names = alt.split(',').map((x) => x.trim().replace(/^DNS:/, '')).filter((x) => x && !x.startsWith('*'))
      resolve(names[0] || null)
    })
    s.on('error', () => resolve(null))
    s.on('timeout', () => { s.destroy(); resolve(null) })
  })
}

const isAltnameError = (e: any) => e?.code === 'ERR_TLS_CERT_ALTNAME_INVALID' || /altname|does not match certificate/i.test(String(e?.message))

function friendly(e: any): string {
  const m = String(e?.responseText || e?.response || e?.message || e)
  if (e?.authenticationFailed || /auth|login|credentials|password/i.test(m)) return 'auth'
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'host'
  if (/ETIMEDOUT|timeout|ECONNREFUSED|ECONNRESET|EPIPE|ENETUNREACH|EHOSTUNREACH|closed|Connection not available/i.test(m)) return 'network'
  if (/certificate|altname|self.signed/i.test(m)) return 'certificate'
  return m.slice(0, 300)
}
const transient = (code: string) => code === 'network' || code === 'host'

/** sender checks from the receiving server's Authentication-Results, and two common tricks */
function securityOf(mail: ParsedMail, fromEmail: string): Security {
  const raw = mail.headers.get('authentication-results') as unknown
  const first = String(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '')
  const res = (k: string) => (first.match(new RegExp(`\\b${k}=(\\w+)`, 'i')) || [])[1]?.toLowerCase()
  const dmarc = res('dmarc'), spf = res('spf'), dkim = res('dkim')
  const auth: Security['auth'] = !first ? 'none'
    : dmarc === 'fail' || (spf === 'fail' && (dkim === 'fail' || !dkim)) ? 'fail' : 'pass'
  const warnings: Security['warnings'] = []
  if (auth === 'fail') warnings.push('auth')
  // a display name that is itself an address, but not the real one: "paypal@paypal.com" <x@evil.example>
  const name = mail.from?.value?.[0]?.name || ''
  const inName = (name.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0]?.toLowerCase()
  if (inName && inName !== fromEmail) warnings.push('nameSpoof')
  const replyTo = mail.replyTo?.value?.[0]?.address?.toLowerCase()
  const dom = (a?: string) => (a || '').split('@')[1]?.split('.').slice(-2).join('.')
  if (replyTo && fromEmail && dom(replyTo) !== dom(fromEmail)) warnings.push('replyTo')
  return { auth, warnings, replyTo }
}

export class MailService {
  private worker = new Map<string, ImapFlow>()
  private queue = new Map<string, Promise<unknown>>()
  // the foreground lane (29 Oct 2026, "deleting is slow"): opening a message gets its own connection, so it never
  // waits behind background sync, prefetch or listing files on the worker
  private fg = new Map<string, ImapFlow>()
  private fgQueue = new Map<string, Promise<unknown>>()
  // a folder's check after a move waits a little and runs once, however many moves came meanwhile
  private syncSoon = new Map<string, ReturnType<typeof setTimeout>>()
  private filesListed = false
  private idle = new Map<string, ImapFlow>()
  private state = new Map<string, { state: Account['state']; error?: string }>()
  private retry = new Map<string, NodeJS.Timeout>()
  private backfilling = new Set<string>()
  private tokens = new Map<string, { access: string; expires: number }>()
  private poll: NodeJS.Timeout | null = null
  private lastClean = 0
  private ticker: NodeJS.Timeout | null = null
  private busyAccounts = new Set<string>()
  private sending = new Set<string>()
  private lastDraftPush = 0
  private snoozeTokens = new Map<string, string[]>()
  private wakeTried = new Set<string>()
  /** a system notification for things RoarMail itself brings back (snoozes, reminders) */
  alert: (title: string, body: string, key?: string) => void = () => {}

  constructor(private db: DB, private emit: (e: MailEvent) => void, private notify: (accountId: string, rows: MessageRow[]) => void) {
    fs.mkdirSync(mailDir(), { recursive: true })
    // anything cut off by a crash or quit goes back in the queue
    db.prepare(`update operations set status = 'queued' where status = 'running'`).run()
    db.prepare(`update outbox set status = 'queued' where status = 'sending'`).run()
    // drafts left open when the app closed go to the server's Drafts folder
    db.prepare(`update drafts set push = 1 where id not in (select draft_id from outbox)`).run()
  }

  // ---------- accounts ----------

  private accountRow(id: string): Row {
    const r = this.db.prepare('select * from accounts where id = ?').get(id) as Row
    if (!r) throw new Error('account not found')
    return r
  }
  private cfgOf(r: Row) {
    return { imapHost: r.imap_host, imapPort: r.imap_port, imapTls: r.imap_tls, smtpHost: r.smtp_host, smtpPort: r.smtp_port, smtpTls: r.smtp_tls, username: r.username }
  }

  accounts(): Account[] { return this.allAccounts().filter((a) => a.enabled) }

  /** the switched-off ones too, for Settings > Accounts */
  allAccounts(): Account[] {
    const aliases = this.db.prepare('select id, email, name from identities where account_id = ? and is_default = 0 order by email')
    return (this.db.prepare(`select a.*, i.signature_id, (select sum(unread) from folders f where f.account_id = a.id and f.role = 'inbox') as inbox_unread
      from accounts a left join identities i on i.account_id = a.id and i.is_default = 1
      order by a.sort, a.created_at`).all() as Row[])
      .map((r) => {
        const s = this.state.get(r.id)
        return toAccount(r, r.enabled ? s?.state || 'connecting' : 'offline', r.enabled ? s?.error : undefined, aliases.all(r.id) as Account['aliases'])
      })
  }

  async test(cfg: ServerConfig, password: Cred): Promise<{ ok: true; cfg: ServerConfig } | { ok: false; error: string }> {
    const c = { ...cfg }
    const tryImap = async () => { const cl = new ImapFlow(imapOptions(c, password)); await cl.connect(); await cl.logout() }
    const trySmtp = async () => { const t = smtpTransport(c, password); try { await t.verify() } finally { t.close() } }
    try {
      try { await tryImap() } catch (e) {
        if (!isAltnameError(e)) throw e
        const real = await certificateHost(c.imapHost, c.imapPort)
        if (!real) throw e
        if (c.smtpHost === c.imapHost) c.smtpHost = real
        c.imapHost = real
        await tryImap()
      }
      try { await trySmtp() } catch (e) {
        if (!isAltnameError(e)) throw e
        const real = await certificateHost(c.smtpHost, c.smtpPort)
        if (!real) throw e
        c.smtpHost = real
        await trySmtp()
      }
      return { ok: true, cfg: c }
    } catch (e) {
      return { ok: false, error: friendly(e) }
    }
  }

  async add(cfg: ServerConfig, password: string): Promise<Account> {
    const exists = this.db.prepare('select id from accounts where lower(email) = lower(?) and enabled = 1').get(cfg.email) as Row
    if (exists) throw new Error('duplicate')
    const id = uuid()
    const count = (this.db.prepare('select count(*) n from accounts').get() as Row).n as number
    this.db.prepare(`insert into accounts (id, email, display_name, color, sort, provider, imap_host, imap_port, imap_tls,
      smtp_host, smtp_port, smtp_tls, username, secret, created_at, updated_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, cfg.email, cfg.displayName || '', COLORS[count % COLORS.length], count, cfg.provider, cfg.imapHost, cfg.imapPort, cfg.imapTls,
      cfg.smtpHost, cfg.smtpPort, cfg.smtpTls, cfg.username, seal(password), now(), now())
    this.db.prepare('insert into identities (id, account_id, email, name, is_default) values (?,?,?,?,1)').run(uuid(), id, cfg.email, cfg.displayName || '')
    this.emit({ type: 'accounts' })
    this.startAccount(id)
    return this.accounts().find((a) => a.id === id)!
  }

  updateAccount(id: string, patch: AccountPatch) {
    const set = (col: string, v: unknown) => this.db.prepare(`update accounts set ${col} = ?, updated_at = ? where id = ?`).run(v, now(), id)
    if (patch.description != null) set('description', String(patch.description).trim().slice(0, 80))
    if (patch.avatar === null) set('avatar', null)
    if (patch.attachments && ['all', 'recent', 'none'].includes(patch.attachments)) { set('attachments', patch.attachments); this.prefetch(id).catch(() => {}) }
    if (patch.trashDays != null) set('trash_days', Math.max(0, Math.round(Number(patch.trashDays) || 0)))
    if (patch.junkDays != null) set('junk_days', Math.max(0, Math.round(Number(patch.junkDays) || 0)))
    if (patch.roles) {
      const roles: Record<string, string> = {}
      for (const k of ROLE_KEYS) if (typeof patch.roles[k] === 'string' && patch.roles[k]) roles[k] = patch.roles[k]!
      set('roles_json', JSON.stringify(roles))
      this.applyRoles(id)
    }
    if (patch.enabled != null) {
      set('enabled', patch.enabled ? 1 : 0)
      if (patch.enabled) this.startAccount(id); else { this.stopAccount(id); this.state.delete(id) }
      this.emit({ type: 'messages', accountId: id })
      this.badge()
    }
    if (patch.displayName != null) {
      this.db.prepare('update accounts set display_name = ?, updated_at = ? where id = ?').run(patch.displayName, now(), id)
      this.db.prepare('update identities set name = ? where account_id = ? and is_default = 1').run(patch.displayName, id)
    }
    if (patch.color) this.db.prepare('update accounts set color = ?, updated_at = ? where id = ?').run(patch.color, now(), id)
    if (patch.signatureId !== undefined) this.db.prepare('update identities set signature_id = ? where account_id = ? and is_default = 1').run(patch.signatureId, id)
    this.emit({ type: 'accounts' })
  }

  /** new servers (or a new password): tested first, then the account connects again with them */
  async updateServer(id: string, cfg: ServerConfig, password?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const r = this.accountRow(id)
    const pass = password || open(r.secret)
    const t = await this.test({ ...cfg, email: r.email, displayName: r.display_name, provider: r.provider }, password || await this.cred(r))
    if (!t.ok) return t
    const c = t.cfg
    this.db.prepare(`update accounts set imap_host = ?, imap_port = ?, imap_tls = ?, smtp_host = ?, smtp_port = ?, smtp_tls = ?, username = ?,
      secret = ?, updated_at = ? where id = ?`).run(c.imapHost, c.imapPort, c.imapTls, c.smtpHost, c.smtpPort, c.smtpTls, c.username, seal(pass), now(), id)
    this.stopAccount(id)
    if (r.enabled) this.startAccount(id)
    this.emit({ type: 'accounts' })
    return { ok: true }
  }

  addAlias(accountId: string, email: string, name: string) {
    const e = String(email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('bad-address')
    this.accountRow(accountId)
    if (this.db.prepare('select 1 from identities where account_id = ? and lower(email) = ?').get(accountId, e)) return
    this.db.prepare('insert into identities (id, account_id, email, name, is_default) values (?,?,?,?,0)').run(uuid(), accountId, e, String(name || '').trim())
    this.emit({ type: 'accounts' })
  }

  removeAlias(id: string) {
    this.db.prepare('delete from identities where id = ? and is_default = 0').run(id)
    this.emit({ type: 'accounts' })
  }

  /**
   * Move to another computer (Alex, 29 Oct: "everything as on my laptop, on the desktop too"): every account with its
   * password or Microsoft sign-in, aliases, folders (names, colours, hidden), signatures, templates, rules, smart
   * folders, every setting and the contacts (blocked, VIP, pictures allowed). The mail itself is not in it: it comes
   * again from the servers. index.ts encrypts this with the person's own passphrase before it touches a file.
   */
  exportSetup(): SetupBundle {
    const all = (t: string) => this.db.prepare(`select * from ${t}`).all() as Row[]
    const accounts = all('accounts').map((r) => ({ ...r, secret: r.secret ? open(r.secret) : '' }))
    const folders = (this.db.prepare('select id, account_id, path, name, delimiter, role, special, color, hidden from folders').all() as Row[])
    return {
      format: 'roarmail-setup', version: 1, at: now(),
      tables: { accounts, identities: all('identities'), folders, signatures: all('signatures'), templates: all('templates'), rules: all('rules'),
        smart_folders: all('smart_folders'), settings: all('settings'), contacts: all('contacts') },
    }
  }

  /** puts a bundle from exportSetup back; an account that is already here (same address) is updated, not doubled */
  importSetup(b: SetupBundle): { accounts: number; signatures: number; templates: number; rules: number } {
    if (b?.format !== 'roarmail-setup' || !b.tables) throw new Error('not-a-setup')
    const cols = (t: string) => new Set((this.db.prepare(`pragma table_info(${t})`).all() as Row[]).map((c) => c.name as string))
    const put = (t: string, r: Row, verb = 'insert or replace') => {
      const have = cols(t), keys = Object.keys(r).filter((k) => have.has(k))
      if (keys.length) this.db.prepare(`${verb} into ${t} (${keys.join(',')}) values (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => r[k]))
    }
    const T = b.tables, ids = new Map<string, string>(), fresh: string[] = []
    this.db.transaction(() => {
      for (const s of T.signatures || []) put('signatures', s)
      for (const x of T.templates || []) put('templates', x)
      for (const x of T.rules || []) put('rules', x)
      for (const x of T.smart_folders || []) put('smart_folders', x)
      // a downloads folder that this computer does not have is left as it is here
      for (const x of T.settings || []) { if (x.key === 'downloadsFolder' && x.value && !fs.existsSync(String(x.value))) continue; put('settings', x) }
      for (const a of T.accounts || []) {
        const here = this.db.prepare('select id from accounts where lower(email) = lower(?)').get(a.email) as Row | undefined
        const id = here?.id || ((this.db.prepare('select 1 from accounts where id = ?').get(a.id)) ? uuid() : a.id)
        ids.set(a.id, id)
        const row: Row = { ...a, id, secret: a.secret ? seal(String(a.secret)) : null, updated_at: now() }
        if (here) {
          const { id: _i, created_at: _c, ...rest } = row
          const have = cols('accounts'), keys = Object.keys(rest).filter((k) => have.has(k))
          this.db.prepare(`update accounts set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`).run(...keys.map((k) => (rest as Row)[k]), id)
        } else { put('accounts', row, 'insert'); fresh.push(id) }
      }
      for (const x of T.identities || []) {
        const acc = ids.get(x.account_id); if (!acc) continue
        if (this.db.prepare('select 1 from identities where account_id = ? and lower(email) = lower(?)').get(acc, x.email)) continue
        put('identities', { ...x, id: this.db.prepare('select 1 from identities where id = ?').get(x.id) ? uuid() : x.id, account_id: acc })
      }
      // folders keep their names, colours and hidden state; the next sync fills in the rest from the server
      for (const f of T.folders || []) {
        const acc = ids.get(f.account_id); if (!acc) continue
        this.db.prepare(`insert into folders (id, account_id, path, name, delimiter, role, special, color, hidden) values (?,?,?,?,?,?,?,?,?)
          on conflict(account_id, path) do update set color = excluded.color, hidden = excluded.hidden, name = excluded.name, role = coalesce(folders.role, excluded.role)`)
          .run(uuid(), acc, f.path, f.name, f.delimiter ?? null, f.role ?? null, f.special ?? null, f.color ?? null, f.hidden ? 1 : 0)
      }
      for (const c of T.contacts || []) {
        this.db.prepare(`insert into contacts (email, name, last_used, use_count, vip, blocked, images_allowed) values (?,?,?,?,?,?,?)
          on conflict(email) do update set name = coalesce(contacts.name, excluded.name), use_count = max(contacts.use_count, excluded.use_count),
          vip = max(contacts.vip, excluded.vip), blocked = max(contacts.blocked, excluded.blocked), images_allowed = max(contacts.images_allowed, excluded.images_allowed)`)
          .run(c.email, c.name ?? null, c.last_used ?? null, c.use_count || 0, c.vip ? 1 : 0, c.blocked ? 1 : 0, c.images_allowed ? 1 : 0)
      }
    })()
    for (const id of ids.values()) { this.stopAccount(id); this.state.delete(id); if ((this.db.prepare('select enabled from accounts where id = ?').get(id) as Row)?.enabled) this.startAccount(id) }
    this.emit({ type: 'accounts' })
    return { accounts: ids.size, signatures: (T.signatures || []).length, templates: (T.templates || []).length, rules: (T.rules || []).length }
  }

  /** the account's picture, from an image file (index.ts has made it a small square PNG) */
  setAvatar(id: string, dataUrl: string) {
    this.db.prepare('update accounts set avatar = ?, updated_at = ? where id = ?').run(dataUrl, now(), id)
    this.emit({ type: 'accounts' })
  }

  /**
   * Pictures for senders, as other mail apps show them: a person at a mail provider (gmail.com, outlook.com…)
   * gets their Gravatar, anyone else their company's icon (from Google's or DuckDuckGo's icon service, so the company
   * never sees who looked). Kept here; a missing one is asked for again after a week. Off in privacy mode.
   */
  async senderIcons(emails: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {}
    if (!this.settings().senderPictures) { for (const e of emails) out[e] = null; return out }
    const get = this.db.prepare('select data, fetched_at from sender_icons where key = ?')
    const put = this.db.prepare(`insert into sender_icons (key, data, fetched_at) values (?,?,?)
      on conflict(key) do update set data = excluded.data, fetched_at = excluded.fetched_at`)
    const todo = new Map<string, string[]>()
    for (const raw of [...new Set(emails.map((e) => String(e || '').toLowerCase().trim()))].slice(0, 120)) {
      const key = iconKey(raw)
      if (!key) { out[raw] = null; continue }
      const row = get.get(key) as Row | undefined
      if (row && (row.data || now() - row.fetched_at < 7 * 864e5)) { out[raw] = row.data || null; continue }
      todo.set(key, [...(todo.get(key) || []), raw])
    }
    const keys = [...todo.keys()]
    // a few at a time
    for (let i = 0; i < keys.length; i += 6) {
      await Promise.all(keys.slice(i, i + 6).map(async (key) => {
        const data = await fetchIcon(key).catch(() => null)
        put.run(key, data, now())
        for (const e of todo.get(key)!) out[e] = data
      }))
    }
    return out
  }

  /** the unified folders: each role across every switched-on account, with the counts added up */
  unifiedFolders(): Folder[] {
    const roles: FolderRole[] = ['inbox', 'snoozed', 'flagged', 'drafts', 'sent', 'archive', 'all', 'spam', 'trash']
    const rows = this.db.prepare(`select coalesce(f.special, f.role) as r, sum(f.unread) as unread, sum(f.total) as total, count(*) as n from folders f
      where coalesce(f.special, f.role) is not null and ${ON} group by r`).all() as Row[]
    return roles.flatMap((role) => {
      const r = rows.find((x) => x.r === role)
      return r || role === 'inbox' ? [{ id: `all:${role}`, accountId: 'all', path: role, name: role, role, unread: r?.unread || 0, total: r?.total || 0, depth: 0 }] : []
    })
  }

  /** every folder of the account, for choosing which is Sent, Trash and the rest */
  serverFolders(accountId: string): { path: string; name: string }[] {
    return (this.db.prepare('select path, name from folders where account_id = ? and special is null order by path').all(accountId) as Row[])
      .filter((r) => r.path.toUpperCase() !== 'INBOX').map((r) => ({ path: r.path, name: r.name }))
  }

  /** the folders chosen in Settings take their roles; a folder the server marked loses a role given elsewhere */
  private applyRoles(accountId: string) {
    const r = this.accountRow(accountId)
    let roles: Record<string, string> = {}
    try { roles = JSON.parse(r.roles_json || '{}') } catch { /* none */ }
    this.db.transaction(() => {
      for (const k of ROLE_KEYS) {
        const p = roles[k]
        if (!p || !this.db.prepare('select 1 from folders where account_id = ? and path = ?').get(accountId, p)) continue
        this.db.prepare('update folders set role = null where account_id = ? and role = ? and path <> ?').run(accountId, k, p)
        this.db.prepare('update folders set role = ? where account_id = ? and path = ?').run(k, accountId, p)
      }
    })()
    this.emit({ type: 'folders', accountId })
  }

  async remove(id: string) {
    this.stopAccount(id)
    const ids = this.db.prepare('select id from messages where account_id = ?').all(id) as Row[]
    this.db.prepare('delete from accounts where id = ?').run(id)
    for (const r of ids) fs.rmSync(emlPath(r.id), { force: true })
    this.db.prepare('delete from threads where id not in (select distinct thread_id from messages where thread_id is not null)').run()
    this.state.delete(id)
    this.emit({ type: 'accounts' })
    this.emit({ type: 'outbox' })
    this.badge()
  }

  private setState(id: string, state: Account['state'], error?: string) {
    const prev = this.state.get(id)
    if (prev?.state === state && prev?.error === error) return
    this.state.set(id, { state, error })
    this.emit({ type: 'accounts' })
  }

  // ---------- connections ----------

  /** run fn on the account's worker connection, one command at a time */
  private run<T>(accountId: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const prev = this.queue.get(accountId) || Promise.resolve()
    const next = prev.catch(() => {}).then(async () => {
      let c = this.worker.get(accountId)
      if (!c || !c.usable) {
        const r = this.accountRow(accountId)
        c = new ImapFlow(imapOptions(this.cfgOf(r), await this.cred(r)))
        c.on('error', () => {})
        await c.connect()
        this.worker.set(accountId, c)
      }
      return fn(c)
    })
    this.queue.set(accountId, next)
    return next as Promise<T>
  }

  /** the same, on the foreground connection: what the person is waiting for right now */
  private runNow<T>(accountId: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const prev = this.fgQueue.get(accountId) || Promise.resolve()
    const next = prev.catch(() => {}).then(async () => {
      let c = this.fg.get(accountId)
      if (!c || !c.usable) {
        const r = this.accountRow(accountId)
        c = new ImapFlow(imapOptions(this.cfgOf(r), await this.cred(r)))
        c.on('error', () => {})
        await c.connect()
        this.fg.set(accountId, c)
      }
      return fn(c)
    })
    this.fgQueue.set(accountId, next)
    return next as Promise<T>
  }

  private syncLater(accountId: string, folderId: string, ms = 20e3) {
    const k = `${accountId}|${folderId}`
    clearTimeout(this.syncSoon.get(k))
    this.syncSoon.set(k, setTimeout(() => { this.syncSoon.delete(k); this.syncFolder(accountId, folderId, false).catch(() => {}) }, ms))
  }

  startAll() {
    for (const a of this.accounts()) this.startAccount(a.id)
    this.schedulePoll()
    if (!this.ticker) this.ticker = setInterval(() => this.tick(), 1000)
  }

  /** Settings > General > Check for new messages: every N minutes, or only when asked (no live inbox either) */
  schedulePoll() {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    const every = this.settings().checkEvery
    if (every > 0) this.poll = setInterval(() => this.refresh().catch(() => {}), every * 60e3)
    for (const a of this.accounts()) {
      if (every > 0 && !this.idle.has(a.id) && this.state.get(a.id)?.state === 'online') this.startIdle(a.id)
      if (every === 0) { const i = this.idle.get(a.id); this.idle.delete(a.id); i?.close() }
    }
  }

  private async startAccount(id: string) {
    this.setState(id, 'connecting')
    try {
      await this.syncFolders(id)
      const inbox = this.folderByRole(id, 'inbox')
      if (inbox) await this.syncFolder(id, inbox.id, false)
      this.setState(id, 'online')
      this.prefetch(id).catch(() => {})
      if (this.settings().checkEvery > 0) this.startIdle(id)
      // the other important folders, quietly after the inbox (Sent completes the conversations)
      for (const role of ['sent', 'drafts', 'archive', 'trash'] as FolderRole[]) {
        const f = this.folderByRole(id, role)
        if (f) await this.syncFolder(id, f.id, false).catch(() => {})
      }
      const sz = this.snoozedFolder(id)
      if (sz) await this.syncFolder(id, sz.id, false).catch(() => {})
      this.backfill(id).catch(() => {})
    } catch (e) {
      const code = friendly(e)
      this.setState(id, transient(code) ? 'offline' : 'error', code)
      this.scheduleRetry(id)
    }
  }

  /**
   * all the older mail (29 Oct 2026): the first sync takes only the recent messages, this brings down the rest,
   * quietly after the start, folder by folder (Inbox first, Trash and Junk last), newest first, in batches of 200
   * between which new mail and actions get their turn. Each start picks up whatever is still missing.
   * Gmail's All Mail and Starred are left out: their messages are already in the other folders.
   */
  private async backfill(accountId: string) {
    if (this.backfilling.has(accountId)) return
    this.backfilling.add(accountId)
    try {
      for (const f of this.allFolders(accountId)) {
        if (!this.exists(accountId) || this.state.get(accountId)?.state !== 'online') return
        await this.backfillFolder(accountId, f.id).catch(() => {})
      }
    } finally {
      this.backfilling.delete(accountId)
    }
  }

  /** the folders the whole-mail download goes through, in its order */
  private allFolders(accountId: string): Row[] {
    const order = ['inbox', 'sent', 'archive', 'drafts', '', 'trash', 'spam']
    const rank = (f: Row) => order.indexOf(f.role || '')
    return (this.db.prepare(`select id, role from folders where account_id = ? and hidden = 0
      and (role is null or role not in ('all', 'flagged'))`).all(accountId) as Row[]).sort((a, b) => rank(a) - rank(b))
  }

  /**
   * Sync all messages, the whole mail (29 Oct 2026): every folder of the account (or of every account) brought down
   * in full now, the same work the background download does, started by hand; returns how many messages came
   */
  async syncEverything(accountId: string): Promise<number> {
    const ids = accountId === 'all' ? this.accounts().filter((a) => a.enabled).map((a) => a.id) : [accountId]
    let added = 0
    await Promise.all(ids.map(async (id) => {
      this.emit({ type: 'sync', accountId: id, busy: true })
      try {
        await this.syncFolders(id)
        for (const f of this.allFolders(id)) added += await this.backfillFolder(id, f.id, true).catch(() => 0)
      } finally {
        this.emit({ type: 'sync', accountId: id, busy: false })
      }
    }))
    return added
  }

  private async backfillFolder(accountId: string, folderId: string, byHand = false): Promise<number> {
    const path = () => (this.db.prepare('select path from folders where id = ?').get(folderId) as Row | undefined)?.path as string | undefined
    const missing = await this.run(accountId, async (c) => {
      const p = path()
      if (!p) return [] as number[]
      const lock = await c.getMailboxLock(p)
      try {
        const all = ((await c.search({ all: true }, { uid: true })) || []) as number[]
        const have = new Set((this.db.prepare('select uid from message_folders where folder_id = ?').all(folderId) as Row[]).map((r) => r.uid))
        return all.filter((u) => !have.has(u)).reverse()
      } finally { lock.release() }
    })
    if (!missing.length) return 0
    let added = 0
    const query: Row = { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true, headers: ['references', 'list-unsubscribe', 'list-id'] }
    if (this.accountRow(accountId).provider === 'gmail') query.threadId = true
    for (let i = 0; i < missing.length; i += 200) {
      if (!this.exists(accountId) || (!byHand && this.state.get(accountId)?.state !== 'online')) return added
      const stored = await this.run(accountId, async (c) => {
        const p = path()
        if (!p) return false
        const lock = await c.getMailboxLock(p)
        try {
          const batch: Row[] = []
          for await (const m of c.fetch(missing.slice(i, i + 200), query as any, { uid: true })) batch.push(m as any)
          added += this.storeFetched(accountId, folderId, batch).length
          return true
        } finally { lock.release() }
      })
      if (!stored) return added
      this.assignThreads(accountId)
      this.recount(folderId)
      this.emit({ type: 'messages', accountId })
      this.emit({ type: 'folders', accountId })
    }
    return added
  }

  /** what the account signs in with: its password, or for Sign in with Microsoft an access token, renewed before it runs out */
  private async cred(r: Row): Promise<Cred> {
    const secret = open(r.secret)
    if (!secret.startsWith(OAUTH_PREFIX)) return secret
    const had = this.tokens.get(r.id)
    if (had && had.expires > Date.now() + 120e3) return { accessToken: had.access }
    const t = await msRefresh(secret.slice(OAUTH_PREFIX.length))
    this.tokens.set(r.id, t)
    if (t.refresh !== secret.slice(OAUTH_PREFIX.length)) this.db.prepare('update accounts set secret = ? where id = ?').run(seal(OAUTH_PREFIX + t.refresh), r.id)
    return { accessToken: t.access }
  }

  /**
   * Sign in with Microsoft: the browser sign-in, then the account is tested and added like any other, with Microsoft's
   * servers; an account already there (signed out, or added with a password before) takes the new sign-in instead
   */
  async addMicrosoft(cfg: ServerConfig): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const tk = await msSignIn(cfg.email || undefined)
      const email = tk.email || cfg.email
      if (!email) return { ok: false, error: 'auth' }
      const c: ServerConfig = { ...cfg, email, username: email, displayName: cfg.displayName || tk.name }
      const tested = await this.test(c, { accessToken: tk.access })
      if (!tested.ok) return tested
      const old = this.db.prepare('select id from accounts where lower(email) = lower(?) and enabled = 1').get(email) as Row
      if (old) {
        this.db.prepare('update accounts set secret = ?, updated_at = ? where id = ?').run(seal(OAUTH_PREFIX + tk.refresh), now(), old.id)
        this.tokens.set(old.id, tk)
        this.stopAccount(old.id); this.startAccount(old.id)
        this.emit({ type: 'accounts' })
        return { ok: true }
      }
      const a = await this.add(tested.cfg, OAUTH_PREFIX + tk.refresh)
      this.tokens.set(a.id, tk)
      return { ok: true }
    } catch (e: any) {
      const m = String(e?.message || e)
      return { ok: false, error: /^ms_/.test(m) ? m : friendly(e) }
    }
  }

  private scheduleRetry(id: string, ms = 30e3) {
    clearTimeout(this.retry.get(id))
    this.retry.set(id, setTimeout(() => { if (this.exists(id)) this.startAccount(id) }, ms))
  }

  private exists(id: string) { return !!this.db.prepare('select 1 from accounts where id = ?').get(id) }

  /** a second connection that sits in IDLE on the inbox, so new mail shows up at once */
  private async startIdle(id: string) {
    this.idle.get(id)?.close()
    const r = this.accountRow(id)
    const cred = await this.cred(r).catch(() => null)
    if (!cred) { this.scheduleRetry(id); return }
    const c = new ImapFlow(imapOptions(this.cfgOf(r), cred))
    this.idle.set(id, c)
    let timer: NodeJS.Timeout | null = null
    c.on('error', () => {})
    c.on('exists', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const inbox = this.folderByRole(id, 'inbox')
        if (inbox) this.syncFolder(id, inbox.id, true).then(() => this.prefetch(id)).catch(() => {})
      }, 800)
    })
    c.on('close', () => {
      if (this.idle.get(id) !== c) return
      this.idle.delete(id)
      this.setState(id, 'offline')
      this.scheduleRetry(id, 15e3)
    })
    try {
      await c.connect()
      await c.mailboxOpen('INBOX')
    } catch {
      if (this.idle.get(id) === c) { this.idle.delete(id); this.scheduleRetry(id) }
    }
  }

  private stopAccount(id: string) {
    clearTimeout(this.retry.get(id))
    const i = this.idle.get(id); this.idle.delete(id); i?.close()
    const w = this.worker.get(id); this.worker.delete(id); w?.close()
    const g = this.fg.get(id); this.fg.delete(id); g?.close()
  }

  /** after sleep or a network change: drop every connection and start again */
  reconnectAll() {
    for (const a of this.accounts()) { this.stopAccount(a.id); this.startAccount(a.id) }
  }

  async refresh(accountId?: string) {
    const list = accountId ? [accountId] : this.accounts().map((a) => a.id)
    await Promise.all(list.map(async (id) => {
      this.emit({ type: 'sync', accountId: id, busy: true })
      try {
        await this.syncFolders(id)
        const inbox = this.folderByRole(id, 'inbox')
        if (inbox) await this.syncFolder(id, inbox.id, true)
        await this.prefetch(id)
        this.setState(id, 'online')
        if (!this.idle.has(id) && this.settings().checkEvery > 0) this.startIdle(id)
      } catch (e) {
        this.setState(id, 'offline', friendly(e))
      } finally {
        this.emit({ type: 'sync', accountId: id, busy: false })
      }
    }))
  }

  // ---------- folders ----------

  folders(accountId: string, hidden = false): Folder[] {
    const rows = this.db.prepare(`select * from folders where account_id = ? and hidden = ${hidden ? 1 : 0}`).all(accountId) as Row[]
    const order: Record<string, number> = { inbox: 0, snoozed: 1, flagged: 2, drafts: 3, sent: 4, archive: 5, all: 6, spam: 7, trash: 8 }
    return rows
      .map((r) => ({
        id: r.id, accountId, path: r.path, name: r.role === 'inbox' ? 'Inbox' : r.name, role: (r.role || r.special || null) as FolderRole | null, unread: r.unread, total: r.total,
        depth: r.delimiter ? r.path.split(r.delimiter).length - 1 : 0, color: r.color || null,
      }))
      .sort((a, b) => (a.role ? order[a.role] ?? 9 : 10) - (b.role ? order[b.role] ?? 9 : 10) || a.path.localeCompare(b.path))
  }

  // ---------- a folder's right-click menu ----------

  private folderRow(id: string): Row {
    const f = this.db.prepare('select * from folders where id = ?').get(id) as Row
    if (!f) throw new Error('folder not found')
    return f
  }

  /** a new folder at the top (in the server's namespace, e.g. Plesk's "INBOX.") or inside another */
  async createFolder(accountId: string, parentId: string | null, name: string) {
    const clean = String(name || '').trim().replace(/[\\/]/g, '-')
    if (!clean) throw new Error('name')
    const parent = parentId ? this.folderRow(parentId) : null
    await this.run(accountId, async (c) => {
      const delim = parent?.delimiter || (c as any).namespace?.delimiter || '/'
      const path = parent ? `${parent.path}${delim}${clean}` : `${(c as any).namespace?.prefix || ''}${clean}`
      await c.mailboxCreate(path)
    })
    await this.syncFolders(accountId)
  }

  async renameFolder(folderId: string, name: string) {
    const f = this.folderRow(folderId)
    const clean = String(name || '').trim().replace(/[\\/]/g, '-')
    if (!clean || f.role === 'inbox') return
    const cut = f.delimiter ? f.path.lastIndexOf(f.delimiter) : -1
    const to = cut >= 0 ? `${f.path.slice(0, cut + 1)}${clean}` : clean
    await this.run(f.account_id, (c) => c.mailboxRename(f.path, to))
    // the same row keeps its colour and settings under the new path
    this.db.prepare('update folders set path = ?, name = ? where id = ?').run(to, clean, folderId)
    await this.syncFolders(f.account_id)
  }

  /** the folder and everything in it go from the server (the window asks first) */
  async deleteFolder(folderId: string): Promise<'deleted' | 'hidden'> {
    const f = this.folderRow(folderId)
    if (f.role === 'inbox') return 'hidden'
    // the server says no ("Command failed") to deleting the folder that is open on the connection (Dovecot) and to a
    // folder with folders inside: the open one is closed first, the ones inside go first, deepest first (29 Oct 2026)
    const kids = f.delimiter ? (this.db.prepare('select id, path from folders where account_id = ?').all(f.account_id) as Row[])
      .filter((k) => k.path.startsWith(f.path + f.delimiter)).sort((a, b) => b.path.length - a.path.length) : []
    // some folders the server keeps for itself and never lets go (Outlook / Exchange "Sync Issues" and the ones inside,
    // Alex 29 Oct: "DELETE failed"): what the server refuses is hidden instead, and the person is told so
    const refused: string[] = []
    await this.run(f.account_id, async (c) => {
      for (const p of [...kids.map((k) => k.path as string), f.path]) {
        if ((c.mailbox as any)?.path === p) await c.mailboxClose()
        try { await c.mailboxDelete(p) } catch { refused.push(p) }
      }
    })
    if (refused.length) {
      for (const k of [...kids, f]) this.db.prepare('update folders set hidden = 1 where id = ?').run(k.id)
      this.emit({ type: 'folders', accountId: f.account_id })
      return 'hidden'
    }
    for (const k of [...kids, f]) {
      this.dropFolderMessages(k.id)
      this.db.prepare('delete from folders where id = ?').run(k.id)
    }
    await this.syncFolders(f.account_id)
    this.emit({ type: 'messages', accountId: f.account_id })
    return 'deleted'
  }

  folderAccount(folderId: string): string | null {
    return (this.db.prepare('select account_id from folders where id = ?').get(folderId) as Row)?.account_id || null
  }

  setFolderColor(folderId: string, color: string | null) {
    const ok = color && /^#[0-9a-f]{6}$/i.test(color) ? color : null
    this.db.prepare('update folders set color = ? where id = ?').run(ok, folderId)
    this.emit({ type: 'folders', accountId: this.folderRow(folderId).account_id })
  }

  hideFolder(folderId: string, hidden: boolean) {
    this.db.prepare('update folders set hidden = ? where id = ?').run(hidden ? 1 : 0, folderId)
    this.emit({ type: 'folders', accountId: this.folderRow(folderId).account_id })
  }

  /** every message in the folder read, here at once and on the server */
  /**
   * Statistics (29 Oct 2026): how full each mailbox is on the server (IMAP QUOTA, when the server tells), and from
   * what is downloaded: messages, unread, size, messages with attachments, the folders, the senders and the
   * biggest messages; for one account or every account, plus what RoarMail keeps on this computer
   */
  async stats(accountId: string): Promise<MailStats> {
    const accs = (this.db.prepare('select id, email, description, display_name, color from accounts where enabled = 1 order by sort').all() as Row[])
      .filter((a) => accountId === 'all' || a.id === accountId)
    const ids = accs.map((a) => a.id)
    const inIds = `(${ids.map(() => '?').join(',') || "''"})`
    const quota = async (id: string) => {
      try {
        const q: any = await Promise.race([
          this.run(id, (c) => (c as any).getQuota('INBOX')),
          new Promise((resolve) => setTimeout(() => resolve(null), 8e3)),
        ])
        const s = q?.storage
        return s && Number(s.limit) > 0 ? { used: Number(s.used ?? s.usage) || 0, limit: Number(s.limit) } : null
      } catch { return null }
    }
    const accounts = await Promise.all(accs.map(async (a) => {
      const t = this.db.prepare(`select count(*) n, coalesce(sum(1 - seen), 0) unread, coalesce(sum(size), 0) bytes,
        coalesce(sum(has_attachments), 0) att, coalesce(sum(case when has_attachments = 1 then size else 0 end), 0) attBytes
        from messages where account_id = ? and pending_op is null`).get(a.id) as Row
      const folders = (this.db.prepare(`select f.name, f.role, f.total, count(m.id) n, coalesce(sum(m.size), 0) bytes from folders f
        left join message_folders mf on mf.folder_id = f.id left join messages m on m.id = mf.message_id and m.pending_op is null
        where f.account_id = ? and f.hidden = 0 group by f.id order by bytes desc`).all(a.id) as Row[])
        .map((f) => ({ name: f.name as string, role: (f.role || null) as FolderRole | null, count: f.n as number, onServer: (f.total || 0) as number, bytes: f.bytes as number }))
      return {
        id: a.id as string, email: a.email as string, name: (a.description || a.display_name || '') as string, color: a.color as string,
        quota: await quota(a.id), messages: t.n as number, unread: t.unread as number, bytes: t.bytes as number,
        withAttachments: t.att as number, attachmentBytes: t.attBytes as number, folders,
      }
    }))
    const senders = (this.db.prepare(`select from_email email, max(from_name) name, count(*) n, coalesce(sum(size), 0) bytes,
      coalesce(sum(has_attachments), 0) att from messages where account_id in ${inIds} and pending_op is null and from_email <> ''
      group by from_email order by bytes desc limit 200`).all(...ids) as Row[])
      .map((s) => ({ email: s.email as string, name: (s.name || '') as string, count: s.n as number, bytes: s.bytes as number, withAttachments: s.att as number }))
    const biggest = (this.db.prepare(`select id, account_id, subject, from_name, from_email, size, date, has_attachments from messages
      where account_id in ${inIds} and pending_op is null and size is not null order by size desc limit 15`).all(...ids) as Row[])
      .map((m) => ({ id: m.id as string, accountId: m.account_id as string, subject: (m.subject || '') as string, from: (m.from_name || m.from_email || '') as string,
        bytes: m.size as number, date: m.date as number, attachments: !!m.has_attachments }))
    let cache = 0
    try { for (const f of fs.readdirSync(mailDir())) cache += fs.statSync(path.join(mailDir(), f)).size } catch { /* nothing kept yet */ }
    return { accounts, senders, biggest, cache }
  }

  /**
   * Empty Trash / Empty Junk (29 Oct 2026): everything in it deleted for good, on the server first; one account's
   * folder, or with a role alone the Trash (or Junk) of every account (the unified folder)
   */
  async emptyFolder(target: { folderId?: string; role?: 'trash' | 'spam' }) {
    const list = target.folderId ? [this.folderRow(target.folderId)]
      : this.db.prepare(`select f.* from folders f join accounts a on a.id = f.account_id where a.enabled = 1 and f.role = ?`).all(target.role || 'trash') as Row[]
    for (const f of list) {
      if (f.role !== 'trash' && f.role !== 'spam') continue
      await this.run(f.account_id, async (c) => {
        const lock = await c.getMailboxLock(f.path)
        try { if ((c.mailbox as any).exists) await c.messageDelete('1:*') } finally { lock.release() }
      })
      this.dropFolderMessages(f.id)
      this.recount(f.id)
      this.emit({ type: 'messages', accountId: f.account_id }); this.emit({ type: 'folders', accountId: f.account_id })
    }
    this.badge()
  }

  async markFolderRead(folderId: string) {
    const f = this.folderRow(folderId)
    this.db.prepare(`update messages set seen = 1 where id in (select message_id from message_folders where folder_id = ?)`).run(folderId)
    this.recount(folderId)
    this.emit({ type: 'messages', accountId: f.account_id }); this.emit({ type: 'folders', accountId: f.account_id })
    this.badge()
    await this.run(f.account_id, async (c) => {
      const lock = await c.getMailboxLock(f.path)
      try { if ((c.mailbox as any).exists) await c.messageFlagsAdd('1:*', ['\\Seen']) } finally { lock.release() }
    })
  }

  /** the whole folder: what the first sync left out (it takes the recent ones) comes down in batches */
  async syncFolderAll(folderId: string): Promise<number> {
    const f = this.folderRow(folderId)
    const gmail = this.accountRow(f.account_id).provider === 'gmail'
    this.emit({ type: 'sync', accountId: f.account_id, busy: true })
    let added = 0
    try {
      await this.run(f.account_id, async (c) => {
        const lock = await c.getMailboxLock(f.path)
        try {
          const all = ((await c.search({ all: true }, { uid: true })) || []) as number[]
          const have = new Set((this.db.prepare('select uid from message_folders where folder_id = ?').all(folderId) as Row[]).map((r) => r.uid))
          const missing = all.filter((u) => !have.has(u))
          const query: Row = { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true, headers: ['references', 'list-unsubscribe', 'list-id'] }
          if (gmail) query.threadId = true
          for (let i = 0; i < missing.length; i += 200) {
            const batch: Row[] = []
            for await (const m of c.fetch(missing.slice(i, i + 200), query as any, { uid: true })) batch.push(m as any)
            added += this.storeFetched(f.account_id, folderId, batch).length
          }
        } finally { lock.release() }
      })
      this.assignThreads(f.account_id)
      this.recount(folderId)
    } finally {
      this.emit({ type: 'sync', accountId: f.account_id, busy: false })
      this.emit({ type: 'messages', accountId: f.account_id }); this.emit({ type: 'folders', accountId: f.account_id })
    }
    return added
  }

  private folderByRole(accountId: string, role: FolderRole): Row | undefined {
    return this.db.prepare('select * from folders where account_id = ? and role = ?').get(accountId, role) as Row
  }

  private async syncFolders(accountId: string) {
    const list = await this.run(accountId, (c) => c.list({ statusQuery: { messages: true, unseen: true } }))
    const known = new Map((this.db.prepare('select id, path, role from folders where account_id = ?').all(accountId) as Row[]).map((r) => [r.path, r]))
    const seen = new Set<string>()
    const up = this.db.prepare(`insert into folders (id, account_id, path, name, delimiter, role, unread, total)
      values (@id, @account_id, @path, @name, @delimiter, @role, @unread, @total)
      on conflict(account_id, path) do update set name = excluded.name, role = excluded.role, total = excluded.total`)
    this.db.transaction(() => {
      for (const f of list) {
        if (f.flags?.has('\\Noselect') || f.flags?.has('\\NonExistent')) continue
        seen.add(f.path)
        const old = known.get(f.path)
        // a role we gave a folder ourselves (the Archive we created) stays
        const role = f.path.toUpperCase() === 'INBOX' ? 'inbox' : ROLE_BY_USE[f.specialUse as string] || old?.role || null
        up.run({
          id: old?.id || uuid(), account_id: accountId, path: f.path, name: f.name, delimiter: f.delimiter || null, role,
          unread: f.status?.unseen ?? 0, total: f.status?.messages ?? 0,
        })
      }
      for (const [p, r] of known) if (!seen.has(p)) this.db.prepare('delete from folders where id = ?').run(r.id)
    })()
    this.applyRoles(accountId)
    // folders never opened show the server's own unread count; synced ones count from the cache
    for (const f of this.db.prepare('select id, uidvalidity from folders where account_id = ?').all(accountId) as Row[]) {
      if (f.uidvalidity) this.recount(f.id)
      else {
        const s = list.find((x) => x.path === (this.db.prepare('select path from folders where id = ?').get(f.id) as Row).path)
        this.db.prepare('update folders set unread = ? where id = ?').run(s?.status?.unseen ?? 0, f.id)
      }
    }
    this.emit({ type: 'folders', accountId })
  }

  /** bring one folder up to date: new messages, changed flags, messages removed elsewhere */
  async syncFolder(accountId: string, folderId: string, announce: boolean) {
    const folder = this.db.prepare('select * from folders where id = ?').get(folderId) as Row
    if (!folder) return
    const acc = this.accountRow(accountId)
    const gmail = acc.provider === 'gmail'
    const fresh: MessageRow[] = []
    // new mail in an inbox (not the first download of the folder): what Settings > Rules look at
    const arrived: string[] = []
    await this.run(accountId, async (c) => {
      const lock = await c.getMailboxLock(folder.path)
      try {
        const mb = c.mailbox as any
        const uidValidity = Number(mb.uidValidity)
        if (folder.uidvalidity && folder.uidvalidity !== uidValidity) this.dropFolderMessages(folderId)
        const max = (this.db.prepare('select max(uid) m from message_folders where folder_id = ?').get(folderId) as Row).m as number | null
        let range: string | number[] | null = null
        if (max == null) {
          if (mb.exists) {
            const since = new Date(now() - acc.sync_days * 864e5)
            const uids = ((await c.search({ since }, { uid: true })) || []) as number[]
            range = uids.slice(-FIRST_SYNC_LIMIT)
            if (!range.length) range = null
          }
        } else if (mb.uidNext > max + 1) {
          range = `${max + 1}:*`
        }

        // flags of what we already have, and what disappeared on the server
        if (max != null) {
          const min = (this.db.prepare('select min(uid) m from message_folders where folder_id = ?').get(folderId) as Row).m as number
          const local = new Map((this.db.prepare(`select mf.uid, mf.message_id, m.pending_op from message_folders mf join messages m on m.id = mf.message_id
            where mf.folder_id = ?`).all(folderId) as Row[]).map((r) => [r.uid, r]))
          // flags with a change still waiting in the queue keep the local value
          const waiting = new Set((this.db.prepare(`select payload from operations where status in ('queued','running') and account_id = ?
            and kind in ('seen','unseen','flag','unflag')`).all(accountId) as Row[]).flatMap((o) => JSON.parse(o.payload).ids as string[]))
          const remote = new Set<number>()
          const setFlags = this.db.prepare('update messages set seen = ?, flagged = ?, answered = ? where id = ?')
          const updates: [number, number, number, string][] = []
          for await (const m of c.fetch(`${min}:${max}`, { uid: true, flags: true }, { uid: true })) {
            remote.add(m.uid)
            const l = local.get(m.uid)
            if (l && !waiting.has(l.message_id)) updates.push([m.flags?.has('\\Seen') ? 1 : 0, m.flags?.has('\\Flagged') ? 1 : 0, m.flags?.has('\\Answered') ? 1 : 0, l.message_id])
          }
          this.db.transaction(() => {
            for (const u of updates) setFlags.run(...u)
            for (const [uid, l] of local) if (!remote.has(uid) && !l.pending_op) this.deleteMessage(l.message_id)
          })()
        }

        if (range) {
          const query: Row = { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true, headers: ['references', 'list-unsubscribe', 'list-id'] }
          if (gmail) query.threadId = true
          const batch: Row[] = []
          for await (const m of c.fetch(range, query as any, { uid: true })) {
            if (max != null && m.uid <= max) continue
            batch.push(m as any)
          }
          for (const r of this.storeFetched(accountId, folderId, batch)) {
            if (announce && !r.seen) fresh.push(r)
            if (max != null) arrived.push(r.id)
          }
        }
        this.db.prepare('update folders set uidvalidity = ?, uidnext = ?, total = ? where id = ?').run(uidValidity, mb.uidNext || null, mb.exists || 0, folderId)
        this.recount(folderId)
      } finally {
        lock.release()
      }
    })
    this.assignThreads(accountId)
    this.emit({ type: 'messages', accountId })
    this.emit({ type: 'folders', accountId })
    if (folder.role === 'inbox') this.badge()
    if (folder.role === 'inbox') {
      const blocked = this.db.prepare(`select m.id from messages m join message_folders mf on mf.message_id = m.id join contacts c on c.email = m.from_email
        where mf.folder_id = ? and c.blocked = 1 and m.pending_op is null`).all(folderId) as Row[]
      if (blocked.length) {
        const gone = new Set(blocked.map((b) => b.id))
        for (let i = fresh.length - 1; i >= 0; i--) if (gone.has(fresh[i].id)) fresh.splice(i, 1)
        this.act([...gone], 'trash').catch(() => {})
      }
      // Settings > Rules on what just arrived; mail a rule moved or marked read does not notify
      if (arrived.length) {
        const handled = this.applyRules(arrived).quiet
        for (let i = fresh.length - 1; i >= 0; i--) if (handled.has(fresh[i].id)) fresh.splice(i, 1)
      }
    }
    if (fresh.length) {
      const tid = this.db.prepare('select thread_id from messages where id = ?')
      this.notify(accountId, fresh.map((r) => ({ ...r, threadId: (tid.get(r.id) as Row)?.thread_id || null })))
    }
  }

  /** headers fetched from a folder into the cache (new mail, or what a server search found) */
  private storeFetched(accountId: string, folderId: string, batch: Row[]): MessageRow[] {
    const out: MessageRow[] = []
    const ins = this.db.prepare(`insert into messages (id, account_id, message_id, in_reply_to, refs, gm_thrid, from_name, from_email, to_json, cc_json,
      reply_to, subject, snippet, date, seen, flagged, answered, has_attachments, size, list_unsubscribe, list_id, created_at)
      values (@id, @account_id, @message_id, @in_reply_to, @refs, @gm_thrid, @from_name, @from_email, @to_json, @cc_json,
      @reply_to, @subject, '', @date, @seen, @flagged, @answered, @has_attachments, @size, @list_unsubscribe, @list_id, @created_at)`)
    const link = this.db.prepare('insert or ignore into message_folders (message_id, folder_id, uid) values (?,?,?)')
    // the background download and a sync started by hand can fetch the same message: it is kept once
    const have = this.db.prepare('select 1 from message_folders where folder_id = ? and uid = ?')
    const contact = this.db.prepare(`insert into contacts (email, name, last_used, use_count) values (?,?,?,0)
      on conflict(email) do update set name = coalesce(contacts.name, excluded.name)`)
    this.db.transaction(() => {
      for (const m of batch) {
        if (have.get(folderId, m.uid)) continue
        const env = m.envelope || {}
        const from = env.from?.[0] || {}
        const headers = String(m.headers || '')
        const header = (name: string) => (headers.match(new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=\\r?\\n\\S|$)`, 'im')) || [])[1]?.replace(/\r?\n\s+/g, ' ').trim()
        const row = {
          id: uuid(), account_id: accountId, message_id: env.messageId || null, in_reply_to: env.inReplyTo || null,
          refs: header('references') || null, gm_thrid: m.threadId ? String(m.threadId) : null,
          from_name: from.name || '', from_email: (from.address || '').toLowerCase(),
          to_json: JSON.stringify(env.to || []), cc_json: JSON.stringify(env.cc || []), reply_to: env.replyTo?.[0]?.address || null,
          subject: env.subject || '', date: new Date(env.date || m.internalDate || now()).getTime(),
          seen: m.flags?.has('\\Seen') ? 1 : 0, flagged: m.flags?.has('\\Flagged') ? 1 : 0, answered: m.flags?.has('\\Answered') ? 1 : 0,
          has_attachments: hasAttachment(m.bodyStructure) ? 1 : 0, size: m.size || null,
          list_unsubscribe: header('list-unsubscribe') || null, list_id: header('list-id') || null, created_at: now(),
        }
        ins.run(row)
        link.run(row.id, folderId, m.uid)
        if (row.has_attachments) this.indexStructure(row.id, m.bodyStructure)
        if (row.from_email) contact.run(row.from_email, row.from_name || null, row.date)
        out.push(toRow(row))
      }
    })()
    return out
  }

  /** put new messages into conversations: Gmail's own thread id, else References / In-Reply-To */
  private assignThreads(accountId: string) {
    const rows = this.db.prepare(`select id, message_id, in_reply_to, refs, gm_thrid, subject, date from messages
      where account_id = ? and thread_id is null order by date`).all(accountId) as Row[]
    if (!rows.length) return
    const byGm = this.db.prepare('select thread_id from messages where account_id = ? and gm_thrid = ? and thread_id is not null limit 1')
    const byMsgId = this.db.prepare('select thread_id from messages where account_id = ? and message_id = ? and thread_id is not null limit 1')
    const byChild = this.db.prepare(`select thread_id from messages where account_id = ? and thread_id is not null
      and (in_reply_to = ? or instr(refs, ?) > 0) limit 1`)
    const newThread = this.db.prepare('insert into threads (id, account_id, gm_thrid, subject, last_date) values (?,?,?,?,?)')
    const set = this.db.prepare('update messages set thread_id = ? where id = ?')
    this.db.transaction(() => {
      for (const r of rows) {
        let tid: string | undefined
        if (r.gm_thrid) tid = (byGm.get(accountId, r.gm_thrid) as Row)?.thread_id
        if (!tid) {
          for (const p of [r.in_reply_to, ...msgIds(r.refs).reverse()].filter(Boolean)) {
            tid = (byMsgId.get(accountId, p) as Row)?.thread_id
            if (tid) break
          }
        }
        if (!tid && r.message_id) tid = (byChild.get(accountId, r.message_id, r.message_id) as Row)?.thread_id
        if (!tid) { tid = uuid(); newThread.run(tid, accountId, r.gm_thrid, r.subject, r.date) }
        set.run(tid, r.id)
      }
    })()
  }

  private recount(folderId: string) {
    this.db.prepare(`update folders set unread = (select count(*) from message_folders mf join messages m on m.id = mf.message_id
      where mf.folder_id = ? and m.seen = 0 and m.pending_op is null) where id = ?`).run(folderId, folderId)
  }

  private dropFolderMessages(folderId: string) {
    const ids = this.db.prepare('select message_id from message_folders where folder_id = ?').all(folderId) as Row[]
    this.db.transaction(() => { for (const r of ids) this.deleteMessage(r.message_id) })()
  }

  private deleteMessage(id: string) {
    this.db.prepare('delete from messages where id = ?').run(id)
    fs.rmSync(emlPath(id), { force: true })
  }

  /** the number on the Dock icon (Settings > General): unread in the inboxes, unread in every folder that holds mail, or none */
  badge() {
    const mode = this.settings().dockBadge
    const where = mode === 'all' ? `coalesce(f.role, '') not in ('trash', 'spam', 'sent', 'drafts')` : `f.role = 'inbox'`
    const n = mode === 'none' ? 0 : (this.db.prepare(`select count(distinct m.id) n from messages m join message_folders mf on mf.message_id = m.id
      join folders f on f.id = mf.folder_id where ${where} and ${ON} and m.seen = 0 and m.pending_op is null`).get() as Row).n as number
    try { app.setBadgeCount(n) } catch { /* not on this system */ }
  }

  // ---------- reading ----------

  /** the list: one row per conversation, its newest message on top */
  list(scope: ListScope, before?: number): MessageRow[] {
    // a sort other than by date has no paging: one longer page
    const byDate = !scope.sort || scope.sort === 'date'
    const limit = byDate ? 120 : 600
    const cut = before ?? (scope.oldest ? 0 : Number.MAX_SAFE_INTEGER)
    // the filter buttons: a conversation counts when any of its messages here does
    const having = scope.filter === 'unread' ? 'and unread_n > 0' : scope.filter === 'flagged' ? 'and flag_n > 0'
      : scope.filter === 'attachments' ? 'and att_n > 0' : scope.filter === 'today' ? 'and last_date >= @today'
      : scope.filter === 'threads' ? 'and n > 1' : ''
    const today = new Date(); today.setHours(0, 0, 0, 0)
    // a chosen day (the calendar button): from its start to the next
    const day = scope.day ? new Date(scope.day) : null
    if (day) day.setHours(0, 0, 0, 0)
    // the person button: everything from or to that address, in every folder but Trash and Junk
    const who = scope.person?.toLowerCase().trim()
    const where = who
      ? `(m.from_email = @who or instr(lower(m.to_json), @whoq) > 0 or instr(lower(m.cc_json), @whoq) > 0) and coalesce(f.role, '') not in ('trash', 'spam')
         ${scope.accountId === 'all' ? '' : 'and f.account_id = @account'}`
      : scope.folderId
        ? 'mf.folder_id = @folder'
        : `coalesce(f.special, f.role) = @role ${scope.accountId === 'all' ? '' : 'and f.account_id = @account'}`
    const dir = scope.oldest ? 'asc' : 'desc'
    const order = scope.sort === 'sender' ? `lower(coalesce(nullif(m.from_name, ''), m.from_email)) ${scope.oldest ? 'desc' : 'asc'}, last_date desc`
      : scope.sort === 'subject' ? `lower(m.subject) ${scope.oldest ? 'desc' : 'asc'}, last_date desc`
      : scope.sort === 'unread' ? `unread_n > 0 ${dir}, last_date desc`
      : scope.sort === 'attachments' ? `att_n > 0 ${dir}, last_date desc`
      : scope.sort === 'account' ? `m.account_id ${dir}, last_date desc`
      : `last_date ${dir}`
    const rows = this.db.prepare(`select m.*, max(m.date) as last_date, count(*) as n, sum(m.seen = 0) as unread_n,
        sum(m.flagged) as flag_n, sum(m.has_attachments) as att_n, group_concat(m.id) as ids
      from messages m join message_folders mf on mf.message_id = m.id join folders f on f.id = mf.folder_id
      where ${where} and ${ON} and m.pending_op is null ${day ? 'and m.date >= @dayFrom and m.date < @dayTo' : ''}
      group by coalesce(m.thread_id, m.id)
      having ${byDate ? (scope.oldest ? 'last_date > @cut' : 'last_date < @cut') : '1'} ${having}
      order by ${order} limit @limit`)
      .all({ folder: scope.folderId, role: scope.role || 'inbox', account: scope.accountId, cut, limit, today: today.getTime(),
        who: who || '', whoq: who ? `"${who}"` : '', dayFrom: day?.getTime() || 0, dayTo: day ? day.getTime() + 864e5 : 0 }) as Row[]
    return rows.map(toRow)
  }

  /** every message of a conversation in this account, in any folder, oldest first */
  thread(key: string): MessageRow[] {
    const isThread = !!this.db.prepare('select 1 from threads where id = ?').get(key)
    const rows = this.db.prepare(`select m.* from messages m where ${isThread ? 'm.thread_id = ?' : 'm.id = ?'} and m.pending_op is null
      group by coalesce(m.message_id, m.id) order by m.date`).all(key) as Row[]
    return rows.map(toRow)
  }

  /** opening a folder that was never synced fetches it first */
  async openFolder(folderId: string) {
    const f = this.db.prepare('select * from folders where id = ?').get(folderId) as Row
    if (f) await this.syncFolder(f.account_id, folderId, false)
  }

  private location(id: string): { folder: Row; uid: number } {
    const r = this.db.prepare(`select f.*, mf.uid as uid from message_folders mf join folders f on f.id = mf.folder_id where mf.message_id = ? limit 1`).get(id) as Row
    if (!r) throw new Error('message not on the server any more')
    return { folder: r, uid: r.uid }
  }

  private async source(id: string, accountId: string, background = false): Promise<Buffer> {
    const file = emlPath(id)
    if (fs.existsSync(file)) return fs.readFileSync(file)
    const { folder, uid } = this.location(id)
    const src = await (background ? this.run.bind(this) : this.runNow.bind(this))(accountId, async (c: ImapFlow) => {
      const lock = await c.getMailboxLock(folder.path)
      try {
        const m = await c.fetchOne(String(uid), { source: true }, { uid: true })
        return (m && (m as any).source) as Buffer
      } finally { lock.release() }
    })
    if (!src) throw new Error('message not found on the server')
    fs.writeFileSync(file, src)
    return src
  }

  private async parsed(id: string, background = false): Promise<{ row: Row; mail: ParsedMail }> {
    const row = this.db.prepare('select * from messages where id = ?').get(id) as Row
    if (!row) throw new Error('message not found')
    const mail = await simpleParser(await this.source(id, row.account_id, background))
    this.indexParsed(id, mail)
    if (row.body_text == null) {
      const text = mail.text || (mail.html ? String(mail.html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ') : '')
      this.db.prepare('update messages set body_text = ?, snippet = ? where id = ?').run(text, snippetOf(text), id)
    }
    return { row, mail }
  }

  /**
   * Files (29 Oct 2026, 0.22.0 showed none: attachments were only read when a message opened). A message's files go in
   * the attachments table three ways: from its structure when it is synced (named by file name until it is read),
   * in full when it is read (by position, as attachment() opens them), and for older mail in the background.
   */
  private indexParsed(id: string, mail: ParsedMail) {
    const files = mail.attachments.map((a, i) => ({ a, i })).filter(({ a }) => !(a.related || (a.contentDisposition === 'inline' && a.cid)) && !(isCalendar(a) && !a.filename))
    this.db.transaction(() => {
      this.db.prepare('delete from attachments where message_id = ?').run(id)
      const put = this.db.prepare(`insert or replace into attachments (id, message_id, filename, mime, size, content_id, part, inline) values (?,?,?,?,?,?,?,0)`)
      for (const { a, i } of files) put.run(`${id}:${i}`, id, a.filename || 'attachment', a.contentType || '', a.size || 0, a.cid || null, String(i))
      if (files.length) this.db.prepare('update messages set has_attachments = 1 where id = ?').run(id)
    })()
  }

  /** a message's files from its IMAP structure, before it is read */
  private indexStructure(id: string, node: any) {
    const out: { name: string; type: string; size: number; part: string }[] = []
    const walk = (n: any) => {
      if (!n) return
      if (Array.isArray(n.childNodes) && n.childNodes.length) { n.childNodes.forEach(walk); return }
      const name = n.dispositionParameters?.filename || n.parameters?.name
      if (n.disposition === 'attachment' || (name && n.disposition !== 'inline' && !String(n.type || '').startsWith('text/'))) out.push({ name: String(name || 'attachment'), type: String(n.type || ''), size: Number(n.size) || 0, part: String(n.part || '') })
    }
    walk(node)
    if (!out.length) return
    const put = this.db.prepare(`insert or ignore into attachments (id, message_id, filename, mime, size, part, inline) values (?,?,?,?,?,?,0)`)
    for (const f of out) put.run(`${id}:n:${f.name}`, id, f.name, f.type, f.size, f.part)
  }

  /** older mail with attachments that are not listed yet: their structure, folder by folder, in the background */
  private listingFiles = false
  async backfillAttachments() {
    if (this.listingFiles) return
    this.listingFiles = true
    try {
      const folders = this.db.prepare(`select distinct f.id, f.path, f.account_id from messages m join message_folders mf on mf.message_id = m.id join folders f on f.id = mf.folder_id
        where m.has_attachments = 1 and not exists (select 1 from attachments a where a.message_id = m.id) and f.account_id in (select id from accounts where enabled = 1)`).all() as Row[]
      for (const f of folders) {
        const rows = this.db.prepare(`select m.id, mf.uid from messages m join message_folders mf on mf.message_id = m.id
          where mf.folder_id = ? and m.has_attachments = 1 and not exists (select 1 from attachments a where a.message_id = m.id) order by m.date desc limit 3000`).all(f.id) as Row[]
        if (!rows.length) continue
        const byUid = new Map(rows.map((r) => [r.uid as number, r.id as string]))
        try {
          await this.run(f.account_id, async (c) => {
            const lock = await c.getMailboxLock(f.path)
            try {
              const uids = [...byUid.keys()]
              for (let i = 0; i < uids.length; i += 200) {
                const got: Row[] = []
                for await (const m of c.fetch(uids.slice(i, i + 200), { uid: true, bodyStructure: true } as any, { uid: true })) got.push(m as any)
                this.db.transaction(() => { for (const m of got) { const id = byUid.get(m.uid); if (id) this.indexStructure(id, m.bodyStructure) } })()
              }
            } finally { lock.release() }
          })
        } catch { /* that folder did not answer: next time */ }
      }
    } finally { this.listingFiles = false }
  }

  /** download the newest bodies in the background, for snippets and search */
  async prefetch(accountId: string) {
    // Settings > Accounts > Download attachments: every message, the newest ones, or none with attachments until opened
    const mode = (this.db.prepare('select attachments from accounts where id = ?').get(accountId) as Row)?.attachments || 'recent'
    const ids = this.db.prepare(`select m.id from messages m join message_folders mf on mf.message_id = m.id join folders f on f.id = mf.folder_id
      where m.account_id = ? and m.body_text is null and f.role = 'inbox' ${mode === 'none' ? 'and m.has_attachments = 0' : ''}
      order by m.date desc limit ?`).all(accountId, mode === 'all' ? PREFETCH * 5 : PREFETCH) as Row[]
    if (!ids.length) return
    for (const r of ids) { try { await this.parsed(r.id, true) } catch { /* next time */ } }
    this.emit({ type: 'messages', accountId })
  }

  async message(id: string): Promise<MessageFull> {
    const { row, mail } = await this.parsed(id)
    const fresh = this.db.prepare('select * from messages where id = ?').get(id) as Row
    if (!fresh.seen && this.settings().markRead === 'open') this.act([id], 'seen').catch(() => {})
    const contact = this.db.prepare('select images_allowed from contacts where email = ?').get(row.from_email) as Row
    const list = (a: any): Address[] => (a ? (Array.isArray(a) ? a : [a]).flatMap((x: any) => x.value || []) : [])
      .map((x: any) => ({ name: x.name || undefined, address: x.address || '' }))
    const refs = Array.isArray(mail.references) ? mail.references.join(' ') : mail.references
    return {
      ...toRow({ ...fresh, seen: this.settings().markRead === 'open' ? 1 : fresh.seen }),
      to: list(mail.to), cc: list(mail.cc), replyTo: mail.replyTo?.value?.[0]?.address,
      messageId: mail.messageId || row.message_id || undefined,
      references: refs || undefined,
      html: typeof mail.html === 'string' ? mail.html : undefined, text: mail.text || undefined,
      attachments: mail.attachments
        .map((a, i) => ({ id: `${id}:${i}`, filename: a.filename || 'attachment', mime: a.contentType, size: a.size,
          // the text/calendar alternative of an invitation is the invite card, not a file
          inline: !!(a.related || (a.contentDisposition === 'inline' && a.cid)) || (isCalendar(a) && !a.filename) }))
        .filter((a) => !a.inline),
      inlineImages: {},
      imagesAllowed: !!contact?.images_allowed && !this.settings().privacyMode,
      listUnsubscribe: row.list_unsubscribe || undefined,
      oneClickUnsubscribe: /one-click/i.test(String(mail.headers.get('list-unsubscribe-post') || '')),
      security: securityOf(mail, row.from_email || ''),
      senderBlocked: !!contact?.blocked,
      invite: this.inviteOf(row.account_id, mail),
    }
  }

  // ---------- calendar invitations ----------

  /** the account's own addresses (its email and aliases), for finding "me" among an invitation's attendees */
  private myAddresses(accountId: string): string[] {
    const r = this.accountRow(accountId)
    const aliases = (this.db.prepare('select email from identities where account_id = ?').all(accountId) as Row[]).map((x) => String(x.email))
    return [...new Set([r.email, ...aliases].map((x) => String(x).toLowerCase()))]
  }

  private calendarText(mail: ParsedMail): string | null {
    const parts = mail.attachments.filter(isCalendar)
    // the alternative (it carries METHOD) before an attached file
    const a = parts.find((x) => !x.filename) || parts[0]
    return a ? a.content.toString('utf8') : null
  }

  private inviteOf(accountId: string, mail: ParsedMail): Invite | null {
    const text = this.calendarText(mail)
    if (!text) return null
    try {
      const inv = readInvite(text, this.myAddresses(accountId))
      if (!inv) return null
      const local = inv.uid ? this.db.prepare('select answer from invite_answers where uid = ?').get(inv.uid) as Row | undefined : undefined
      return { ...inv, answer: (local?.answer as InviteAnswer) || inv.answer }
    } catch { return null }
  }

  /** the invitation's iCalendar text, for opening it in the system's calendar app */
  async calendarOf(id: string): Promise<string | null> {
    const { mail } = await this.parsed(id)
    return this.calendarText(mail)
  }

  /**
   * Accept / Maybe / Decline: an iMIP REPLY (METHOD:REPLY with this attendee's PARTSTAT) to the organizer, sent at
   * once through the account's outgoing server, as Apple Mail and Outlook do; the answer is kept for the card
   */
  async answerInvite(id: string, answer: InviteAnswer) {
    if (!['accepted', 'tentative', 'declined'].includes(answer)) throw new Error('answer')
    const { row, mail } = await this.parsed(id)
    const text = this.calendarText(mail)
    const mine = this.myAddresses(row.account_id)
    const inv = text ? readInvite(text, mine) : null
    if (!text || !inv) throw new Error('no-invite')
    if (!inv.organizer?.address) throw new Error('no-organizer')
    const r = this.accountRow(row.account_id)
    const address = attendeeFor(text, mine)
    const alias = this.db.prepare('select name from identities where account_id = ? and lower(email) = lower(?)').get(row.account_id, address) as Row | undefined
    const name = alias?.name || r.display_name || ''
    const word = answer === 'accepted' ? 'Accepted' : answer === 'tentative' ? 'Tentative' : 'Declined'
    const verb = answer === 'accepted' ? 'has accepted' : answer === 'tentative' ? 'might attend' : 'has declined'
    const composer = new MailComposer({
      from: name ? { name, address } : address, to: inv.organizer.address, subject: `${word}: ${inv.title}`,
      text: `${name || address} ${verb}: ${inv.title}`,
      icalEvent: { method: 'REPLY', content: buildReply(text, { name, address }, answer) },
      inReplyTo: mail.messageId || undefined, references: mail.messageId || undefined,
      messageId: `<${uuid()}@${r.email.split('@')[1] || 'roarmail.local'}>`, date: new Date(),
      headers: { 'X-Mailer': `RoarMail ${app.getVersion()}` },
    })
    const raw = await composer.compile().build()
    const t = smtpTransport(this.cfgOf(r), await this.cred(r))
    try { await t.sendMail({ envelope: composer.compile().getEnvelope(), raw }) } catch (e) { throw new Error(friendly(e)) } finally { t.close() }
    if (inv.uid) {
      this.db.prepare(`insert into invite_answers (uid, answer, answered_at) values (?,?,?)
        on conflict(uid) do update set answer = excluded.answer, answered_at = excluded.answered_at`).run(inv.uid, answer, now())
    }
  }

  /** the message exactly as the server has it (Save as .eml) */
  async rawSource(id: string): Promise<{ subject: string; source: Buffer }> {
    const row = this.db.prepare('select account_id, subject from messages where id = ?').get(id) as Row
    if (!row) throw new Error('message not found')
    return { subject: row.subject || '', source: await this.source(id, row.account_id) }
  }

  // ---------- unsubscribe and blocked senders ----------

  async unsubscribe(id: string): Promise<'done' | 'sent' | 'opened' | 'none'> {
    const { row, mail } = await this.parsed(id)
    const header = String(row.list_unsubscribe || mail.headers.get('list-unsubscribe') || '')
    const links = (header.match(/<([^>]+)>/g) || []).map((x) => x.slice(1, -1).trim())
    const web = links.find((l) => /^https:/i.test(l))
    const mailto = links.find((l) => /^mailto:/i.test(l))
    const oneClick = /one-click/i.test(String(mail.headers.get('list-unsubscribe-post') || ''))
    if (web && oneClick) {
      const r = await net.fetch(web, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })
      if (r.ok) return 'done'
    }
    if (mailto) {
      const u = new URL(mailto)
      this.send({ accountId: row.account_id, to: decodeURIComponent(u.pathname), subject: u.searchParams.get('subject') || 'unsubscribe',
        html: u.searchParams.get('body') || 'unsubscribe', text: u.searchParams.get('body') || 'unsubscribe' })
      return 'sent'
    }
    if (web || links.find((l) => /^http:/i.test(l))) { shell.openExternal((web || links.find((l) => /^http:/i.test(l)))!); return 'opened' }
    return 'none'
  }

  /** a blocked sender's new mail goes straight to Trash */
  blockSender(email: string, blocked: boolean) {
    this.db.prepare(`insert into contacts (email, blocked) values (?, ?) on conflict(email) do update set blocked = excluded.blocked`).run(email.toLowerCase(), blocked ? 1 : 0)
  }

  blockedSenders(): string[] {
    return (this.db.prepare('select email from contacts where blocked = 1 order by email').all() as Row[]).map((r) => r.email)
  }

  async attachment(attId: string): Promise<{ filename: string; content: Buffer }> {
    const cut = attId.indexOf(':')
    const id = attId.slice(0, cut), i = attId.slice(cut + 1)
    const { mail } = await this.parsed(id)
    // a file listed from the message's structure (Files, before the message was read) is found by its name
    const a = i.startsWith('n:') ? mail.attachments.find((x) => (x.filename || 'attachment') === i.slice(2)) : mail.attachments[Number(i)]
    if (!a) throw new Error('attachment not found')
    return { filename: (a.filename || 'attachment').replace(/[/\\:*?"<>|]/g, '_'), content: a.content }
  }

  search(query: string, accountId?: string): MessageRow[] {
    const s = this.settings()
    // Settings > Advanced > Exact match: whole words, else the start of words
    const terms = fold(query).trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"${s.exactSearch ? '' : '*'}`)
    if (!terms.length) return []
    // Settings > General: Trash and Junk in the results or not
    const skip = [s.searchTrash ? '' : `'trash'`, s.searchJunk ? '' : `'spam'`].filter(Boolean)
    const notIn = skip.length ? `and not exists (select 1 from message_folders mf join folders f on f.id = mf.folder_id where mf.message_id = m.id and f.role in (${skip.join(',')}))` : ''
    const rows = this.db.prepare(`select m.* from messages_fts s join messages m on m.rowid = s.rowid
      where messages_fts match @q ${accountId ? 'and m.account_id = @a' : ''} and m.account_id in (select id from accounts where enabled = 1)
      and m.pending_op is null ${notIn} order by m.date desc limit 200`)
      .all({ q: terms.join(' '), a: accountId }) as Row[]
    if (!s.searchConversations) return rows.map(toRow)
    // Settings > Advanced > Conversations in search results: one row per conversation, with all its messages
    const seen = new Set<string>()
    const out: MessageRow[] = []
    for (const r of rows) {
      const key = r.thread_id || r.id
      if (seen.has(key)) continue
      seen.add(key)
      const all = this.db.prepare(`select id, seen, flagged, has_attachments from messages where ${r.thread_id ? 'thread_id' : 'id'} = ? and pending_op is null`).all(key) as Row[]
      out.push({ ...toRow(r), ids: all.map((x) => x.id), count: all.length, seen: all.every((x) => x.seen), flagged: all.some((x) => x.flagged), hasAttachments: all.some((x) => x.has_attachments) })
    }
    return out
  }

  /** Settings > Advanced > Online search: the servers search too (inbox, sent, archive, all mail) and what they find is kept here */
  async searchOnline(query: string, accountId?: string): Promise<MessageRow[]> {
    const q = query.trim()
    if (q.length < 2) return this.search(query, accountId)
    const ids = accountId ? [accountId] : this.accounts().map((a) => a.id)
    await Promise.all(ids.map(async (id) => {
      const gmail = this.accountRow(id).provider === 'gmail'
      for (const role of ['inbox', 'sent', 'archive', 'all'] as FolderRole[]) {
        const f = this.folderByRole(id, role)
        if (!f) continue
        try {
          await this.run(id, async (c) => {
            const lock = await c.getMailboxLock(f.path)
            try {
              const found = ((await c.search({ or: [{ subject: q }, { from: q }, { body: q }] } as any, { uid: true })) || []) as number[]
              const have = new Set((this.db.prepare('select uid from message_folders where folder_id = ?').all(f.id) as Row[]).map((r) => r.uid))
              const missing = found.filter((u) => !have.has(u)).slice(-50)
              if (!missing.length) return
              const query: Row = { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true, headers: ['references', 'list-unsubscribe', 'list-id'] }
              if (gmail) query.threadId = true
              const batch: Row[] = []
              for await (const m of c.fetch(missing, query as any, { uid: true })) batch.push(m as any)
              this.storeFetched(id, f.id, batch)
            } finally { lock.release() }
          })
        } catch { /* that server or folder did not answer: the local results stand */ }
      }
      this.assignThreads(id)
    }))
    return this.search(query, accountId)
  }

  /** Settings > Advanced > Reset: every setting back to how RoarMail starts */
  resetSettings() {
    this.db.prepare('delete from settings').run()
    this.schedulePoll()
    this.badge()
  }

  /** Settings > Advanced > Clear the message cache: the downloaded copies go; they come back when opened */
  clearCache(): number {
    let freed = 0
    for (const f of fs.readdirSync(mailDir())) {
      const p = path.join(mailDir(), f)
      try { freed += fs.statSync(p).size; fs.rmSync(p, { force: true }) } catch { /* in use */ }
    }
    return freed
  }

  /**
   * Contacts: everyone who wrote or was written to (the contacts table, filled by sync and sending), with their card.
   * Automated senders (no-reply, notifications…) stay out unless the person did something with them.
   */
  contactList(query: string, group: string): Contact[] {
    const own = new Set((this.db.prepare('select lower(email) e from accounts').all() as Row[]).map((r) => r.e))
    const q = `%${fold(query.trim().toLowerCase())}%`
    // a group, an address ending ("@madlions.com": everyone at one company), people you write to, or the last 30 days
    const where = group === 'vip' ? 'and c.vip = 1' : group === 'blocked' ? 'and c.blocked = 1'
      : group === 'written' ? 'and c.use_count > 0 and c.blocked = 0'
      : group === 'recent' ? `and c.blocked = 0 and last > ${Date.now() - 30 * 864e5}`
      : group.startsWith('@') ? `and c.blocked = 0 and c.email like '%' || @group`
      : group ? `and instr(',' || c.groups || ',', ',' || @group || ',') > 0` : 'and c.blocked = 0'
    const rows = this.db.prepare(`select c.*, (select count(*) from messages m where m.from_email = c.email) as n,
        max(coalesce(c.last_used, 0), coalesce((select max(date) from messages m where m.from_email = c.email), 0)) as last
      from contacts c
      where (fold(c.email) like @q or fold(coalesce(c.name, '')) like @q or fold(coalesce(c.company, '')) like @q) ${where}
        and (c.vip = 1 or c.groups != '' or c.edited != '' or c.use_count > 0 or c.email not glob '*[nN][oO]*[rR][eE][pP][lL][yY]*'
          and c.email not like '%notification%' and c.email not like 'mailer-daemon%' and c.email not like '%bounce%')
      order by c.vip desc, (c.use_count > 0) desc, last desc limit 400`).all({ q, group }) as Row[]
    return rows.filter((r) => !own.has(r.email)).map(contactOf)
  }

  /** Files: every real attachment (not pictures inside the text), in every enabled account */
  files(query: string, kind: string, sort: 'date' | 'size', accountId: string): { files: MailFile[]; counts: Record<string, number>; indexing: boolean } {
    const q = `%${fold(query.trim().toLowerCase())}%`
    const rows = this.db.prepare(`select a.id, a.filename, a.size, a.mime, m.date, m.from_name, m.from_email, m.subject, m.account_id, m.id as mid
      from attachments a join messages m on m.id = a.message_id
      where a.inline = 0 and a.filename is not null and m.pending_op is null
        and m.account_id in (select id from accounts where enabled = 1) ${accountId !== 'all' ? 'and m.account_id = @acc' : ''}
        and (fold(a.filename) like @q or fold(coalesce(m.from_name, '')) like @q or fold(coalesce(m.from_email, '')) like @q or fold(m.subject) like @q)
      order by m.date desc limit 5000`).all({ q, acc: accountId }) as Row[]
    const all = rows.map((r): MailFile => ({ id: r.id, filename: r.filename, size: r.size || 0, mime: r.mime || '', kind: fileKind(r.filename, r.mime || ''),
      date: r.date, fromName: r.from_name || '', fromEmail: r.from_email || '', subject: r.subject || '', accountId: r.account_id, messageId: r.mid }))
    const counts: Record<string, number> = {}
    for (const f of all) counts[f.kind] = (counts[f.kind] || 0) + 1
    const pick = kind ? all.filter((f) => f.kind === kind) : all
    if (sort === 'size') pick.sort((a, b) => b.size - a.size)
    if (!this.filesListed) { this.filesListed = true; this.backfillAttachments().catch(() => { this.filesListed = false }) }
    return { files: pick.slice(0, 800), counts, indexing: this.listingFiles }
  }

  /** the companies in the address book: every address ending that is not a free mail service, with how many people */
  contactDomains(): { domain: string; count: number }[] {
    const own = new Set((this.db.prepare('select lower(email) e from accounts').all() as Row[]).map((r) => r.e))
    const counts = new Map<string, number>()
    for (const r of this.db.prepare(`select email from contacts where blocked = 0 and (use_count > 0 or vip = 1 or groups != '' or edited != ''
        or (select count(*) from messages m where m.from_email = contacts.email) > 0)`).all() as Row[]) {
      if (own.has(r.email) || /no-?reply|notification|mailer-daemon|bounce/i.test(r.email)) continue
      const d = String(r.email).split('@')[1]
      if (!d || PERSONAL.has(d)) continue
      counts.set(d, (counts.get(d) || 0) + 1)
    }
    return [...counts].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain)).slice(0, 60)
  }

  contactCard(email: string): ContactFull | null {
    const e = email.toLowerCase().trim()
    this.readSignatureOf(e)
    const r = this.db.prepare(`select c.*, (select count(*) from messages m where m.from_email = c.email) as n,
      (select max(date) from messages m where m.from_email = c.email) as last from contacts c where c.email = ?`).get(e) as Row | undefined
    if (!r) return null
    const files = (this.db.prepare(`select a.id, a.filename, a.size, a.mime, m.date from attachments a join messages m on m.id = a.message_id
      where m.from_email = ? and a.inline = 0 and a.filename is not null order by m.date desc limit 40`).all(e) as Row[])
      .map((f) => ({ id: f.id, filename: f.filename, size: f.size || 0, mime: f.mime || '', date: f.date }))
    return { ...contactOf(r), recent: this.list({ accountId: 'all', person: e }).slice(0, 12), files }
  }

  saveContact(email: string, patch: ContactPatch) {
    const e = email.toLowerCase().trim()
    this.db.prepare('insert into contacts (email) values (?) on conflict(email) do nothing').run(e)
    const cur = this.db.prepare('select edited from contacts where email = ?').get(e) as Row
    const edited = new Set(String(cur?.edited || '').split(',').filter(Boolean))
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'groups') this.db.prepare('update contacts set groups = ? where email = ?').run((v as string[]).filter((g) => /^[a-z]+$/.test(g)).join(','), e)
      else if (k === 'vip') this.db.prepare('update contacts set vip = ? where email = ?').run(v ? 1 : 0, e)
      else if (['name', 'phone', 'company', 'title', 'website', 'notes'].includes(k)) {
        this.db.prepare(`update contacts set ${k} = ? where email = ?`).run(String(v ?? '').trim() || null, e)
        edited.add(k)
      }
    }
    this.db.prepare('update contacts set edited = ? where email = ?').run([...edited].join(','), e)
  }

  /** fills what is empty on a card from fields read elsewhere; what the person typed is left alone */
  private fillCard(email: string, f: CardFields, mark = false) {
    const cur = this.db.prepare('select * from contacts where email = ?').get(email) as Row | undefined
    if (!cur) return
    const edited = new Set(String(cur.edited || '').split(',').filter(Boolean))
    for (const k of ['name', 'phone', 'company', 'title', 'website', 'notes'] as const) {
      const v = f[k]?.trim()
      if (!v || edited.has(k) || (cur[k] && !mark)) continue
      this.db.prepare(`update contacts set ${k} = ? where email = ?`).run(v, email)
      if (mark) edited.add(k)
    }
    if (mark) this.db.prepare('update contacts set edited = ? where email = ?').run([...edited].join(','), email)
  }

  /** the signature in a person's newest mail, read once per new mail from them */
  private readSignatureOf(email: string) {
    const c = this.db.prepare('select sig_checked from contacts where email = ?').get(email) as Row | undefined
    if (!c) return
    const msgs = this.db.prepare(`select from_name, body_text, date from messages where from_email = ? and body_text is not null and date > ?
      order by date desc limit 4`).all(email, c.sig_checked || 0) as Row[]
    if (!msgs.length) return
    for (const m of msgs) this.fillCard(email, readSignature(String(m.body_text), String(m.from_name || ''), email))
    this.db.prepare('update contacts set sig_checked = ? where email = ?').run(msgs[0].date, email)
  }

  /** people from another address book (.vcf / .csv): new ones are added, known ones get what they lacked */
  importContacts(cards: CardFields[]): number {
    let n = 0
    this.db.transaction(() => {
      for (const c of cards) for (const e of c.emails || []) {
        const email = e.toLowerCase().trim()
        if (!/^[^\s@]+@[^\s@]+$/.test(email)) continue
        this.db.prepare('insert into contacts (email, name) values (?, ?) on conflict(email) do nothing').run(email, c.name || null)
        this.fillCard(email, c)
        n++
      }
    })()
    return n
  }

  contacts(query: string): Address[] {
    const q = `%${query.trim().toLowerCase()}%`
    return (this.db.prepare(`select email, name from contacts where blocked = 0 and (email like ? or lower(name) like ?)
      order by use_count desc, last_used desc limit 8`).all(q, q) as Row[]).map((r) => ({ address: r.email, name: r.name || undefined }))
  }

  allowImages(sender: string) {
    this.db.prepare(`insert into contacts (email, images_allowed) values (?, 1) on conflict(email) do update set images_allowed = 1`).run(sender.toLowerCase())
  }

  // ---------- actions: local at once, then the queue ----------

  async act(ids: string[], action: Action, targetFolderId?: string, immediate = false): Promise<string | null> {
    if (!ids.length) return null
    const marks = ids.map(() => '?').join(',')
    const rows = this.db.prepare(`select m.id, m.account_id, f.id as folder_id, f.path, f.role, mf.uid from messages m
      join message_folders mf on mf.message_id = m.id join folders f on f.id = mf.folder_id where m.id in (${marks})`).all(...ids) as Row[]
    const groups = new Map<string, { accountId: string; folderId: string; path: string; role: string | null; uids: number[]; ids: string[] }>()
    for (const r of rows) {
      if (!groups.has(r.folder_id)) groups.set(r.folder_id, { accountId: r.account_id, folderId: r.folder_id, path: r.path, role: r.role, uids: [], ids: [] })
      groups.get(r.folder_id)!.uids.push(r.uid); groups.get(r.folder_id)!.ids.push(r.id)
    }
    const addOp = this.db.prepare(`insert into operations (id, account_id, kind, payload, status, created_at, run_at) values (?,?,?,?, 'queued', ?, ?)`)
    const accounts = new Set<string>()
    const tokens: string[] = []

    if (action === 'seen' || action === 'unseen' || action === 'flag' || action === 'unflag') {
      const col = action === 'seen' || action === 'unseen' ? 'seen' : 'flagged'
      const v = action === 'seen' || action === 'flag' ? 1 : 0
      const st = this.db.prepare(`update messages set ${col} = ? where id = ?`)
      this.db.transaction(() => {
        for (const id of ids) st.run(v, id)
        for (const g of groups.values()) {
          accounts.add(g.accountId)
          addOp.run(uuid(), g.accountId, action, JSON.stringify({ folderId: g.folderId, path: g.path, uids: g.uids, ids: g.ids }), now(), now())
          this.recount(g.folderId)
        }
      })()
    } else {
      const hide = this.db.prepare('update messages set pending_op = ? where id = ?')
      this.db.transaction(() => {
        for (const g of groups.values()) {
          let target: Row | undefined
          if (action === 'move') target = this.db.prepare('select * from folders where id = ? and account_id = ?').get(targetFolderId, g.accountId) as Row
          else target = this.folderByRole(g.accountId, action === 'archive' ? 'archive' : 'trash')
          if (action === 'move' && !target) continue
          if (target && target.id === g.folderId) continue
          // trash in Trash deletes for good; archive with no Archive folder makes one when the op runs
          const kind: MoveKind = action === 'trash' && g.role === 'trash' ? 'delete' : action === 'move' ? 'move' : action
          const opId = uuid()
          accounts.add(g.accountId)
          tokens.push(opId)
          for (const id of g.ids) hide.run(opId, id)
          addOp.run(opId, g.accountId, kind, JSON.stringify({ folderId: g.folderId, path: g.path, uids: g.uids, ids: g.ids, targetId: target?.id || null }), now(), now() + (immediate ? 0 : UNDO_MS))
          this.recount(g.folderId)
        }
      })()
    }
    for (const a of accounts) { this.emit({ type: 'messages', accountId: a }); this.emit({ type: 'folders', accountId: a }) }
    this.badge()
    setTimeout(() => this.tick(), 0)
    return tokens.length ? tokens.join(',') : null
  }

  /** bring back what an archive / trash / move hid, if it has not reached the server yet */
  undo(token: string): boolean {
    let ok = false
    const snoozes = this.snoozeTokens.get(token)
    if (snoozes) { for (const id of snoozes) this.db.prepare('delete from snoozed where id = ?').run(id); this.snoozeTokens.delete(token) }
    const accounts = new Set<string>()
    for (const opId of token.split(',')) {
      const op = this.db.prepare(`select * from operations where id = ? and status = 'queued'`).get(opId) as Row
      if (!op) continue
      this.db.transaction(() => {
        this.db.prepare('delete from operations where id = ?').run(opId)
        this.db.prepare('update messages set pending_op = null where pending_op = ?').run(opId)
        this.recount(JSON.parse(op.payload).folderId)
      })()
      accounts.add(op.account_id)
      ok = true
    }
    for (const a of accounts) { this.emit({ type: 'messages', accountId: a }); this.emit({ type: 'folders', accountId: a }) }
    this.badge()
    return ok
  }

  /** the runner: due operations per account (one at a time each), due sends, drafts for the server */
  private tick() {
    const ops = this.db.prepare(`select * from operations where status = 'queued' and run_at <= ? order by created_at`).all(now()) as Row[]
    for (const accountId of new Set(ops.map((o) => o.account_id as string))) {
      if (this.busyAccounts.has(accountId)) continue
      this.busyAccounts.add(accountId)
      const mine = ops.filter((o) => o.account_id === accountId)
      ;(async () => { for (const op of mine) await this.execOp(op) })().finally(() => this.busyAccounts.delete(accountId))
    }
    const due = this.db.prepare(`select * from outbox where status = 'queued' and send_at <= ?`).all(now()) as Row[]
    for (const o of due) if (!this.sending.has(o.id)) this.deliver(o)
    this.wakeSnoozed()
    this.checkReminders()
    if (now() - this.lastClean > 60 * 60e3) { this.lastClean = now(); this.eraseOld() }
    if (now() - this.lastDraftPush > 30e3) {
      const drafts = this.db.prepare(`select * from drafts where push = 1 and id not in (select draft_id from outbox)`).all() as Row[]
      if (drafts.length) { this.lastDraftPush = now(); for (const d of drafts) this.pushDraft(d).catch(() => {}) }
    }
  }

  /** Settings > Accounts: what sat in Trash or Junk longer than the chosen days goes for good (it arrived there when cached) */
  private eraseOld() {
    for (const a of this.db.prepare('select id, trash_days, junk_days from accounts where enabled = 1').all() as Row[]) {
      for (const [role, days] of [['trash', a.trash_days], ['spam', a.junk_days]] as [string, number][]) {
        if (!days) continue
        const old = this.db.prepare(`select m.id from messages m join message_folders mf on mf.message_id = m.id join folders f on f.id = mf.folder_id
          where f.account_id = ? and f.role = ? and m.created_at < ? and m.pending_op is null`).all(a.id, role, now() - days * 864e5) as Row[]
        // in Trash, trash means delete for good; Junk goes to Trash first
        if (old.length) this.act(old.map((r) => r.id), 'trash', undefined, true).catch(() => {})
      }
    }
  }

  private async execOp(op: Row) {
    const live = this.db.prepare(`select status from operations where id = ?`).get(op.id) as Row
    if (!live || live.status !== 'queued') return
    this.db.prepare(`update operations set status = 'running' where id = ?`).run(op.id)
    const p = JSON.parse(op.payload) as { folderId: string; path: string; uids: number[]; ids: string[]; targetId: string | null }
    const range = p.uids.join(',')
    const kind = op.kind as string
    try {
      let target: Row | undefined = p.targetId ? this.db.prepare('select * from folders where id = ?').get(p.targetId) as Row : undefined
      if (kind === 'archive' && !target) target = await this.ensureArchive(op.account_id)
      await this.run(op.account_id, async (c) => {
        const lock = await c.getMailboxLock(p.path)
        try {
          if (kind === 'seen') await c.messageFlagsAdd(range, ['\\Seen'], { uid: true })
          else if (kind === 'unseen') await c.messageFlagsRemove(range, ['\\Seen'], { uid: true })
          else if (kind === 'flag') await c.messageFlagsAdd(range, ['\\Flagged'], { uid: true })
          else if (kind === 'unflag') await c.messageFlagsRemove(range, ['\\Flagged'], { uid: true })
          else if (kind === 'delete' || (kind === 'trash' && !target)) await c.messageDelete(range, { uid: true })
          else if (target) await c.messageMove(range, target.path, { uid: true })
        } finally { lock.release() }
      })
      this.db.transaction(() => {
        if (!['seen', 'unseen', 'flag', 'unflag'].includes(kind)) {
          for (const r of this.db.prepare('select id from messages where pending_op = ?').all(op.id) as Row[]) this.deleteMessage(r.id)
        }
        this.db.prepare('delete from operations where id = ?').run(op.id)
      })()
      if (target) this.syncLater(op.account_id, target.id)
    } catch (e) {
      const code = friendly(e)
      if (transient(code)) {
        // offline: try again later, the change stays visible here meanwhile
        this.db.prepare(`update operations set status = 'queued', attempts = attempts + 1, run_at = ?, last_error = ? where id = ?`)
          .run(now() + Math.min(60e3 * (op.attempts + 1), 5 * 60e3), code, op.id)
      } else {
        this.db.transaction(() => {
          this.db.prepare(`update operations set status = 'failed', last_error = ? where id = ?`).run(code, op.id)
          this.db.prepare('update messages set pending_op = null where pending_op = ?').run(op.id)
          this.recount(p.folderId)
        })()
        this.emit({ type: 'opFailed', error: code })
        // the server's truth wins: read the folder again
        this.syncFolder(op.account_id, p.folderId, false).catch(() => {})
      }
    }
    this.emit({ type: 'messages', accountId: op.account_id })
    this.emit({ type: 'folders', accountId: op.account_id })
    this.badge()
  }

  /** servers without an Archive folder (most shared hosting) get one, like Airmail does */
  private async ensureArchive(accountId: string): Promise<Row | undefined> {
    const have = this.folderByRole(accountId, 'archive') || this.folderByRole(accountId, 'all')
    if (have) return have
    const existing = this.db.prepare(`select * from folders where account_id = ? and lower(name) = 'archive'`).get(accountId) as Row
    if (existing) {
      this.db.prepare(`update folders set role = 'archive' where id = ?`).run(existing.id)
      return existing
    }
    // servers with a personal namespace (Plesk's "INBOX.") want it in front of the name
    const created = await this.run(accountId, (c) => c.mailboxCreate(`${(c as any).namespace?.prefix || ''}Archive`)) as any
    const p = created?.path || 'Archive'
    const id = uuid()
    this.db.prepare(`insert into folders (id, account_id, path, name, role) values (?,?,?,?, 'archive')
      on conflict(account_id, path) do update set role = 'archive'`).run(id, accountId, p, 'Archive')
    this.emit({ type: 'folders', accountId })
    return this.folderByRole(accountId, 'archive')
  }

  // ---------- drafts ----------

  private draftRow(d: Draft, id: string, push: number) {
    this.db.prepare(`insert into drafts (id, account_id, identity_id, reply_to_message, mode, to_json, cc_json, bcc_json, subject, html, plain,
        attachments_json, replaces_message_id, push, updated_at)
      values (@id, @account_id, @identity, @reply, 'new', @to, @cc, @bcc, @subject, @html, 0, @atts, @replaces, @push, @updated)
      on conflict(id) do update set account_id = excluded.account_id, identity_id = excluded.identity_id, to_json = excluded.to_json, cc_json = excluded.cc_json,
        bcc_json = excluded.bcc_json, subject = excluded.subject, html = excluded.html, attachments_json = excluded.attachments_json,
        replaces_message_id = excluded.replaces_message_id, push = excluded.push, updated_at = excluded.updated_at`).run({
      id, account_id: d.accountId,
      identity: d.identityId && this.db.prepare('select 1 from identities where id = ? and account_id = ?').get(d.identityId, d.accountId) ? d.identityId : null,
      reply: d.replyToMessageId && this.db.prepare('select 1 from messages where id = ?').get(d.replyToMessageId) ? d.replyToMessageId : null,
      to: JSON.stringify({ to: d.to, inReplyTo: d.inReplyTo || null, references: d.references || null, text: d.text, priority: d.priority || null }),
      cc: d.cc || '', bcc: d.bcc || '', subject: d.subject, html: d.html, atts: JSON.stringify(d.attachments || []),
      replaces: d.replacesMessageId || null, push, updated: now(),
    })
  }

  private draftOf(r: Row): Draft {
    const meta = JSON.parse(r.to_json || '{}')
    return {
      id: r.id, accountId: r.account_id, identityId: r.identity_id || undefined, to: meta.to || '', cc: r.cc_json || '', bcc: r.bcc_json || '', subject: r.subject, html: r.html,
      text: meta.text || '', priority: meta.priority || undefined, inReplyTo: meta.inReplyTo || undefined, references: meta.references || undefined,
      replyToMessageId: r.reply_to_message || undefined, replacesMessageId: r.replaces_message_id || undefined,
      attachments: JSON.parse(r.attachments_json || '[]'),
    }
  }

  /** save while writing (toServer false), or put it in the server's Drafts folder when the composer closes */
  saveDraft(d: Draft, toServer: boolean): string {
    const id = d.id || uuid()
    this.draftRow(d, id, toServer ? 1 : 0)
    if (toServer) { this.lastDraftPush = 0; setTimeout(() => this.tick(), 0) }
    return id
  }

  discardDraft(id: string) {
    this.db.prepare('delete from drafts where id = ? and id not in (select draft_id from outbox)').run(id)
  }

  private async pushDraft(r: Row) {
    const d = this.draftOf(r)
    const folder = this.folderByRole(d.accountId, 'drafts')
    if (!folder) { this.db.prepare('update drafts set push = 0 where id = ?').run(r.id); return }
    const raw = await this.compose(d, `<${uuid()}@${this.accountRow(d.accountId).email.split('@')[1] || 'roarmail.local'}>`).compile().build()
    await this.run(d.accountId, (c) => c.append(folder.path, raw, ['\\Draft', '\\Seen']))
    this.db.prepare('delete from drafts where id = ?').run(r.id)
    if (d.replacesMessageId) this.dropServerMessage(d.replacesMessageId)
    this.syncFolder(d.accountId, folder.id, false).catch(() => {})
  }

  /** a message of the Drafts folder, back into the composer */
  async draftFromMessage(id: string): Promise<Draft> {
    const { row, mail } = await this.parsed(id)
    const addrs = (a: any) => (a ? (Array.isArray(a) ? a : [a]).flatMap((x: any) => x.value || []) : []).map((x: any) => fmtAddr({ name: x.name, address: x.address })).join(', ')
    const refs = Array.isArray(mail.references) ? mail.references.join(' ') : mail.references
    const html = typeof mail.html === 'string' ? mail.html : (mail.text || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)).replace(/\n/g, '<br>')
    return {
      accountId: row.account_id, to: addrs(mail.to), cc: addrs(mail.cc), bcc: addrs(mail.bcc), subject: mail.subject || '',
      html, text: mail.text || '', inReplyTo: mail.inReplyTo || undefined, references: refs || undefined, replacesMessageId: id,
    }
  }

  /** remove a message for good (an old draft): through the queue, no undo */
  private dropServerMessage(id: string) {
    const loc = this.db.prepare(`select m.account_id, f.id as folder_id, f.path, mf.uid from messages m join message_folders mf on mf.message_id = m.id
      join folders f on f.id = mf.folder_id where m.id = ?`).get(id) as Row
    if (!loc) return
    const opId = uuid()
    this.db.prepare('update messages set pending_op = ? where id = ?').run(opId, id)
    this.db.prepare(`insert into operations (id, account_id, kind, payload, status, created_at, run_at) values (?,?, 'delete', ?, 'queued', ?, ?)`)
      .run(opId, loc.account_id, JSON.stringify({ folderId: loc.folder_id, path: loc.path, uids: [loc.uid], ids: [id], targetId: null }), now(), now())
    this.emit({ type: 'messages', accountId: loc.account_id })
  }

  // ---------- sending: the outbox ----------

  private compose(d: Draft, messageId: string) {
    const r = this.accountRow(d.accountId)
    // an alias of the account (Settings > Accounts), else the account's own address
    const alias = d.identityId ? this.db.prepare('select email, name from identities where id = ? and account_id = ?').get(d.identityId, d.accountId) as Row : undefined
    const name = alias ? alias.name || r.display_name : r.display_name
    const address = alias ? alias.email : r.email
    return new MailComposer({
      from: name ? { name, address } : address,
      to: d.to || undefined, cc: d.cc || undefined, bcc: d.bcc || undefined, subject: d.subject,
      html: d.html, text: d.text, messageId, date: new Date(),
      inReplyTo: d.inReplyTo || undefined, references: d.references || undefined,
      priority: d.priority === 'high' || d.priority === 'low' ? d.priority : undefined,
      attachments: (d.attachments || []).filter((p) => fs.existsSync(p)).map((p) => ({ path: p, filename: path.basename(p) })),
      headers: { 'X-Mailer': `RoarMail ${app.getVersion()}` },
    })
  }

  send(d: Draft, opts: { at?: number; remindDays?: number } = {}): string {
    const id = d.id || uuid()
    this.draftRow(d, id, 0)
    const outId = uuid()
    const scheduled = !!opts.at && opts.at > now() + 30e3
    const at = scheduled ? opts.at! : now() + this.settings().undoSendSeconds * 1000
    this.db.prepare(`insert into outbox (id, draft_id, send_at, status, scheduled, remind_days) values (?,?,?, 'queued', ?, ?)`)
      .run(outId, id, at, scheduled ? 1 : 0, opts.remindDays || null)
    this.emit({ type: 'outbox' })
    if (!scheduled) setTimeout(() => this.tick(), at - now() + 50)
    return outId
  }

  cancelSend(outboxId: string): Draft | null {
    const o = this.db.prepare(`select * from outbox where id = ? and status in ('queued','failed')`).get(outboxId) as Row
    if (!o || this.sending.has(outboxId)) return null
    const r = this.db.prepare('select * from drafts where id = ?').get(o.draft_id) as Row
    this.db.prepare('delete from outbox where id = ?').run(outboxId)
    this.emit({ type: 'outbox' })
    return r ? this.draftOf(r) : null
  }

  /** a scheduled message goes out at another time (the Scheduled list's menu, Alex 29 Oct) */
  rescheduleSend(outboxId: string, at: number) {
    this.db.prepare(`update outbox set send_at = ?, scheduled = 1 where id = ? and status = 'queued'`).run(Math.max(now() + 30e3, Number(at) || 0), outboxId)
    this.emit({ type: 'outbox' })
  }

  retrySend(outboxId: string) {
    this.db.prepare(`update outbox set status = 'queued', send_at = ?, last_error = null, scheduled = 0 where id = ?`).run(now(), outboxId)
    this.emit({ type: 'outbox' })
    setTimeout(() => this.tick(), 0)
  }

  outbox(): OutboxItem[] {
    return (this.db.prepare(`select o.*, d.to_json, d.subject from outbox o join drafts d on d.id = o.draft_id order by o.send_at`).all() as Row[])
      .map((r) => ({ id: r.id, to: JSON.parse(r.to_json || '{}').to || '', subject: r.subject, sendAt: r.send_at, status: r.status, error: r.last_error || undefined, scheduled: !!r.scheduled }))
  }

  private async deliver(o: Row) {
    this.sending.add(o.id)
    this.db.prepare(`update outbox set status = 'sending' where id = ?`).run(o.id)
    this.emit({ type: 'outbox' })
    const dr = this.db.prepare('select * from drafts where id = ?').get(o.draft_id) as Row
    try {
      if (!dr) throw new Error('draft missing')
      const d = this.draftOf(dr)
      const r = this.accountRow(d.accountId)
      const domain = r.email.split('@')[1] || 'roarmail.local'
      const messageId = `<${uuid()}@${domain}>`
      const mail = this.compose(d, messageId)
      const raw = await mail.compile().build()
      const envelope = mail.compile().getEnvelope()
      const t = smtpTransport(this.cfgOf(r), await this.cred(r))
      try { await t.sendMail({ envelope, raw }) } finally { t.close() }

      // sent: the draft goes, the people written to are remembered for autocomplete
      this.db.prepare('delete from drafts where id = ?').run(dr.id)
      if (o.remind_days) {
        this.db.prepare(`insert into reminders (id, account_id, header_id, subject, recipients, remind_at, created_at) values (?,?,?,?,?,?,?)`)
          .run(uuid(), d.accountId, messageId, d.subject, [d.to, d.cc].filter(Boolean).join(', '), now() + o.remind_days * 864e5, now())
      }
      const up = this.db.prepare(`insert into contacts (email, name, last_used, use_count) values (?,?,?,1)
        on conflict(email) do update set last_used = excluded.last_used, use_count = contacts.use_count + 1`)
      for (const a of [d.to, d.cc, d.bcc].filter(Boolean).join(',').split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
        const m = a.match(/^(.*?)<([^>]+)>$/)
        up.run((m ? m[2] : a).trim().toLowerCase(), m ? m[1].replace(/"/g, '').trim() || null : null, now())
      }
      this.emit({ type: 'outbox' })

      // Gmail and Microsoft keep a copy in Sent by themselves; other servers need one put there
      const sent = this.folderByRole(d.accountId, 'sent')
      if (sent && r.provider !== 'gmail' && r.provider !== 'microsoft') {
        try {
          const copy = await this.compose({ ...d, bcc: undefined }, messageId).compile().build()
          await this.run(d.accountId, (c) => c.append(sent.path, copy, ['\\Seen']))
        } catch { /* sending worked; the copy is a nicety */ }
      }
      if (sent) this.syncFolder(d.accountId, sent.id, false).catch(() => {})
      if (d.replacesMessageId) this.dropServerMessage(d.replacesMessageId)
      if (d.replyToMessageId && this.db.prepare('select 1 from messages where id = ?').get(d.replyToMessageId)) {
        this.db.prepare('update messages set answered = 1 where id = ?').run(d.replyToMessageId)
        try {
          const { folder, uid } = this.location(d.replyToMessageId)
          await this.run(d.accountId, async (c) => {
            const lock = await c.getMailboxLock(folder.path)
            try { await c.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true }) } finally { lock.release() }
          })
        } catch { /* the reply went out */ }
      }
      this.emit({ type: 'messages', accountId: d.accountId })
    } catch (e) {
      const code = friendly(e)
      if (transient(code) && this.settings().retrySending) {
        this.db.prepare(`update outbox set status = 'queued', attempts = attempts + 1, send_at = ?, last_error = ? where id = ?`)
          .run(now() + Math.min(30e3 * (o.attempts + 1), 5 * 60e3), code, o.id)
      } else {
        this.db.prepare(`update outbox set status = 'failed', last_error = ? where id = ?`).run(code, o.id)
      }
      this.emit({ type: 'outbox' })
    } finally {
      this.sending.delete(o.id)
    }
  }

  // ---------- snooze and reminders ----------

  private snoozedFolder(accountId: string): Row | undefined {
    return this.db.prepare(`select * from folders where account_id = ? and special = 'snoozed'`).get(accountId) as Row
  }

  /** the server folder snoozed mail waits in; made once, like Airmail's */
  private async ensureSnoozed(accountId: string): Promise<Row> {
    const have = this.snoozedFolder(accountId)
    if (have) return have
    const named = this.db.prepare(`select * from folders where account_id = ? and lower(name) = 'snoozed'`).get(accountId) as Row
    if (named) { this.db.prepare(`update folders set special = 'snoozed' where id = ?`).run(named.id); return { ...named, special: 'snoozed' } }
    const created = await this.run(accountId, (c) => c.mailboxCreate(`${(c as any).namespace?.prefix || ''}Snoozed`)) as any
    const p = created?.path || 'Snoozed'
    this.db.prepare(`insert into folders (id, account_id, path, name, special) values (?,?,?,?, 'snoozed')
      on conflict(account_id, path) do update set special = 'snoozed'`).run(uuid(), accountId, p, 'Snoozed')
    this.emit({ type: 'folders', accountId })
    return this.snoozedFolder(accountId)!
  }

  async snooze(ids: string[], until: number | null): Promise<string | null> {
    const rows = this.db.prepare(`select m.*, f.path as folder_path from messages m join message_folders mf on mf.message_id = m.id
      join folders f on f.id = mf.folder_id where m.id in (${ids.map(() => '?').join(',')})`).all(...ids) as Row[]
    const tokens: string[] = []
    for (const accountId of new Set(rows.map((r) => r.account_id as string))) {
      const mine = rows.filter((r) => r.account_id === accountId)
      const folder = await this.ensureSnoozed(accountId)
      const made: string[] = []
      for (const r of mine) {
        if (!r.message_id) continue
        const id = uuid()
        this.db.prepare(`insert into snoozed (id, account_id, header_id, subject, from_name, until_at, origin_path, created_at) values (?,?,?,?,?,?,?,?)`)
          .run(id, accountId, r.message_id, r.subject || '', r.from_name || r.from_email || '', until, r.folder_path || 'INBOX', now())
        made.push(id)
      }
      const token = await this.act(mine.map((r) => r.id), 'move', folder.id)
      if (token) { this.snoozeTokens.set(token, made); tokens.push(token) }
    }
    this.emit({ type: 'outbox' })
    return tokens.length ? tokens.join(',') : null
  }

  snoozed(): SnoozedItem[] {
    return (this.db.prepare(`select * from snoozed where status = 'waiting' order by coalesce(until_at, 9e15)`).all() as Row[])
      .map((r) => ({ id: r.id, accountId: r.account_id, subject: r.subject, fromName: r.from_name, until: r.until_at ?? null }))
  }

  unsnooze(id: string) {
    this.db.prepare(`update snoozed set until_at = ? where id = ?`).run(now(), id)
    setTimeout(() => this.tick(), 0)
  }

  /** snoozed mail whose time has come goes back where it was, unread, with a notification */
  private wakeSnoozed() {
    const due = this.db.prepare(`select * from snoozed where status = 'waiting' and until_at is not null and until_at <= ?`).all(now()) as Row[]
    for (const s of due) {
      if (this.busyAccounts.has(s.account_id)) continue
      const folder = this.snoozedFolder(s.account_id)
      const msg = folder && this.db.prepare(`select m.id from messages m join message_folders mf on mf.message_id = m.id
        where mf.folder_id = ? and m.message_id = ? and m.pending_op is null limit 1`).get(folder.id, s.header_id) as Row
      if (!msg) {
        // not seen in Snoozed yet: read the folder once; if it is still not there, it was moved by hand
        if (folder && !this.wakeTried.has(s.id)) { this.wakeTried.add(s.id); this.syncFolder(s.account_id, folder.id, false).catch(() => {}); continue }
        this.db.prepare(`update snoozed set status = 'woken' where id = ?`).run(s.id)
        continue
      }
      const origin = this.db.prepare(`select * from folders where account_id = ? and path = ?`).get(s.account_id, s.origin_path) as Row
        || this.folderByRole(s.account_id, 'inbox')
      this.db.prepare(`update snoozed set status = 'woken' where id = ?`).run(s.id)
      if (!origin) continue
      this.act([msg.id], 'unseen').catch(() => {})
      this.act([msg.id], 'move', origin.id, true).catch(() => {})
      this.alert(s.from_name || 'RoarMail', `⏰ ${s.subject || ''}`)
      this.emit({ type: 'outbox' })
    }
  }

  /** a sent message nobody answered by the chosen day: a notification and a star on it */
  private checkReminders() {
    const due = this.db.prepare(`select * from reminders where status = 'waiting' and remind_at <= ?`).all(now()) as Row[]
    for (const r of due) {
      const acc = this.db.prepare('select email from accounts where id = ?').get(r.account_id) as Row
      const answered = this.db.prepare(`select 1 from messages where account_id = ? and from_email != ? and (in_reply_to = ? or instr(refs, ?) > 0) limit 1`)
        .get(r.account_id, (acc?.email || '').toLowerCase(), r.header_id, r.header_id)
      if (answered) { this.db.prepare(`update reminders set status = 'answered' where id = ?`).run(r.id); continue }
      this.db.prepare(`update reminders set status = 'done' where id = ?`).run(r.id)
      const sent = this.db.prepare('select id from messages where account_id = ? and message_id = ? limit 1').get(r.account_id, r.header_id) as Row
      if (sent) this.act([sent.id], 'flag').catch(() => {})
      this.alert(r.recipients || 'RoarMail', `🔔 ${r.subject || ''}`)
    }
  }

  // ---------- rules ----------

  rules(): Rule[] {
    return (this.db.prepare('select * from rules order by sort, rowid').all() as Row[])
      .map((r) => cleanRule({ id: r.id, name: r.name, enabled: !!r.enabled, match: r.match, conditions: json(r.conditions), actions: json(r.actions) }))
  }

  saveRule(x: Rule): Rule {
    const r = cleanRule(x)
    const old = r.id && this.db.prepare('select 1 from rules where id = ?').get(r.id)
    const id = old ? r.id : uuid()
    const name = r.name || 'Rule'
    if (old) {
      this.db.prepare('update rules set name = ?, enabled = ?, match = ?, conditions = ?, actions = ? where id = ?')
        .run(name, r.enabled ? 1 : 0, r.match, JSON.stringify(r.conditions), JSON.stringify(r.actions), id)
    } else {
      const sort = ((this.db.prepare('select max(sort) m from rules').get() as Row).m ?? -1) + 1
      this.db.prepare(`insert into rules (id, name, enabled, sort, applies, match, conditions, actions) values (?,?,?,?, 'incoming', ?,?,?)`)
        .run(id, name, r.enabled ? 1 : 0, sort, r.match, JSON.stringify(r.conditions), JSON.stringify(r.actions))
    }
    return { ...r, id, name }
  }

  deleteRule(id: string) { this.db.prepare('delete from rules where id = ?').run(id) }

  orderRules(ids: string[]) {
    const set = this.db.prepare('update rules set sort = ? where id = ?')
    this.db.transaction(() => { (Array.isArray(ids) ? ids : []).forEach((id, i) => set.run(i, String(id))) })()
  }

  /**
   * the rules over these messages (new mail, or a whole folder from its menu): mark read and star at once, moves and
   * archives through the queue a few seconds later, so the marks reach the server first. quiet: the messages moved or
   * marked read (no notification for them); changed: how many messages a rule did something to
   */
  applyRules(ids: string[]): { quiet: Set<string>; changed: number } {
    const quiet = new Set<string>()
    const touched = new Set<string>()
    const rules = this.rules().filter((r) => r.enabled && r.conditions.length && r.actions.length)
    if (!rules.length || !ids.length) return { quiet, changed: 0 }
    const read: string[] = [], flag: string[] = [], archive: string[] = []
    const moves = new Map<string, string[]>()
    const folderAccount = this.db.prepare('select account_id from folders where id = ?')
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500)
      const rows = this.db.prepare(`select id, account_id, from_name, from_email, to_json, cc_json, subject, has_attachments, list_id, seen, flagged
        from messages where id in (${part.map(() => '?').join(',')}) and pending_op is null`).all(...part) as Row[]
      for (const r of rows) {
        const people = [...json(r.to_json), ...json(r.cc_json)].map((a: any) => `${a?.name || ''} <${a?.address || ''}>`).join(', ')
        const p = plan(rules, { fromName: r.from_name || '', fromEmail: r.from_email || '', to: people, subject: r.subject || '', hasAttachments: !!r.has_attachments, listId: r.list_id || '' })
        if (p.read && !r.seen) { read.push(r.id); quiet.add(r.id); touched.add(r.id) }
        if (p.flag && !r.flagged) { flag.push(r.id); touched.add(r.id) }
        const to = p.moveTo && (folderAccount.get(p.moveTo) as Row | undefined)?.account_id === r.account_id ? p.moveTo : null
        if (p.archive) { archive.push(r.id); quiet.add(r.id); touched.add(r.id) }
        else if (to) { moves.set(to, [...(moves.get(to) || []), r.id]); quiet.add(r.id); touched.add(r.id) }
      }
    }
    const run = (list: string[], action: Action, target?: string) => {
      for (let i = 0; i < list.length; i += 500) this.act(list.slice(i, i + 500), action, target).catch(() => {})
    }
    run(read, 'seen'); run(flag, 'flag'); run(archive, 'archive')
    for (const [to, list] of moves) run(list, 'move', to)
    return { quiet, changed: touched.size }
  }

  /** Run Rules from a folder's right-click menu: every rule over everything in the folder now */
  runRules(folderId: string): number {
    const ids = (this.db.prepare(`select mf.message_id id from message_folders mf join messages m on m.id = mf.message_id
      where mf.folder_id = ? and m.pending_op is null`).all(folderId) as Row[]).map((r) => r.id as string)
    return this.applyRules(ids).changed
  }

  // ---------- templates ----------

  templates(): Template[] {
    return (this.db.prepare('select id, name, subject, html from templates order by created_at').all() as Row[])
      .map((r) => ({ id: r.id, name: r.name, subject: r.subject || '', html: r.html }))
  }

  saveTemplate(x: Template): Template {
    const id = x.id || uuid()
    const v = { id, name: String(x.name || '').trim().slice(0, 80) || 'Template', subject: String(x.subject || '').slice(0, 300), html: String(x.html || '') }
    this.db.prepare(`insert into templates (id, name, subject, html, created_at, updated_at) values (?,?,?,?,?,?)
      on conflict(id) do update set name = excluded.name, subject = excluded.subject, html = excluded.html, updated_at = excluded.updated_at`)
      .run(v.id, v.name, v.subject, v.html, now(), now())
    return v
  }

  deleteTemplate(id: string) { this.db.prepare('delete from templates where id = ?').run(id) }

  // ---------- signatures and settings ----------

  signatures(): Signature[] {
    return (this.db.prepare('select id, name, html from signatures order by created_at').all() as Row[]).map((r) => ({ id: r.id, name: r.name, html: r.html }))
  }

  saveSignature(s: Signature): Signature {
    const id = s.id || uuid()
    this.db.prepare(`insert into signatures (id, name, html, created_at, updated_at) values (?,?,?,?,?)
      on conflict(id) do update set name = excluded.name, html = excluded.html, updated_at = excluded.updated_at`).run(id, s.name, s.html, now(), now())
    this.emit({ type: 'accounts' })
    return { id, name: s.name, html: s.html }
  }

  deleteSignature(id: string) {
    this.db.prepare('delete from signatures where id = ?').run(id)
    this.emit({ type: 'accounts' })
  }

  settings(): Settings {
    const m = new Map((this.db.prepare('select key, value from settings').all() as Row[]).map((r) => [r.key, r.value]))
    const out: Record<string, unknown> = {}
    for (const [k, def] of Object.entries(SETTINGS)) {
      const v = m.get(k)
      out[k] = v == null ? def : typeof def === 'boolean' ? v === 'true' : typeof def === 'number' ? (Number.isFinite(Number(v)) ? Number(v) : def) : v
    }
    const s = out as unknown as Settings
    s.undoSendSeconds = Math.max(0, Math.min(30, s.undoSendSeconds))
    s.lockAfter = Math.max(0, s.lockAfter)
    s.radius = Math.max(4, Math.min(16, s.radius))
    s.textSize = Math.max(0, Math.min(4, s.textSize))
    s.checkEvery = [0, 1, 5, 15, 30, 60].includes(s.checkEvery) ? s.checkEvery : 5
    s.listSize = Math.max(11, Math.min(20, s.listSize))
    if (!['inbox', 'all', 'none'].includes(s.dockBadge)) s.dockBadge = 'inbox'
    if (!['inbox', 'known', 'none'].includes(s.notifyFor)) s.notifyFor = 'inbox'
    if (!['auto', 'el', 'en'].includes(s.language)) s.language = 'auto'
    if (!['both', 'dock', 'menubar'].includes(s.dockMode)) s.dockMode = 'both'
    if (!['open', 'delay', 'never'].includes(s.markRead)) s.markRead = 'open'
    // Privacy mode wins over the single switches
    if (s.privacyMode) { s.blockTrackers = true; s.stripTracking = true; s.senderPictures = false }
    s.previewLines = Math.max(0, Math.min(3, Math.round(s.previewLines)))
    if (!['oldest', 'newest'].includes(s.threadOrder)) s.threadOrder = 'oldest'
    for (const k of ['inboxCounter', 'folderCounter'] as const) if (!['unread', 'total', 'none'].includes(s[k])) s[k] = 'unread'
    if (!['system', 'dark', 'light'].includes(s.appearance)) s.appearance = 'system'
    if (!['simba', 'pumba'].includes(s.theme)) s.theme = 'simba'
    return s
  }

  setSetting(key: keyof Settings, value: unknown) {
    if (!(key in SETTINGS)) return
    this.db.prepare(`insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`).run(key, String(value))
    if (key === 'checkEvery') this.schedulePoll()
    if (key === 'dockBadge') this.badge()
  }
}
