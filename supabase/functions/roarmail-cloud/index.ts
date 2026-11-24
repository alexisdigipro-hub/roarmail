// RoarMail in the cloud, for RoarMe (Edge Function roarmail-cloud, in RoarMe's Supabase project beside roarmail-ai).
// Alex, 24 Nov 2026: "pass the mail through the cloud too, so it pulls them and starts working". RoarMail on the computer
// hands one account's password (or Sign in with Microsoft's refresh token) here with Send to RoarMe; it is checked
// against the mail server and kept in Supabase Vault (supabase/roarmail-cloud.sql). RoarMe then asks this function for
// that account's folders' mail. Mail is read from the server each time and never stored. Only the signed-in owner of
// an account reaches it.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { ImapFlow } from 'npm:imapflow@2.5.8'
import PostalMime from 'npm:postal-mime@2.4.4'

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

/** an account of this person, connected: its client, closed by the caller */
async function open(user: string, account: string) {
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

async function listOne(c: any, account: string, path: string, limit: number, page = 0) {
  const box = await c.mailboxOpen(path, { readOnly: true })
  const total = box.exists || 0
  if (!total) return { total: 0, items: [] }
  const top = total - limit * page
  if (top < 1) return { total, items: [] }
  const range = `${Math.max(1, top - limit + 1)}:${top}`
  const rows: any[] = []
  for await (const m of c.fetch(range, { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true })) rows.push(m)
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
      const { data } = await sb.from('roarmail_cloud').select('account_id, email, status, error, checked_at').eq('user_id', user)
      return reply({ accounts: data || [] })
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
      await Promise.all([...by.entries()].map(async ([account, list]) => {
        let c: any
        try {
          c = await open(user, account)
          for (const it of list) {
            if (act === 'counts') {
              const s = await c.status(it.path, { unseen: true, messages: true })
              out.counts[`${account}|${it.path}`] = { unseen: s.unseen || 0, messages: s.messages || 0 }
            } else {
              const r = await listOne(c, account, it.path, limit, Math.max(0, Number(b.page) || 0))
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
    return reply({ error: 'Unknown action' }, 400)
  } catch (e: any) {
    if (e?.missing) return reply({ error: 'missing' }, 404)
    return reply({ error: say(e) }, 502)
  }
})
