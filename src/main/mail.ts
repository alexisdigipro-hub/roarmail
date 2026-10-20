// The mail engine. Talks IMAP and SMTP straight from this computer to the user's own mail servers:
// no RoarMail server sits in between. Mail is cached in the local database (headers, text for search)
// and as .eml files (the full message, parsed again when opened).
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import { simpleParser, type ParsedMail } from 'mailparser'
import tls from 'tls'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { DB } from './store'
import { now, uuid } from './store'
import { seal, open } from './vault'
import type {
  Account, Action, Address, Draft, Folder, FolderRole, ListScope, MailEvent, MessageFull, MessageRow, ServerConfig,
} from '../shared/api'

const COLORS = ['#d40000', '#ff8a00', '#2f9bff', '#33c27f', '#b04cff', '#ff4fa3', '#00b8b0', '#c9a227']
const FIRST_SYNC_LIMIT = 300
const PREFETCH = 40
const POLL_MS = 5 * 60e3

type Row = Record<string, any>

const ROLE_BY_USE: Record<string, FolderRole> = {
  '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash', '\\Junk': 'spam',
  '\\Archive': 'archive', '\\All': 'all', '\\Flagged': 'flagged',
}

const mailDir = () => path.join(app.getPath('userData'), 'mail')
const emlPath = (id: string) => path.join(mailDir(), `${id}.eml`)

const toRow = (r: Row): MessageRow => ({
  id: r.id, accountId: r.account_id, fromName: r.from_name || '', fromEmail: r.from_email || '',
  subject: r.subject || '', snippet: r.snippet || '', date: r.date,
  seen: !!r.seen, flagged: !!r.flagged, answered: !!r.answered, hasAttachments: !!r.has_attachments,
})

const toAccount = (r: Row, state: Account['state'], error?: string): Account => ({
  id: r.id, email: r.email, displayName: r.display_name, color: r.color, provider: r.provider,
  imapHost: r.imap_host, imapPort: r.imap_port, imapTls: r.imap_tls,
  smtpHost: r.smtp_host, smtpPort: r.smtp_port, smtpTls: r.smtp_tls, username: r.username, state, error,
})

const snippetOf = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 220)

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
  if (/ETIMEDOUT|timeout|ECONNREFUSED|ECONNRESET/i.test(m)) return 'network'
  if (/certificate|altname|self.signed/i.test(m)) return 'certificate'
  return m.slice(0, 300)
}

export class MailService {
  private worker = new Map<string, ImapFlow>()
  private queue = new Map<string, Promise<unknown>>()
  private idle = new Map<string, ImapFlow>()
  private state = new Map<string, { state: Account['state']; error?: string }>()
  private retry = new Map<string, NodeJS.Timeout>()
  private poll: NodeJS.Timeout | null = null

  constructor(private db: DB, private emit: (e: MailEvent) => void, private notify: (accountId: string, rows: MessageRow[]) => void) {
    fs.mkdirSync(mailDir(), { recursive: true })
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
    return (this.db.prepare('select * from accounts where enabled = 1 order by sort, created_at').all() as Row[])
      .map((r) => { const s = this.state.get(r.id); return toAccount(r, s?.state || 'connecting', s?.error) })
  }

