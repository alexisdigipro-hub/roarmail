// RoarMail in the cloud, for RoarMe (Edge Function roarmail-cloud, in RoarMe's Supabase project beside roarmail-ai).
// Alex, 24 Nov 2026: "pass the mail through the cloud too, so it pulls them and starts working". RoarMail on the computer
// hands one account's password (or Sign in with Microsoft's refresh token) here with Send to RoarMe; it is checked
// against the mail server and kept in Supabase Vault (supabase/roarmail-cloud.sql). RoarMe then asks this function for
// that account's folders' mail. Mail is read from the server each time and never stored. Only the signed-in owner of
// an account reaches it.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { ImapFlow } from 'npm:imapflow@2.5.8'
import PostalMime from 'npm:postal-mime@2.4.4'
import nodemailer from 'npm:nodemailer@6.9.16'
import MailComposer from 'npm:nodemailer@6.9.16/lib/mail-composer/index.js'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const URL_ = Deno.env.get('SUPABASE_URL')!
const sb = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })

// RoarMail's own app registration in Microsoft Entra (a public client: the id is not a secret)
const MS_CLIENT = '1449effc-2b8b-443b-9523-e2f84dd6b677'
const MS_SCOPE = 'offline_access openid email profile https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send'

type Cfg = { imap_host: string; imap_port: number; imap_tls: string; smtp_host?: string; smtp_port?: number; smtp_tls?: string; username: string; kind?: string }

const str = (v: unknown, n = 300) => String(v ?? '').slice(0, n)
function cleanCfg(c: any): Cfg {
  const host = str(c?.imap_host, 255).trim().toLowerCase()
  if (!/^[a-z0-9.-]+$/.test(host) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('This mail server cannot be reached from the cloud.')
  const port = Number(c?.imap_port) || 993
  if (![993, 143].includes(port)) throw new Error('Only IMAP on port 993 or 143 works from the cloud.')
  return {
    imap_host: host, imap_port: port, imap_tls: c?.imap_tls === 'starttls' ? 'starttls' : 'tls',
    smtp_host: str(c?.smtp_host, 255).trim().toLowerCase(), smtp_port: Number(c?.smtp_port) || 465, smtp_tls: str(c?.smtp_tls, 20),
    username: str(c?.username, 320).trim(), kind: c?.kind === 'microsoft' ? 'microsoft' : 'password',
  }
}

async function msToken(refresh: string) {
  const r = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: MS_CLIENT, scope: MS_SCOPE, grant_type: 'refresh_token', refresh_token: refresh }).toString(),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) throw Object.assign(new Error('Microsoft sign-in expired. Send this account to RoarMe again from RoarMail.'), { auth: true })
  return { access: j.access_token as string, refresh: (j.refresh_token as string) || refresh }
}

function client(cfg: Cfg, cred: { pass?: string; access?: string }) {
  const c = new ImapFlow({
    host: cfg.imap_host, port: cfg.imap_port, secure: cfg.imap_tls === 'tls', doSTARTTLS: cfg.imap_tls === 'starttls' ? true : undefined,
    auth: cred.access ? { user: cfg.username, accessToken: cred.access } : { user: cfg.username, pass: cred.pass || '' },
    logger: false, emitLogs: false, tls: { servername: cfg.imap_host }, connectionTimeout: 15e3, greetingTimeout: 12e3, socketTimeout: 60e3,
  } as any)
  c.on('error', () => {})
  return c
}
const authFail = (e: any) => !!(e?.authenticationFailed || e?.auth || /auth|login|credentials|invalid/i.test(String(e?.responseText || e?.message || '')))
const say = (e: any) => authFail(e) ? 'The mail server did not take the password. Send this account to RoarMe again from RoarMail.'
  : /ENOTFOUND|getaddrinfo|dns/i.test(String(e?.code || e?.message)) ? 'The mail server could not be found.'
  : /timeout|ETIMEDOUT/i.test(String(e?.code || e?.message)) ? 'The mail server took too long to answer.'
  : String(e?.responseText || e?.message || e).slice(0, 200)

/** an account's settings and what signs it in (a password, or a fresh Microsoft access token) */
async function creds(user: string, account: string) {
  const { data: row } = await sb.from('roarmail_cloud').select('cfg, email').eq('user_id', user).eq('account_id', account).maybeSingle()
  if (!row) throw Object.assign(new Error('not connected'), { missing: true })
  const { data: secret } = await sb.rpc('roarmail_cloud_secret', { p_user: user, p_account: account })
  if (!secret) throw Object.assign(new Error('not connected'), { missing: true })
  const cfg = row.cfg as Cfg
  let cred: { pass?: string; access?: string } = { pass: secret }
  if (cfg.kind === 'microsoft') {
    const t = await msToken(secret)
    if (t.refresh !== secret) await sb.rpc('roarmail_cloud_put', { p_user: user, p_account: account, p_email: row.email, p_cfg: cfg, p_secret: t.refresh })
    cred = { access: t.access }
  }
  return { cfg, cred, email: row.email as string }
}

