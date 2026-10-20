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
import fs from 'fs'
import path from 'path'
import { app, net, shell } from 'electron'
import type { DB } from './store'
import { now, uuid } from './store'
import { seal, open } from './vault'
import type {
  Account, Action, Address, Draft, Folder, FolderRole, ListScope, MailEvent, MessageFull, MessageRow, OutboxItem,
  Security, ServerConfig, Settings, Signature, SnoozedItem,
} from '../shared/api'

const COLORS = ['#d40000', '#ff8a00', '#2f9bff', '#33c27f', '#b04cff', '#ff4fa3', '#00b8b0', '#c9a227']
const FIRST_SYNC_LIMIT = 300
const PREFETCH = 40
const POLL_MS = 5 * 60e3
const UNDO_MS = 5e3

type Row = Record<string, any>
type MoveKind = 'archive' | 'trash' | 'move' | 'delete'

const ROLE_BY_USE: Record<string, FolderRole> = {
  '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash', '\\Junk': 'spam',
  '\\Archive': 'archive', '\\All': 'all', '\\Flagged': 'flagged',
}

const mailDir = () => path.join(app.getPath('userData'), 'mail')
const emlPath = (id: string) => path.join(mailDir(), `${id}.eml`)

/** a list row from a grouped query (conversation) or a plain message row */
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

const toAccount = (r: Row, state: Account['state'], error?: string): Account => ({
  id: r.id, email: r.email, displayName: r.display_name, color: r.color, provider: r.provider,
  imapHost: r.imap_host, imapPort: r.imap_port, imapTls: r.imap_tls,
  smtpHost: r.smtp_host, smtpPort: r.smtp_port, smtpTls: r.smtp_tls, username: r.username,
  signatureId: r.signature_id || null, state, error,
})

// the text version of HTML mail carries [image: …] and [https://…] marks; a snippet reads better without them
const cleanText = (s: string) => s.replace(/\[(?:image:[^\]]*|https?:[^\]\s]*|cid:[^\]]*)\]/gi, ' ')
const snippetOf = (text: string) => cleanText(text).replace(/\s+/g, ' ').trim().slice(0, 220)
const msgIds = (s: string | null | undefined) => (s ? s.match(/<[^>]+>/g) || [] : [])
const fmtAddr = (a: Address) => (a.name ? `${a.name.replace(/[",]/g, '')} <${a.address}>` : a.address)

function hasAttachment(node: any): boolean {
  if (!node) return false
  if (node.disposition === 'attachment') return true
  return Array.isArray(node.childNodes) && node.childNodes.some(hasAttachment)
}

function imapOptions(cfg: { imapHost: string; imapPort: number; imapTls: string; username: string }, pass: string) {
  return {
    host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapTls === 'tls', doSTARTTLS: cfg.imapTls === 'starttls' ? true : undefined,
    auth: { user: cfg.username, pass }, logger: false as const, emitLogs: false,
    tls: { servername: cfg.imapHost }, connectionTimeout: 20e3, greetingTimeout: 15e3, socketTimeout: 5 * 60e3,
  }
}