  async test(cfg: ServerConfig, password: string): Promise<{ ok: true; cfg: ServerConfig } | { ok: false; error: string }> {
    let c = { ...cfg }
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

  async remove(id: string) {
    this.stopAccount(id)
    const ids = this.db.prepare('select id from messages where account_id = ?').all(id) as Row[]
    this.db.prepare('delete from accounts where id = ?').run(id)
    for (const r of ids) fs.rmSync(emlPath(r.id), { force: true })
    this.state.delete(id)
    this.emit({ type: 'accounts' })
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
      // the other important folders, quietly after the inbox
      for (const role of ['sent', 'drafts', 'archive', 'trash'] as FolderRole[]) {
        const f = this.folderByRole(id, role)
        if (f) await this.syncFolder(id, f.id, false).catch(() => {})
      }
    } catch (e) {
      this.setState(id, friendly(e) === 'network' || friendly(e) === 'host' ? 'offline' : 'error', friendly(e))
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
    const order: Record<string, number> = { inbox: 0, flagged: 1, drafts: 2, sent: 3, archive: 4, all: 5, spam: 6, trash: 7 }
    return rows
      .map((r) => ({
        id: r.id, accountId, path: r.path, name: r.role === 'inbox' ? 'Inbox' : r.name, role: r.role, unread: r.unread, total: r.total,
        depth: r.delimiter ? r.path.split(r.delimiter).length - 1 : 0,
      }))
      .sort((a, b) => (a.role ? order[a.role] ?? 9 : 10) - (b.role ? order[b.role] ?? 9 : 10) || a.path.localeCompare(b.path))
  }

  private folderByRole(accountId: string, role: FolderRole): Row | undefined {
    return this.db.prepare('select * from folders where account_id = ? and role = ?').get(accountId, role) as Row
  }

  private async syncFolders(accountId: string) {
    const list = await this.run(accountId, (c) => c.list({ statusQuery: { messages: true, unseen: true } }))
    const known = new Map((this.db.prepare('select id, path from folders where account_id = ?').all(accountId) as Row[]).map((r) => [r.path, r.id]))
    const seen = new Set<string>()
    const up = this.db.prepare(`insert into folders (id, account_id, path, name, delimiter, role, unread, total)
      values (@id, @account_id, @path, @name, @delimiter, @role, @unread, @total)
      on conflict(account_id, path) do update set name = excluded.name, role = excluded.role, unread = excluded.unread, total = excluded.total`)
    this.db.transaction(() => {
      for (const f of list) {
        if (f.flags?.has('\\Noselect') || f.flags?.has('\\NonExistent')) continue
        seen.add(f.path)
        const role = f.path.toUpperCase() === 'INBOX' ? 'inbox' : ROLE_BY_USE[f.specialUse as string] || null
        up.run({
          id: known.get(f.path) || uuid(), account_id: accountId, path: f.path, name: f.name, delimiter: f.delimiter || null, role,
          unread: f.status?.unseen ?? 0, total: f.status?.messages ?? 0,
        })
      }
      for (const [p, id] of known) if (!seen.has(p)) this.db.prepare('delete from folders where id = ?').run(id)
    })()
    this.emit({ type: 'folders', accountId })
  }

  /** bring one folder up to date: new messages, changed flags, messages removed elsewhere */
  async syncFolder(accountId: string, folderId: string, announce: boolean) {
    const folder = this.db.prepare('select * from folders where id = ?').get(folderId) as Row
    if (!folder) return
    const acc = this.accountRow(accountId)
    const fresh: MessageRow[] = []
    await this.run(accountId, async (c) => {
      const lock = await c.getMailboxLock(folder.path)
      try {
        const mb = c.mailbox as any
        const uidValidity = Number(mb.uidValidity)
        if (folder.uidvalidity && folder.uidvalidity !== uidValidity) {
          this.dropFolderMessages(folderId)
        }
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

        // flags of what we already have, and what disappeared
        if (max != null) {
          const min = (this.db.prepare('select min(uid) m from message_folders where folder_id = ?').get(folderId) as Row).m as number
          const local = new Map((this.db.prepare('select uid, message_id from message_folders where folder_id = ?').all(folderId) as Row[]).map((r) => [r.uid, r.message_id]))
          const remote = new Set<number>()
          const setFlags = this.db.prepare('update messages set seen = ?, flagged = ?, answered = ? where id = ?')
          const updates: [number, number, number, string][] = []
          for await (const m of c.fetch(`${min}:${max}`, { uid: true, flags: true }, { uid: true })) {
            remote.add(m.uid)
            const id = local.get(m.uid)
            if (id) updates.push([m.flags?.has('\\Seen') ? 1 : 0, m.flags?.has('\\Flagged') ? 1 : 0, m.flags?.has('\\Answered') ? 1 : 0, id])
          }
          this.db.transaction(() => {
            for (const u of updates) setFlags.run(...u)
            for (const [uid, id] of local) if (!remote.has(uid)) this.deleteMessage(id)
          })()
        }

        if (range) {
          const ins = this.db.prepare(`insert into messages (id, account_id, message_id, in_reply_to, refs, from_name, from_email, to_json, cc_json,
            reply_to, subject, snippet, date, seen, flagged, answered, has_attachments, size, list_unsubscribe, created_at)
            values (@id, @account_id, @message_id, @in_reply_to, @refs, @from_name, @from_email, @to_json, @cc_json,
            @reply_to, @subject, '', @date, @seen, @flagged, @answered, @has_attachments, @size, @list_unsubscribe, @created_at)`)
          const link = this.db.prepare('insert or ignore into message_folders (message_id, folder_id, uid) values (?,?,?)')
          const contact = this.db.prepare(`insert into contacts (email, name, last_used, use_count) values (?,?,?,0)
            on conflict(email) do update set name = coalesce(contacts.name, excluded.name)`)
          const batch: Row[] = []
          for await (const m of c.fetch(range, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true, headers: ['references', 'list-unsubscribe'] }, { uid: true })) {
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
                refs: header('references') || null, from_name: from.name || '', from_email: (from.address || '').toLowerCase(),
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
    this.emit({ type: 'messages', accountId })
    this.emit({ type: 'folders', accountId })
    if (folder.role === 'inbox') this.badge()
    if (fresh.length) this.notify(accountId, fresh)
  }

  private recount(folderId: string) {
    this.db.prepare(`update folders set unread = (select count(*) from message_folders mf join messages m on m.id = mf.message_id
      where mf.folder_id = ? and m.seen = 0) where id = ?`).run(folderId, folderId)
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
      join folders f on f.id = mf.folder_id where f.role = 'inbox' and m.seen = 0`).get() as Row).n as number
    try { app.setBadgeCount(n) } catch { /* not on this system */ }
  }

  // ---------- messages ----------

  list(scope: ListScope, before?: number): MessageRow[] {
    const limit = 120
    const cut = before ?? Number.MAX_SAFE_INTEGER
    let rows: Row[]
    if (scope.folderId) {
      rows = this.db.prepare(`select m.* from messages m join message_folders mf on mf.message_id = m.id
        where mf.folder_id = ? and m.date < ? order by m.date desc limit ?`).all(scope.folderId, cut, limit) as Row[]
    } else {
      const role = scope.role || 'inbox'
      const accountFilter = scope.accountId === 'all' ? '' : 'and f.account_id = @account'
      rows = this.db.prepare(`select m.* from messages m join message_folders mf on mf.message_id = m.id join folders f on f.id = mf.folder_id
        where f.role = @role ${accountFilter} and m.date < @cut order by m.date desc limit @limit`)
        .all({ role, account: scope.accountId, cut, limit }) as Row[]
    }
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
    return {
      ...toRow({ ...fresh, seen: 1 }),
      to: list(mail.to), cc: list(mail.cc), replyTo: mail.replyTo?.value?.[0]?.address,
      messageId: mail.messageId || row.message_id || undefined,
      html: typeof mail.html === 'string' ? mail.html : undefined, text: mail.text || undefined,
      attachments: mail.attachments
        .map((a, i) => ({ id: `${id}:${i}`, filename: a.filename || 'attachment', mime: a.contentType, size: a.size, inline: !!(a.related || (a.contentDisposition === 'inline' && a.cid)) }))
        .filter((a) => !a.inline),
      inlineImages: {},
      imagesAllowed: !!contact?.images_allowed,
      listUnsubscribe: row.list_unsubscribe || undefined,
    }
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
      where messages_fts match @q ${accountId ? 'and m.account_id = @a' : ''} order by m.date desc limit 200`)
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

  // ---------- actions ----------

  async act(ids: string[], action: Action) {
    // group by account and folder, change the cache at once, then tell the server
    const groups = new Map<string, { accountId: string; folder: Row; uids: number[]; ids: string[] }>()
    for (const id of ids) {
      const r = this.db.prepare(`select m.account_id, f.*, mf.uid as uid from messages m join message_folders mf on mf.message_id = m.id
        join folders f on f.id = mf.folder_id where m.id = ?`).get(id) as Row
      if (!r) continue
      const key = r.id as string
      if (!groups.has(key)) groups.set(key, { accountId: r.account_id, folder: r, uids: [], ids: [] })
      groups.get(key)!.uids.push(r.uid); groups.get(key)!.ids.push(id)
    }
    const flagCol = action === 'seen' || action === 'unseen' ? 'seen' : action === 'flag' || action === 'unflag' ? 'flagged' : null
    if (flagCol) {
      const v = action === 'seen' || action === 'flag' ? 1 : 0
      const st = this.db.prepare(`update messages set ${flagCol} = ? where id = ?`)
      this.db.transaction(() => { for (const id of ids) st.run(v, id) })()
    }
    const accounts = new Set<string>()
    for (const g of groups.values()) {
      accounts.add(g.accountId)
      const range = g.uids.join(',')
      if (flagCol) {
        const flag = flagCol === 'seen' ? '\\Seen' : '\\Flagged'
        const add = action === 'seen' || action === 'flag'
        this.recount(g.folder.id)
        await this.run(g.accountId, async (c) => {
          const lock = await c.getMailboxLock(g.folder.path)
          try { add ? await c.messageFlagsAdd(range, [flag], { uid: true }) : await c.messageFlagsRemove(range, [flag], { uid: true }) } finally { lock.release() }
        })
        continue
      }
      const target = this.folderByRole(g.accountId, action === 'archive' ? 'archive' : 'trash')
        || (action === 'archive' ? this.folderByRole(g.accountId, 'all') : undefined)
      if (target && target.id === g.folder.id) continue
      this.db.transaction(() => { for (const id of g.ids) this.deleteMessage(id) })()
      this.recount(g.folder.id)
      this.emit({ type: 'messages', accountId: g.accountId })
      await this.run(g.accountId, async (c) => {
        const lock = await c.getMailboxLock(g.folder.path)
        try {
          if (target) await c.messageMove(range, target.path, { uid: true })
          else if (action === 'trash') await c.messageDelete(range, { uid: true })
          else throw new Error('no-archive')
        } finally { lock.release() }
      })
      if (target) this.syncFolder(g.accountId, target.id, false).catch(() => {})
    }
    for (const a of accounts) { this.emit({ type: 'messages', accountId: a }); this.emit({ type: 'folders', accountId: a }) }
    this.badge()
  }

  // ---------- sending ----------

  async send(d: Draft) {
    const r = this.accountRow(d.accountId)
    const pass = open(r.secret)
    const domain = r.email.split('@')[1] || 'roarmail.local'
    const messageId = `<${uuid()}@${domain}>`
    const opts = {
      from: r.display_name ? { name: r.display_name, address: r.email } : r.email,
      to: d.to, cc: d.cc || undefined, bcc: d.bcc || undefined, subject: d.subject,
      html: d.html, text: d.text, messageId, date: new Date(),
      inReplyTo: d.inReplyTo || undefined, references: d.references || undefined,
      attachments: (d.attachments || []).map((p) => ({ path: p, filename: path.basename(p) })),
      headers: { 'X-Mailer': `RoarMail ${app.getVersion()}` },
    }
    const t = smtpTransport(this.cfgOf(r), pass)
    try { await t.sendMail(opts) } catch (e) { throw new Error(friendly(e)) } finally { t.close() }

    // remember the people written to, for autocomplete
    const addrs = [d.to, d.cc, d.bcc].filter(Boolean).join(',').split(/[,;]/).map((x) => x.trim()).filter(Boolean)
    const up = this.db.prepare(`insert into contacts (email, name, last_used, use_count) values (?,?,?,1)
      on conflict(email) do update set last_used = excluded.last_used, use_count = contacts.use_count + 1`)
    for (const a of addrs) {
      const m = a.match(/^(.*?)<([^>]+)>$/)
      up.run((m ? m[2] : a).trim().toLowerCase(), m ? m[1].replace(/"/g, '').trim() || null : null, now())
    }

    // Gmail and Microsoft keep a copy in Sent by themselves; other servers need one put there
    if (r.provider !== 'gmail' && r.provider !== 'microsoft') {
      const sent = this.folderByRole(d.accountId, 'sent')
      if (sent) {
        try {
          const raw = await new MailComposer({ ...opts, bcc: undefined }).compile().build()
          await this.run(d.accountId, (c) => c.append(sent.path, raw, ['\\Seen']))
        } catch { /* sending worked; the copy is a nicety */ }
      }
    }
    if (d.replyToMessageId) {
      try {
        const { folder, uid } = this.location(d.replyToMessageId)
        this.db.prepare('update messages set answered = 1 where id = ?').run(d.replyToMessageId)
        await this.run(d.accountId, async (c) => {
          const lock = await c.getMailboxLock(folder.path)
          try { await c.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true }) } finally { lock.release() }
        })
      } catch { /* the reply went out */ }
    }
    this.emit({ type: 'messages', accountId: d.accountId })
  }
}