/** an account of this person, connected: its client, closed by the caller */
async function open(user: string, account: string) {
  const { cfg, cred } = await creds(user, account)
  const c = client(cfg, cred)
  try { await c.connect() } catch (e) {
    if (authFail(e)) await sb.rpc('roarmail_cloud_mark', { p_user: user, p_account: account, p_status: 'auth', p_error: say(e) })
    throw e
  }
  return c
}
const close = async (c: any) => { try { await c.logout() } catch { try { c.close() } catch { /* gone */ } } }

// ---- reading -----------------------------------------------------------------------------------------------------------
const td = (cs: string) => { try { return new TextDecoder(cs || 'utf-8') } catch { return new TextDecoder('utf-8') } }
function qp(s: string) { return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) }
function decodePart(raw: Uint8Array, enc: string, cs: string) {
  let bytes = raw
  const e = (enc || '').toLowerCase()
  if (e === 'base64') { try { bytes = Uint8Array.from(atob(new TextDecoder('latin1').decode(raw).replace(/[^A-Za-z0-9+/=]/g, '')), (ch) => ch.charCodeAt(0)) } catch { /* as is */ } }
  else if (e === 'quoted-printable') bytes = Uint8Array.from(qp(new TextDecoder('latin1').decode(raw)), (ch) => ch.charCodeAt(0) & 255)
  return td(cs).decode(bytes)
}
const stripHtml = (h: string) => h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<head[\s\S]*?<\/head>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** the part to take a few lines from (text/plain first), and whether the mail carries files */
function walk(node: any, acc = { text: null as any, html: null as any, files: 0 }) {
  if (!node) return acc
  if (node.childNodes?.length) { for (const k of node.childNodes) walk(k, acc); return acc }
  const t = String(node.type || '').toLowerCase()
  if (node.disposition === 'attachment' || (node.dispositionParameters?.filename && t !== 'text/plain' && t !== 'text/html')) acc.files++
  else if (t === 'text/plain' && !acc.text) acc.text = node
  else if (t === 'text/html' && !acc.html) acc.html = node
  return acc
}
const who = (a: any) => a ? { name: a.name || '', address: a.address || '' } : null

async function listOne(c: any, account: string, path: string, limit: number, page = 0, crit: any = null) {
  const box = await c.mailboxOpen(path, { readOnly: true })
  let total = box.exists || 0
  if (!total) return { total: 0, items: [] }
  const rows: any[] = []
  const what = { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true }
  if (crit) {
    // a search (the unread, one day, one sender): the newest first, a page at a time
    const uids: number[] = ((await c.search(crit, { uid: true })) || []).sort((a: number, b: number) => b - a)
    total = uids.length
    const part = uids.slice(limit * page, limit * (page + 1))
    if (!part.length) return { total, items: [] }
    for await (const m of c.fetch(part.join(','), what, { uid: true })) rows.push(m)
  } else {
    const top = total - limit * page
    if (top < 1) return { total, items: [] }
    for await (const m of c.fetch(`${Math.max(1, top - limit + 1)}:${top}`, what)) rows.push(m)
  }
  rows.sort((a, b) => b.uid - a.uid)
  const take = rows.slice(0, limit)
  // a few lines of each, from the first text part (at most 2 KB of it)
  const want = new Map<number, any>()
  for (const m of take) { const w = walk(m.bodyStructure); const p = w.text || w.html; if (p && (p.size || 0) < 400000) want.set(m.uid, p); m._files = w.files }
  if (want.size) {
    const uids = [...want.keys()].join(',')
    try {
      for await (const m of c.fetch(uids, { uid: true, bodyParts: [...new Set([...want.values()].map((p) => p.part || '1'))] }, { uid: true })) {
        const p = want.get(m.uid); if (!p) continue
        const raw = m.bodyParts?.get(p.part || '1'); if (!raw) continue
        let s = decodePart(new Uint8Array(raw).slice(0, 6000), p.encoding, p.parameters?.charset)
        if (String(p.type).toLowerCase() === 'text/html') s = stripHtml(s)
        const row = take.find((x) => x.uid === m.uid); if (row) row._sn = squash(s).slice(0, 220)
      }
    } catch { /* lines are a nicety */ }
  }
  return {
    total,
    items: take.map((m) => ({
      account, path, uid: m.uid, date: (m.envelope?.date || m.internalDate || new Date()).toISOString?.() || String(m.internalDate),
      from: who(m.envelope?.from?.[0]), to: (m.envelope?.to || []).slice(0, 4).map(who), subject: m.envelope?.subject || '',
      seen: m.flags?.has('\\Seen') || false, flagged: m.flags?.has('\\Flagged') || false, answered: m.flags?.has('\\Answered') || false,
      size: m.size || 0, files: m._files || 0, snippet: m._sn || '', msgid: m.envelope?.messageId || '',
    })),
  }
}