function smtpTransport(cfg: { smtpHost: string; smtpPort: number; smtpTls: string; username: string }, pass: string) {
  return nodemailer.createTransport({
    host: cfg.smtpHost, port: cfg.smtpPort, secure: cfg.smtpTls === 'tls', requireTLS: cfg.smtpTls === 'starttls',
    auth: { user: cfg.username, pass }, tls: { servername: cfg.smtpHost }, connectionTimeout: 20e3,
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
  private idle = new Map<string, ImapFlow>()
  private state = new Map<string, { state: Account['state']; error?: string }>()
  private retry = new Map<string, NodeJS.Timeout>()
  private poll: NodeJS.Timeout | null = null
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

  accounts(): Account[] {
    return (this.db.prepare(`select a.*, i.signature_id from accounts a left join identities i on i.account_id = a.id and i.is_default = 1
      where a.enabled = 1 order by a.sort, a.created_at`).all() as Row[])
      .map((r) => { const s = this.state.get(r.id); return toAccount(r, s?.state || 'connecting', s?.error) })
  }

  async test(cfg: ServerConfig, password: string): Promise<{ ok: true; cfg: ServerConfig } | { ok: false; error: string }> {
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

  updateAccount(id: string, patch: { displayName?: string; color?: string; signatureId?: string | null }) {
    if (patch.displayName != null) {
      this.db.prepare('update accounts set display_name = ?, updated_at = ? where id = ?').run(patch.displayName, now(), id)
      this.db.prepare('update identities set name = ? where account_id = ? and is_default = 1').run(patch.displayName, id)
    }
    if (patch.color) this.db.prepare('update accounts set color = ?, updated_at = ? where id = ?').run(patch.color, now(), id)
    if (patch.signatureId !== undefined) this.db.prepare('update identities set signature_id = ? where account_id = ? and is_default = 1').run(patch.signatureId, id)
    this.emit({ type: 'accounts' })
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
        c = new ImapFlow(imapOptions(this.cfgOf(r), open(r.secret)))
        c.on('error', () => {})
        await c.connect()
        this.worker.set(accountId, c)
      }
      return fn(c)
    })
    this.queue.set(accountId, next)
    return next as Promise<T>
  }

  startAll() {
    for (const a of this.accounts()) this.startAccount(a.id)
    if (!this.poll) this.poll = setInterval(() => this.refresh().catch(() => {}), POLL_MS)
    if (!this.ticker) this.ticker = setInterval(() => this.tick(), 1000)
  }

  private async startAccount(id: string) {
    this.setState(id, 'connecting')
    try {
      await this.syncFolders(id)
      const inbox = this.folderByRole(id, 'inbox')
      if (inbox) await this.syncFolder(id, inbox.id, false)
      this.setState(id, 'online')
      this.prefetch(id).catch(() => {})
      this.startIdle(id)
      // the other important folders, quietly after the inbox (Sent completes the conversations)
      for (const role of ['sent', 'drafts', 'archive', 'trash'] as FolderRole[]) {
        const f = this.folderByRole(id, role)
        if (f) await this.syncFolder(id, f.id, false).catch(() => {})
      }
      const sz = this.snoozedFolder(id)
      if (sz) await this.syncFolder(id, sz.id, false).catch(() => {})
    } catch (e) {
      const code = friendly(e)
      this.setState(id, transient(code) ? 'offline' : 'error', code)
      this.scheduleRetry(id)
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
    const c = new ImapFlow(imapOptions(this.cfgOf(r), open(r.secret)))
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
        if (!this.idle.has(id)) this.startIdle(id)
      } catch (e) {
        this.setState(id, 'offline', friendly(e))
      } finally {
        this.emit({ type: 'sync', accountId: id, busy: false })
      }
    }))
  }

  // ---------- folders ----------

  folders(accountId: string): Folder[] {
    const rows = this.db.prepare('select * from folders where account_id = ? and hidden = 0').all(accountId) as Row[]
    const order: Record<string, number> = { inbox: 0, snoozed: 1, flagged: 2, drafts: 3, sent: 4, archive: 5, all: 6, spam: 7, trash: 8 }
    return rows
      .map((r) => ({
        id: r.id, accountId, path: r.path, name: r.role === 'inbox' ? 'Inbox' : r.name, role: (r.role || r.special || null) as FolderRole | null, unread: r.unread, total: r.total,
        depth: r.delimiter ? r.path.split(r.delimiter).length - 1 : 0,
      }))
      .sort((a, b) => (a.role ? order[a.role] ?? 9 : 10) - (b.role ? order[b.role] ?? 9 : 10) || a.path.localeCompare(b.path))
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
          const ins = this.db.prepare(`insert into messages (id, account_id, message_id, in_reply_to, refs, gm_thrid, from_name, from_email, to_json, cc_json,
            reply_to, subject, snippet, date, seen, flagged, answered, has_attachments, size, list_unsubscribe, created_at)
            values (@id, @account_id, @message_id, @in_reply_to, @refs, @gm_thrid, @from_name, @from_email, @to_json, @cc_json,
            @reply_to, @subject, '', @date, @seen, @flagged, @answered, @has_attachments, @size, @list_unsubscribe, @created_at)`)
          const link = this.db.prepare('insert or ignore into message_folders (message_id, folder_id, uid) values (?,?,?)')
          const contact = this.db.prepare(`insert into contacts (email, name, last_used, use_count) values (?,?,?,0)
            on conflict(email) do update set name = coalesce(contacts.name, excluded.name)`)
          const batch: Row[] = []
          const query: Row = { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true, headers: ['references', 'list-unsubscribe'] }
          if (gmail) query.threadId = true
          for await (const m of c.fetch(range, query as any, { uid: true })) {
            if (max != null && m.uid <= max) continue
            batch.push(m as any)
          }
          this.db.transaction(() => {
            for (const m of batch) {
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
                list_unsubscribe: header('list-unsubscribe') || null, created_at: now(),
              }
              ins.run(row)
              link.run(row.id, folderId, m.uid)
              if (row.from_email) contact.run(row.from_email, row.from_name || null, row.date)
              if (announce && !row.seen) fresh.push(toRow(row))
            }
          })()
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
    }
    if (fresh.length) {
      const tid = this.db.prepare('select thread_id from messages where id = ?')
      this.notify(accountId, fresh.map((r) => ({ ...r, threadId: (tid.get(r.id) as Row)?.thread_id || null })))
    }
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

  badge() {
    const n = (this.db.prepare(`select count(*) n from messages m join message_folders mf on mf.message_id = m.id
      join folders f on f.id = mf.folder_id where f.role = 'inbox' and m.seen = 0 and m.pending_op is null`).get() as Row).n as number
    try { app.setBadgeCount(n) } catch { /* not on this system */ }
  }

  // ---------- reading ----------

  /** the list: one row per conversation, its newest message on top */
  list(scope: ListScope, before?: number): MessageRow[] {
    const limit = 120
    const cut = before ?? Number.MAX_SAFE_INTEGER
    const where = scope.folderId
      ? 'mf.folder_id = @folder'
      : `f.role = @role ${scope.accountId === 'all' ? '' : 'and f.account_id = @account'}`
    const rows = this.db.prepare(`select m.*, max(m.date) as last_date, count(*) as n, sum(m.seen = 0) as unread_n,
        sum(m.flagged) as flag_n, sum(m.has_attachments) as att_n, group_concat(m.id) as ids
      from messages m join message_folders mf on mf.message_id = m.id join folders f on f.id = mf.folder_id
      where ${where} and m.pending_op is null
      group by coalesce(m.thread_id, m.id)
      having last_date < @cut
      order by last_date desc limit @limit`)
      .all({ folder: scope.folderId, role: scope.role || 'inbox', account: scope.accountId, cut, limit }) as Row[]
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

  private async source(id: string, accountId: string): Promise<Buffer> {
    const file = emlPath(id)
    if (fs.existsSync(file)) return fs.readFileSync(file)
    const { folder, uid } = this.location(id)
    const src = await this.run(accountId, async (c) => {
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

  private async parsed(id: string): Promise<{ row: Row; mail: ParsedMail }> {
    const row = this.db.prepare('select * from messages where id = ?').get(id) as Row
    if (!row) throw new Error('message not found')
    const mail = await simpleParser(await this.source(id, row.account_id))
    if (row.body_text == null) {
      const text = mail.text || (mail.html ? String(mail.html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ') : '')
      this.db.prepare('update messages set body_text = ?, snippet = ? where id = ?').run(text, snippetOf(text), id)
    }
    return { row, mail }
  }

  /** download the newest bodies in the background, for snippets and search */
  async prefetch(accountId: string) {
    const ids = this.db.prepare(`select m.id from messages m join message_folders mf on mf.message_id = m.id join folders f on f.id = mf.folder_id
      where m.account_id = ? and m.body_text is null and f.role = 'inbox' order by m.date desc limit ?`).all(accountId, PREFETCH) as Row[]
    if (!ids.length) return
    for (const r of ids) { try { await this.parsed(r.id) } catch { /* next time */ } }
    this.emit({ type: 'messages', accountId })
  }

  async message(id: string): Promise<MessageFull> {
    const { row, mail } = await this.parsed(id)
    const fresh = this.db.prepare('select * from messages where id = ?').get(id) as Row
    if (!fresh.seen) this.act([id], 'seen').catch(() => {})
    const contact = this.db.prepare('select images_allowed from contacts where email = ?').get(row.from_email) as Row
    const list = (a: any): Address[] => (a ? (Array.isArray(a) ? a : [a]).flatMap((x: any) => x.value || []) : [])
      .map((x: any) => ({ name: x.name || undefined, address: x.address || '' }))
    const refs = Array.isArray(mail.references) ? mail.references.join(' ') : mail.references
    return {
      ...toRow({ ...fresh, seen: 1 }),
      to: list(mail.to), cc: list(mail.cc), replyTo: mail.replyTo?.value?.[0]?.address,
      messageId: mail.messageId || row.message_id || undefined,
      references: refs || undefined,
      html: typeof mail.html === 'string' ? mail.html : undefined, text: mail.text || undefined,
      attachments: mail.attachments
        .map((a, i) => ({ id: `${id}:${i}`, filename: a.filename || 'attachment', mime: a.contentType, size: a.size, inline: !!(a.related || (a.contentDisposition === 'inline' && a.cid)) }))
        .filter((a) => !a.inline),
      inlineImages: {},
      imagesAllowed: !!contact?.images_allowed,
      listUnsubscribe: row.list_unsubscribe || undefined,
      oneClickUnsubscribe: /one-click/i.test(String(mail.headers.get('list-unsubscribe-post') || '')),
      security: securityOf(mail, row.from_email || ''),
      senderBlocked: !!contact?.blocked,
    }
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
    const [id, i] = attId.split(':')
    const { mail } = await this.parsed(id)
    const a = mail.attachments[Number(i)]
    if (!a) throw new Error('attachment not found')
    return { filename: (a.filename || 'attachment').replace(/[/\\:*?"<>|]/g, '_'), content: a.content }
  }

  search(query: string, accountId?: string): MessageRow[] {
    const terms = query.trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"*`)
    if (!terms.length) return []
    const rows = this.db.prepare(`select m.* from messages_fts s join messages m on m.rowid = s.rowid
      where messages_fts match @q ${accountId ? 'and m.account_id = @a' : ''} and m.pending_op is null order by m.date desc limit 200`)
      .all({ q: terms.join(' '), a: accountId }) as Row[]
    return rows.map(toRow)
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
    if (now() - this.lastDraftPush > 30e3) {
      const drafts = this.db.prepare(`select * from drafts where push = 1 and id not in (select draft_id from outbox)`).all() as Row[]
      if (drafts.length) { this.lastDraftPush = now(); for (const d of drafts) this.pushDraft(d).catch(() => {}) }
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
      if (target) this.syncFolder(op.account_id, target.id, false).catch(() => {})
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
    this.db.prepare(`insert into drafts (id, account_id, reply_to_message, mode, to_json, cc_json, bcc_json, subject, html, plain,
        attachments_json, replaces_message_id, push, updated_at)
      values (@id, @account_id, @reply, 'new', @to, @cc, @bcc, @subject, @html, 0, @atts, @replaces, @push, @updated)
      on conflict(id) do update set account_id = excluded.account_id, to_json = excluded.to_json, cc_json = excluded.cc_json,
        bcc_json = excluded.bcc_json, subject = excluded.subject, html = excluded.html, attachments_json = excluded.attachments_json,
        replaces_message_id = excluded.replaces_message_id, push = excluded.push, updated_at = excluded.updated_at`).run({
      id, account_id: d.accountId, reply: d.replyToMessageId && this.db.prepare('select 1 from messages where id = ?').get(d.replyToMessageId) ? d.replyToMessageId : null,
      to: JSON.stringify({ to: d.to, inReplyTo: d.inReplyTo || null, references: d.references || null, text: d.text }),
      cc: d.cc || '', bcc: d.bcc || '', subject: d.subject, html: d.html, atts: JSON.stringify(d.attachments || []),
      replaces: d.replacesMessageId || null, push, updated: now(),
    })
  }

  private draftOf(r: Row): Draft {
    const meta = JSON.parse(r.to_json || '{}')
    return {
      id: r.id, accountId: r.account_id, to: meta.to || '', cc: r.cc_json || '', bcc: r.bcc_json || '', subject: r.subject, html: r.html,
      text: meta.text || '', inReplyTo: meta.inReplyTo || undefined, references: meta.references || undefined,
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
    return new MailComposer({
      from: r.display_name ? { name: r.display_name, address: r.email } : r.email,
      to: d.to || undefined, cc: d.cc || undefined, bcc: d.bcc || undefined, subject: d.subject,
      html: d.html, text: d.text, messageId, date: new Date(),
      inReplyTo: d.inReplyTo || undefined, references: d.references || undefined,
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
      const t = smtpTransport(this.cfgOf(r), open(r.secret))
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
      if (transient(code)) {
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
    return {
      undoSendSeconds: Math.max(0, Math.min(30, Number(m.get('undoSendSeconds') ?? 5))),
      swipeLeft: (m.get('swipeLeft') || 'trash') as Settings['swipeLeft'],
      swipeRight: (m.get('swipeRight') || 'archive') as Settings['swipeRight'],
      blockTrackers: m.get('blockTrackers') !== 'false',
      stripTracking: m.get('stripTracking') !== 'false',
      lock: m.get('lock') === 'true',
      lockAfter: Math.max(0, Number(m.get('lockAfter') ?? 15)),
      appearance: (['dark', 'light'].includes(m.get('appearance')) ? m.get('appearance') : 'system') as Settings['appearance'],
      runAtLogin: m.get('runAtLogin') === 'true',
    }
  }

  setSetting(key: keyof Settings, value: unknown) {
    this.db.prepare(`insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`).run(key, String(value))
  }
}