async function getOne(c: any, path: string, uid: number, markSeen: boolean) {
  await c.mailboxOpen(path, { readOnly: !markSeen })
  const m = await c.fetchOne(String(uid), { uid: true, source: true, flags: true, size: true }, { uid: true })
  if (!m) throw new Error('This mail is not there any more.')
  if ((m.size || 0) > 25e6) throw new Error('This mail is too big to open here.')
  const p = await PostalMime.parse(m.source)
  // pictures inside the mail (cid:) go in as data, up to 2 MB together
  let html = p.html || ''
  let budget = 2e6
  const files: any[] = []
  ;(p.attachments || []).forEach((a: any, i: number) => {
    const size = a.content?.byteLength || 0
    const cid = (a.contentId || '').replace(/^<|>$/g, '')
    if (cid && html.includes(`cid:${cid}`) && size < budget && /^image\//.test(a.mimeType)) {
      budget -= size
      let bin = ''; const u = new Uint8Array(a.content); for (let k = 0; k < u.length; k += 0x8000) bin += String.fromCharCode(...u.subarray(k, k + 0x8000))
      html = html.split(`cid:${cid}`).join(`data:${a.mimeType};base64,${btoa(bin)}`)
    } else files.push({ i, name: a.filename || 'attachment', mime: a.mimeType || 'application/octet-stream', size })
  })
  if (markSeen && !m.flags?.has('\\Seen')) { try { await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }) } catch { /* read only box */ } }
  const ads = (l: any[]) => (l || []).map((a: any) => ({ name: a.name || '', address: a.address || '' }))
  return {
    uid, path, subject: p.subject || '', date: p.date || '', from: p.from ? { name: p.from.name || '', address: p.from.address || '' } : null,
    to: ads(p.to), cc: ads(p.cc), replyTo: ads(p.replyTo), html, text: p.text || '', files, msgid: p.messageId || '',
  }
}

async function fileOf(c: any, path: string, uid: number, i: number) {
  await c.mailboxOpen(path, { readOnly: true })
  const m = await c.fetchOne(String(uid), { uid: true, source: true, size: true }, { uid: true })
  if (!m) throw new Error('This mail is not there any more.')
  const p = await PostalMime.parse(m.source)
  const a = (p.attachments || [])[i]
  if (!a) throw new Error('This file is not there any more.')
  return a
}

// ---- writing -----------------------------------------------------------------------------------------------------------
const addr = (l: any) => (Array.isArray(l) ? l : []).slice(0, 100).map((a: any) => ({ name: str(a?.name, 200), address: str(a?.address, 320).trim() }))
  .filter((a: any) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a.address))
const FOREIGN_SENT = /(^|\.)(gmail\.com|googlemail\.com|office365\.com|outlook\.com|hotmail\.com|live\.com)$/

/** a new mail, a reply or a forward: sent through the account's own SMTP (465; Supabase closes 25 and 587), then kept in Sent */
async function sendMail(user: string, b: any) {
  const account = str(b.account, 80)
  const { cfg, cred, email } = await creds(user, account)
  const to = addr(b.to), cc = addr(b.cc), bcc = addr(b.bcc)
  if (!to.length && !cc.length && !bcc.length) throw new Error('Add who it goes to.')
  const files = (Array.isArray(b.files) ? b.files : []).slice(0, 10)
  let total = 0
  const attachments = files.map((x: any) => {
    const content = Uint8Array.from(atob(String(x.b64 || '')), (ch) => ch.charCodeAt(0))
    total += content.byteLength
    return { filename: str(x.name, 200) || 'file', contentType: str(x.mime, 120) || 'application/octet-stream', content }
  })
  // a forward carries the original mail's files with it
  if (b.forwardOf?.account && b.forwardOf?.path && b.forwardOf?.uid) {
    const c = await open(user, str(b.forwardOf.account, 80))
    try {
      await c.mailboxOpen(str(b.forwardOf.path, 500), { readOnly: true })
      const m = await c.fetchOne(String(Number(b.forwardOf.uid)), { uid: true, source: true }, { uid: true })
      if (m) for (const a of (await PostalMime.parse(m.source)).attachments || []) {
        const content = new Uint8Array(a.content)
        total += content.byteLength
        attachments.push({ filename: a.filename || 'attachment', contentType: a.mimeType || 'application/octet-stream', content, cid: a.contentId ? String(a.contentId).replace(/^<|>$/g, '') : undefined })
      }
    } finally { await close(c) }
  }
  if (total > 18e6) throw new Error('The files are too big together (18 MB at most).')
  const fromName = str(b.fromName, 200)
  const msg: any = {
    from: fromName ? { name: fromName, address: email } : email, to, cc, bcc, subject: str(b.subject, 900),
    text: String(b.text || '').slice(0, 500000), html: b.html ? String(b.html).slice(0, 2e6) : undefined, attachments,
    inReplyTo: str(b.inReplyTo, 900) || undefined, references: str(b.references, 4000) || undefined,
  }
  const raw: Uint8Array = await new Promise((ok, no) => new MailComposer(msg).compile().build((e: any, m: any) => e ? no(e) : ok(m)))
  const host = cfg.smtp_host || cfg.imap_host.replace(/^imap\./, 'smtp.')
  const port = cfg.smtp_port === 587 || cfg.smtp_port === 25 ? 465 : (cfg.smtp_port || 465)
  const t = nodemailer.createTransport({
    host, port, secure: port === 465, requireTLS: port !== 465, connectionTimeout: 15e3, greetingTimeout: 12e3, socketTimeout: 60e3,
    auth: cred.access ? { type: 'OAuth2', user: cfg.username, accessToken: cred.access } : { user: cfg.username, pass: cred.pass },
    tls: { servername: host },
  } as any)
  try {
    await t.sendMail({ envelope: { from: email, to: [...to, ...cc, ...bcc].map((a: any) => a.address) }, raw })
  } catch (e: any) {
    const m = String(e?.message || e)
    if (/ETIMEDOUT|ECONNREFUSED|timeout/i.test(m)) throw new Error(`The cloud cannot reach ${host} to send (port ${port}). Send this one from RoarMail on the computer.`)
    throw new Error(authFail(e) ? 'The mail server did not take the password for sending.' : m.slice(0, 200))
  }
  // Gmail and Outlook keep their own copy in Sent; every other server is given one
  let kept = false
  if (b.sent && !FOREIGN_SENT.test(host)) {
    const c = client(cfg, cred)
    try { await c.connect(); await c.append(str(b.sent, 500), raw, ['\\Seen']); kept = true } catch { /* sent all the same */ } finally { await close(c) }
  }
  // the mail it answers is marked answered
  if (b.replyOf?.path && b.replyOf?.uid) {
    const c = client(cfg, cred)
    try { await c.connect(); await c.mailboxOpen(str(b.replyOf.path, 500)); await c.messageFlagsAdd(String(Number(b.replyOf.uid)), ['\\Answered'], { uid: true }) } catch { /* a nicety */ } finally { await close(c) }
  }
  return { ok: true, kept }
}

/** Block Sender: the address (and the name) into RoarMail's own block list, which the computers take in, and the mail to Junk */
const foldName = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ς/g, 'σ').replace(/["'`«»“”‘’]/g, '').replace(/\s+/g, ' ').trim()
async function blockSender(user: string, b: any) {
  const email = str(b.email, 320).trim().toLowerCase(), name = str(b.name, 200).trim()
  if (!/@/.test(email)) throw new Error('No sender to block.')
  const { data: row } = await sb.from('roarmail_sync').select('data').eq('user_id', user).maybeSingle()
  if (row?.data?.tables) {
    const T = row.data.tables
    T.contacts = Array.isArray(T.contacts) ? T.contacts : []
    const c = T.contacts.find((x: any) => String(x.email || '').toLowerCase() === email)
    if (c) c.blocked = 1; else T.contacts.push({ email, name: name || null, blocked: 1, use_count: 0, vip: 0, images_allowed: 0 })
    const key = foldName(name)
    if (key.length >= 3 && !/@/.test(key)) {
      T.block_rules = Array.isArray(T.block_rules) ? T.block_rules : []
      if (!T.block_rules.some((r: any) => r.kind === 'name' && r.value === key)) T.block_rules.push({ kind: 'name', value: key, label: name })
    }
    await sb.from('roarmail_sync').update({ data: row.data, device: 'roarme', updated_at: new Date().toISOString() }).eq('user_id', user)
  }
  const account = str(b.account, 80), path = str(b.path, 500), uid = Number(b.uid), junk = str(b.junk, 500)
  if (account && path && uid && junk && junk !== path) {
    const c = await open(user, account)
    try { await c.mailboxOpen(path); await c.messageMove(String(uid), junk, { uid: true }) } finally { await close(c) }
  }
  return { ok: true }
}

/** Block everyone at a domain, never a mailbox provider like gmail.com (as RoarMail's shield.ts blockableDomain) */
const PERSONAL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.gr', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'zoho.com', 'yandex.com', 'otenet.gr', 'hol.gr', 'windowslive.com'])
const baseDomain = (host: string) => { const p = host.split('.').filter(Boolean); if (p.length <= 2) return p.join('.'); const second = ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'gr'].includes(p[p.length - 2]) && p[p.length - 1].length === 2; return p.slice(second ? -3 : -2).join('.') }
const blockableDomain = (d: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && !PERSONAL.has(d) && !PERSONAL.has(baseDomain(d))
async function editRules(user: string, fn: (T: any) => void) {
  const { data: row } = await sb.from('roarmail_sync').select('data').eq('user_id', user).maybeSingle()
  if (!row?.data?.tables) throw new Error('RoarMail has not synced its settings yet.')
  const T = row.data.tables
  T.contacts = Array.isArray(T.contacts) ? T.contacts : []
  T.block_rules = Array.isArray(T.block_rules) ? T.block_rules : []
  fn(T)
  await sb.from('roarmail_sync').update({ data: row.data, device: 'roarme', updated_at: new Date().toISOString() }).eq('user_id', user)
}
async function blockDomain(user: string, b: any) {
  const d = str(b.domain, 253).toLowerCase().trim().replace(/^@/, '')
  if (!blockableDomain(d)) throw new Error('Many people use this domain (like gmail.com): it cannot be blocked as a whole.')
  await editRules(user, (T) => { if (!T.block_rules.some((r: any) => r.kind === 'domain' && r.value === d)) T.block_rules.push({ kind: 'domain', value: d, label: d }) })
  const account = str(b.account, 80), path = str(b.path, 500), uid = Number(b.uid), junk = str(b.junk, 500)
  if (account && path && uid && junk && junk !== path) {
    const c = await open(user, account)
    try { await c.mailboxOpen(path); await c.messageMove(String(uid), junk, { uid: true }) } finally { await close(c) }
  }
  return { ok: true }
}
/** Unblock (Settings, or Not Junk): an address, a name or a domain */
async function unblock(user: string, b: any) {
  const kind = str(b.kind, 20), value = str(b.value, 320).trim()
  if (!['email', 'name', 'domain', 'brand'].includes(kind) || !value) throw new Error('Nothing to unblock.')
  await editRules(user, (T) => {
    if (kind === 'email') { for (const c of T.contacts) if (String(c.email || '').toLowerCase() === value.toLowerCase()) c.blocked = 0 }
    else T.block_rules = T.block_rules.filter((r: any) => !(r.kind === kind && r.value === value))
  })
  return { ok: true }
}

// ---- adding an account from RoarMe itself (Alex, 25 Nov 2026: Add Account on the phone, sample "1") -------------------
// The well-known services by their own settings; anything else from Thunderbird's public list of providers, or a guess.
const PRESETS: Record<string, { imap: string; smtp: string; smtpPort: number; smtpTls: string; domains: string[] }> = {
  gmail: { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com', smtpPort: 465, smtpTls: 'tls', domains: ['gmail.com', 'googlemail.com'] },
  icloud: { imap: 'imap.mail.me.com', smtp: 'smtp.mail.me.com', smtpPort: 587, smtpTls: 'starttls', domains: ['icloud.com', 'me.com', 'mac.com'] },
  yahoo: { imap: 'imap.mail.yahoo.com', smtp: 'smtp.mail.yahoo.com', smtpPort: 465, smtpTls: 'tls', domains: ['yahoo.com', 'yahoo.gr', 'ymail.com', 'rocketmail.com'] },
  aol: { imap: 'imap.aol.com', smtp: 'smtp.aol.com', smtpPort: 465, smtpTls: 'tls', domains: ['aol.com'] },
  outlook: { imap: 'outlook.office365.com', smtp: 'smtp-mail.outlook.com', smtpPort: 587, smtpTls: 'starttls', domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'] },
}
const COLORS = ['#3aa7e8', '#e5483f', '#14b89a', '#7b4dff', '#ff9f0a', '#d6338a', '#0f6e7a', '#5a4a3c']
async function detect(email: string) {
  const dom = email.split('@')[1] || ''
  for (const [k, p] of Object.entries(PRESETS)) if (p.domains.includes(dom)) return { provider: k, imap_host: p.imap, imap_port: 993, smtp_host: p.smtp, smtp_port: p.smtpPort, smtp_tls: p.smtpTls }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dom)) return null
  try {
    const r = await fetch(`https://autoconfig.thunderbird.net/v1.1/${dom}`, { signal: AbortSignal.timeout(6000) })
    if (r.ok) {
      const x = await r.text()
      const imap = x.match(/<incomingServer type="imap">[\s\S]*?<hostname>([^<]+)<\/hostname>[\s\S]*?<port>(\d+)<\/port>/)
      const smtps = [...x.matchAll(/<outgoingServer type="smtp">[\s\S]*?<hostname>([^<]+)<\/hostname>[\s\S]*?<port>(\d+)<\/port>/g)]
      const smtp = smtps.find((m) => m[2] === '465') || smtps[0]
      if (imap) return { provider: 'other', imap_host: imap[1], imap_port: Number(imap[2]) === 143 ? 143 : 993, smtp_host: smtp?.[1] || `smtp.${dom}`, smtp_port: Number(smtp?.[2]) || 465, smtp_tls: smtp?.[2] === '465' ? 'tls' : 'starttls' }
    }
  } catch { /* guess */ }
  return { provider: 'other', imap_host: `imap.${dom}`, imap_port: 993, smtp_host: `smtp.${dom}`, smtp_port: 465, smtp_tls: 'tls' }
}
/** an account's folders, with RoarMail's roles */
async function foldersOf(c: any) {
  const ROLE: Record<string, string> = { '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Junk': 'spam', '\\Trash': 'trash', '\\Archive': 'archive', '\\Flagged': 'flagged' }
  const l = await c.list()
  return l.filter((f: any) => !(f.flags && (f.flags.has?.('\\Noselect') || f.flags.has?.('\\NonExistent'))))
    .map((f: any) => ({ path: f.path, name: f.name || f.path, role: f.path.toUpperCase() === 'INBOX' ? 'inbox' : (ROLE[f.specialUse] || '') }))
    .slice(0, 300)
}
async function keepNew(user: string, email: string, cfg: Cfg, secret: string, cred: { pass?: string; access?: string }, label: string) {
  const { data: had } = await sb.from('roarmail_cloud').select('account_id, email').eq('user_id', user)
  if ((had || []).some((r: any) => String(r.email).toLowerCase() === email)) return { ok: false, error: 'This address is in RoarMe already.' }
  const c = client(cfg, cred)
  let folders: any[] = []
  try { await c.connect(); folders = await foldersOf(c) } catch (e) { return { ok: false, error: authFail(e) ? 'The mail server did not take this password. Check that it is the app password and try again.' : say(e) } } finally { await close(c) }
  const id = 'rm-' + crypto.randomUUID().slice(0, 8)
  const full = { ...cfg, origin: 'roarme', name: label || email.split('@')[0], color: COLORS[(had || []).length % COLORS.length], folders }
  const { error } = await sb.rpc('roarmail_cloud_put', { p_user: user, p_account: id, p_email: email, p_cfg: full, p_secret: secret })
  if (error) throw error
  return { ok: true, account_id: id }
}
async function addAccount(user: string, b: any) {
  const email = str(b.email, 320).trim().toLowerCase(), raw = String(b.password || '').trim()
  const pass = /^[a-z]{4}( [a-z]{4}){3}$/i.test(raw) ? raw.replace(/ /g, '') : raw // an app password as Google shows it: four groups of four
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Write the whole email address.' }
  if (!pass || pass.length > 500) return { ok: false, error: 'Write the password.' }
  const d = b.cfg?.imap_host ? { provider: 'other', ...b.cfg } : await detect(email)
  if (!d) return { ok: false, error: 'Write the whole email address.' }
  const cfg = cleanCfg({ ...d, imap_tls: Number(d.imap_port) === 143 ? 'starttls' : 'tls', username: str(b.username, 320).trim() || email, kind: 'password' })
  const label = str(b.name, 60).trim() || ({ gmail: 'Gmail', icloud: 'iCloud', yahoo: 'Yahoo', aol: 'AOL', outlook: 'Outlook' } as any)[d.provider] || email.split('@')[1]
  return await keepNew(user, email, cfg, pass, { pass }, label)
}
// Sign in with Microsoft from the phone: the device code flow (as RoarMail's Mac App Store build), asked from here
const MS_AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0'
async function msStart() {
  const r = await fetch(`${MS_AUTH}/devicecode`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: MS_CLIENT, scope: MS_SCOPE }).toString() })
  const d = await r.json().catch(() => ({}))
  if (!r.ok || !d.device_code) throw new Error(`Microsoft: ${d.error_description || d.error || r.status}`)
  return { code: d.user_code, url: d.verification_uri || 'https://microsoft.com/devicelogin', device: d.device_code, every: Number(d.interval) || 5, expires: Number(d.expires_in) || 900 }
}
async function msPoll(user: string, b: any) {
  const r = await fetch(`${MS_AUTH}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: MS_CLIENT, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: str(b.device, 4000) }).toString() })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) {
    if (j.error === 'authorization_pending' || j.error === 'slow_down') return { pending: true }
    if (j.error === 'authorization_declined') return { ok: false, error: 'The sign-in was cancelled.' }
    if (j.error === 'expired_token') return { ok: false, error: 'The code expired. Start again.' }
    return { ok: false, error: `Microsoft: ${j.error_description || j.error || r.status}`.slice(0, 200) }
  }
  let email = ''
  try { const p = JSON.parse(atob(String(j.id_token || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); email = String(p.email || p.preferred_username || '').toLowerCase() } catch { /* below */ }
  if (!email) return { ok: false, error: 'Microsoft did not say which address signed in.' }
  const p = PRESETS.outlook
  const cfg = cleanCfg({ imap_host: p.imap, imap_port: 993, imap_tls: 'tls', smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_tls: 'starttls', username: email, kind: 'microsoft' })
  return await keepNew(user, email, cfg, j.refresh_token || '', { access: j.access_token }, 'Outlook')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405)
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  const { data: au } = await sb.auth.getUser(token)
  const user = au?.user?.id
  if (!user) return reply({ error: 'Sign in first' }, 401)
  let b: any = {}
  try { b = await req.json() } catch { return reply({ error: 'Bad request' }, 400) }
  const act = String(b.action || '')
  try {
    if (act === 'state') {
      const { data } = await sb.from('roarmail_cloud').select('account_id, email, status, error, checked_at, cfg').eq('user_id', user)
      // an account added in RoarMe itself carries its name, colour and folders (RoarMail on the computer does not know it)
      return reply({ accounts: (data || []).map(({ cfg, ...a }: any) => cfg?.origin === 'roarme'
        ? { ...a, own: { name: cfg.name, color: cfg.color, kind: cfg.kind, folders: cfg.folders || [] } } : a) })
    }
    if (act === 'connect') {
      const account = str(b.account_id, 80), email = str(b.email, 320).trim().toLowerCase(), secret = String(b.secret || '')
      if (!account || !email || !secret || secret.length > 8000) return reply({ error: 'Missing account details' }, 400)
      const cfg = cleanCfg(b.cfg)
      let keep = secret, cred: { pass?: string; access?: string } = { pass: secret }
      if (cfg.kind === 'microsoft') { const t = await msToken(secret); keep = t.refresh; cred = { access: t.access } }
      const c = client(cfg, cred)
      try { await c.connect() } catch (e) { return reply({ ok: false, error: say(e) }) } finally { await close(c) }
      const { error } = await sb.rpc('roarmail_cloud_put', { p_user: user, p_account: account, p_email: email, p_cfg: cfg, p_secret: keep })
      if (error) throw error
      return reply({ ok: true })
    }
    if (act === 'disconnect') {
      await sb.rpc('roarmail_cloud_drop', { p_user: user, p_account: str(b.account_id, 80) })
      return reply({ ok: true })
    }
    if (act === 'counts' || act === 'list') {
      // items: [{ account, path }], several accounts together (All Inboxes); one connection per account
      const items: { account: string; path: string }[] = (Array.isArray(b.items) ? b.items : []).slice(0, 30)
        .map((x: any) => ({ account: str(x.account, 80), path: str(x.path, 500) })).filter((x: any) => x.account && x.path)
      const limit = Math.min(60, Math.max(5, Number(b.limit) || 30))
      const by = new Map<string, typeof items>()
      for (const it of items) by.set(it.account, [...(by.get(it.account) || []), it])
      const out: any = { counts: {}, items: [], totals: {}, errors: {} }
      // what to look for: the unread, mail of one day (on: 'YYYY-MM-DD'), one sender (from), words (text)
      const f = b.find || {}
      let crit: any = null
      if (b.unseen === true || f.unseen) crit = { ...(crit || {}), seen: false }
      if (f.flagged) crit = { ...(crit || {}), flagged: true }
      if (f.from) crit = { ...(crit || {}), from: str(f.from, 320) }
      if (f.text) crit = { ...(crit || {}), text: str(f.text, 200) }
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(f.on || ''))) crit = { ...(crit || {}), on: new Date(String(f.on) + 'T12:00:00Z') }
      await Promise.all([...by.entries()].map(async ([account, list]) => {
        let c: any
        try {
          c = await open(user, account)
          for (const it of list) {
            if (act === 'counts') {
              const s = await c.status(it.path, { unseen: true, messages: true })
              out.counts[`${account}|${it.path}`] = { unseen: s.unseen || 0, messages: s.messages || 0 }
            } else {
              const r = await listOne(c, account, it.path, limit, Math.max(0, Number(b.page) || 0), crit)
              out.totals[`${account}|${it.path}`] = r.total
              out.items.push(...r.items)
            }
          }
        } catch (e: any) { out.errors[account] = e?.missing ? 'missing' : say(e) } finally { if (c) await close(c) }
      }))
      out.items.sort((x: any, y: any) => String(y.date).localeCompare(String(x.date)))
      return reply(out)
    }
    if (act === 'get' || act === 'file' || act === 'flag' || act === 'move' || act === 'delete') {
      const account = str(b.account, 80), path = str(b.path, 500), uid = Number(b.uid)
      if (!account || !path || !uid) return reply({ error: 'Missing mail' }, 400)
      const c = await open(user, account)
      try {
        if (act === 'get') return reply(await getOne(c, path, uid, b.seen !== false))
        if (act === 'file') {
          const a = await fileOf(c, path, uid, Number(b.i) || 0)
          return new Response(a.content, { headers: { ...cors, 'Content-Type': a.mimeType || 'application/octet-stream', 'X-File-Name': encodeURIComponent(a.filename || 'attachment') } })
        }
        await c.mailboxOpen(path)
        if (act === 'flag') {
          const f = b.flag === 'flagged' ? '\\Flagged' : '\\Seen'
          if (b.on) await c.messageFlagsAdd(String(uid), [f], { uid: true }); else await c.messageFlagsRemove(String(uid), [f], { uid: true })
        } else if (act === 'move') await c.messageMove(String(uid), str(b.to, 500), { uid: true })
        else {
          const to = str(b.trash, 500)
          if (to && to !== path) await c.messageMove(String(uid), to, { uid: true }); else await c.messageDelete(String(uid), { uid: true })
        }
        return reply({ ok: true })
      } finally { await close(c) }
    }
    if (act === 'empty') {
      // Empty Trash (or Junk): everything in that one folder, for good
      const account = str(b.account, 80), path = str(b.path, 500)
      if (!account || !path) return reply({ error: 'Missing folder' }, 400)
      const c = await open(user, account)
      try {
        const box = await c.mailboxOpen(path)
        if (box.exists) await c.messageDelete('1:*')
        return reply({ ok: true, gone: box.exists || 0 })
      } finally { await close(c) }
    }
    if (act === 'detect') return reply({ cfg: await detect(str(b.email, 320).trim().toLowerCase()) })
    if (act === 'add') return reply(await addAccount(user, b))
    if (act === 'msStart') return reply(await msStart())
    if (act === 'msPoll') return reply(await msPoll(user, b))
    if (act === 'refolder') {
      const account = str(b.account_id, 80)
      const { data: row } = await sb.from('roarmail_cloud').select('cfg, email').eq('user_id', user).eq('account_id', account).maybeSingle()
      if (!row || row.cfg?.origin !== 'roarme') return reply({ error: 'missing' }, 404)
      const c = await open(user, account)
      let folders: any[] = []
      try { folders = await foldersOf(c) } finally { await close(c) }
      await sb.from('roarmail_cloud').update({ cfg: { ...row.cfg, folders } }).eq('user_id', user).eq('account_id', account)
      return reply({ folders })
    }
    if (act === 'rename') {
      const account = str(b.account_id, 80)
      const { data: row } = await sb.from('roarmail_cloud').select('cfg').eq('user_id', user).eq('account_id', account).maybeSingle()
      if (!row || row.cfg?.origin !== 'roarme') return reply({ error: 'missing' }, 404)
      await sb.from('roarmail_cloud').update({ cfg: { ...row.cfg, name: str(b.name, 60).trim() || row.cfg.name } }).eq('user_id', user).eq('account_id', account)
      return reply({ ok: true })
    }
    if (act === 'send') return reply(await sendMail(user, b))
    if (act === 'block') return reply(await blockSender(user, b))
    if (act === 'blockDomain') return reply(await blockDomain(user, b))
    if (act === 'unblock') return reply(await unblock(user, b))
    return reply({ error: 'Unknown action' }, 400)
  } catch (e: any) {
    if (e?.missing) return reply({ error: 'missing' }, 404)
    return reply({ error: say(e) }, 502)
  }
})
