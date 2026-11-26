// RoarMail Live: the mail engine that stays up (Alex, 26 Nov 2026: "deleting is slow; make it as Spark does").
// One container per RoarMe person (Cloudflare Containers, behind the Worker in ../src/index.js). It keeps each mail
// account's IMAP connection open between calls, so a delete, a move or a list costs one round trip, not a fresh login.
// The passwords stay in RoarMe's Supabase Vault: they are asked from the Edge Function roarmail-creds, with a key only
// this server and that function know, for the person the Worker has already checked. Nothing of the mail is stored.
import http from 'node:http'
import { ImapFlow } from 'imapflow'
import PostalMime from 'postal-mime'

const SUPABASE_URL = process.env.SUPABASE_URL
const LIVE_KEY = process.env.LIVE_KEY
const IDLE_MS = 40 * 60e3 // a connection stays open 40 minutes after its last use, kept alive by a NOOP every 9

const str = (v, n = 300) => String(v ?? '').slice(0, n)
const say = (e) => {
  const m = String(e?.responseText || e?.message || e)
  if (e?.authenticationFailed || /auth|login|credentials|invalid/i.test(m)) return 'The mail server did not take the password. Add this account again in RoarMe (or send it again from RoarMail).'
  if (/ENOTFOUND|getaddrinfo/i.test(String(e?.code || m))) return 'The mail server could not be found.'
  if (/timeout|ETIMEDOUT/i.test(String(e?.code || m))) return 'The mail server took too long to answer.'
  return m.slice(0, 200)
}

// ---- credentials, asked from RoarMe's own vault --------------------------------------------------------------------
const credCache = new Map() // user|account -> { at, v }
const credAsk = new Map() // user|account -> the ask in flight, shared by every call that needs it at the same moment
const tokens = new Map() // user -> their newest RoarMe sign-in, which roarmail-creds checks too
async function creds(user, account) {
  const k = `${user}|${account}`, had = credCache.get(k)
  // a password holds until the server refuses it; a Microsoft access token for 45 minutes
  if (had && Date.now() - had.at < (had.v.access ? 45 * 60e3 : 12 * 3600e3)) return had.v
  if (credAsk.has(k)) return credAsk.get(k)
  const ask = (async () => {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/roarmail-creds`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-live-key': LIVE_KEY, Authorization: `Bearer ${tokens.get(user) || ''}` }, body: JSON.stringify({ user, account }),
    })
    const j = await r.json().catch(() => ({}))
    if (r.status === 404 || j.error === 'missing') throw Object.assign(new Error('not connected'), { missing: true })
    if (!r.ok) throw new Error(j.error || `creds ${r.status}`)
    credCache.set(k, { at: Date.now(), v: j })
    return j
  })()
  credAsk.set(k, ask)
  try { return await ask } finally { credAsk.delete(k) }
}

// ---- two open connections per account, each used one call at a time ----------------------------------------------
// 'fg' carries what the person waits for (open a mail, a folder, delete, move); 'bg' the counts and the mail read ahead,
// so those never stand in front of a tap (26 Nov: "still slow and heavy")
const pool = new Map() // user|account|lane -> { c, at, chain }
const opening = new Map() // user|account|lane -> the connection being made, shared
function client(cfg, cred) {
  const c = new ImapFlow({
    host: cfg.imap_host, port: cfg.imap_port, secure: cfg.imap_tls === 'tls', doSTARTTLS: cfg.imap_tls === 'starttls' ? true : undefined,
    auth: cred.access ? { user: cfg.username, accessToken: cred.access } : { user: cfg.username, pass: cred.pass || '' },
    logger: false, emitLogs: false, tls: { servername: cfg.imap_host }, connectionTimeout: 15e3, greetingTimeout: 12e3, socketTimeout: 120e3,
  })
  c.on('error', () => {})
  return c
}
async function conn(user, account, lane) {
  const k = `${user}|${account}|${lane}`
  let p = pool.get(k)
  if (p && p.c.usable) { p.at = Date.now(); return p }
  if (opening.has(k)) return opening.get(k)
  if (p) { pool.delete(k); try { p.c.close() } catch { /* gone */ } }
  const make = (async () => {
    const { cfg, pass, access } = await creds(user, account)
    const c = client(cfg, { pass, access })
    await c.connect()
    const np = { c, at: Date.now(), chain: Promise.resolve() }
    c.on('close', () => { if (pool.get(k) === np) pool.delete(k) })
    pool.set(k, np)
    return np
  })()
  opening.set(k, make)
  try { return await make } finally { opening.delete(k) }
}
// a mailbox already open on this connection is not opened again, except to list it (that is when it must be fresh)
async function openBox(c, path, fresh) {
  if (!fresh && c.mailbox && c.mailbox.path === path && !c.mailbox.readOnly) return c.mailbox
  return c.mailboxOpen(path)
}
// every call on one connection waits for the one before it (a call selects its own folder), and a dropped connection is
// made again once
async function withConn(user, account, fn, lane = 'fg') {
  const run = async (again) => {
    const p = await conn(user, account, lane)
    const next = p.chain.then(() => fn(p.c))
    p.chain = next.catch(() => {})
    try { return await next } catch (e) {
      if (!again && (!p.c.usable || /closed|socket|ECONNRESET|EPIPE|Connection not available/i.test(String(e?.message || e)))) {
        pool.delete(`${user}|${account}|${lane}`); try { p.c.close() } catch { /* gone */ }
        return run(true)
      }
      if (e?.authenticationFailed) credCache.delete(`${user}|${account}`)
      throw e
    }
  }
  return run(false)
}
// mail servers drop a connection that says nothing for about half an hour: a NOOP in its own turn keeps it
setInterval(() => {
  for (const p of pool.values()) if (p.c.usable) p.chain = p.chain.then(() => p.c.noop()).catch(() => {})
}, 9 * 60e3).unref()
setInterval(() => {
  for (const [k, p] of pool) if (Date.now() - p.at > IDLE_MS) { pool.delete(k); p.c.logout().catch(() => { try { p.c.close() } catch { /* gone */ } }) }
}, 60e3).unref()

// ---- reading (as roarmail-cloud) -----------------------------------------------------------------------------------
const td = (cs) => { try { return new TextDecoder(cs || 'utf-8') } catch { return new TextDecoder('utf-8') } }
const qp = (s) => s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
function decodePart(raw, enc, cs) {
  let bytes = raw
  const e = (enc || '').toLowerCase()
  if (e === 'base64') { try { bytes = Uint8Array.from(Buffer.from(new TextDecoder('latin1').decode(raw).replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')) } catch { /* as is */ } }
  else if (e === 'quoted-printable') bytes = Uint8Array.from(qp(new TextDecoder('latin1').decode(raw)), (ch) => ch.charCodeAt(0) & 255)
  return td(cs).decode(bytes)
}
const stripHtml = (h) => h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<head[\s\S]*?<\/head>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
const squash = (s) => s.replace(/\s+/g, ' ').trim()
function walk(node, acc = { text: null, html: null, files: 0 }) {
  if (!node) return acc
  if (node.childNodes?.length) { for (const k of node.childNodes) walk(k, acc); return acc }
  const t = String(node.type || '').toLowerCase()
  if (node.disposition === 'attachment' || (node.dispositionParameters?.filename && t !== 'text/plain' && t !== 'text/html')) acc.files++
  else if (t === 'text/plain' && !acc.text) acc.text = node
  else if (t === 'text/html' && !acc.html) acc.html = node
  return acc
}
const who = (a) => a ? { name: a.name || '', address: a.address || '' } : null

async function listOne(c, account, path, limit, page = 0, crit = null) {
  const box = await openBox(c, path, true)
  let total = box.exists || 0
  if (!total) return { total: 0, items: [] }
  const rows = []
  const what = { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true }
  if (crit) {
    const uids = ((await c.search({ ...crit, deleted: false }, { uid: true })) || []).sort((a, b) => b - a)
    total = uids.length
    const part = uids.slice(limit * page, limit * (page + 1))
    if (!part.length) return { total, items: [] }
    for await (const m of c.fetch(part.join(','), what, { uid: true })) rows.push(m)
  } else {
    const top = total - limit * page
    if (top < 1) return { total, items: [] }
    for await (const m of c.fetch(`${Math.max(1, top - limit + 1)}:${top}`, what)) rows.push(m)
  }
  const arrived = (m) => new Date(m.internalDate || m.envelope?.date || 0).getTime()
  const take = rows.filter((m) => !m.flags?.has('\\Deleted')).sort((a, b) => arrived(b) - arrived(a) || b.uid - a.uid).slice(0, limit)
  const want = new Map()
  for (const m of take) { const w = walk(m.bodyStructure); const p = w.text || w.html; if (p && (p.size || 0) < 400000) want.set(m.uid, p); m._files = w.files }
  if (want.size) {
    try {
      for await (const m of c.fetch([...want.keys()].join(','), { uid: true, bodyParts: [...new Set([...want.values()].map((p) => p.part || '1'))] }, { uid: true })) {
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
      account, path, uid: m.uid, date: new Date(m.internalDate || m.envelope?.date || Date.now()).toISOString(),
      from: who(m.envelope?.from?.[0]), to: (m.envelope?.to || []).slice(0, 4).map(who), subject: m.envelope?.subject || '',
      seen: m.flags?.has('\\Seen') || false, flagged: m.flags?.has('\\Flagged') || false, answered: m.flags?.has('\\Answered') || false,
      size: m.size || 0, files: m._files || 0, snippet: m._sn || '', msgid: m.envelope?.messageId || '',
    })),
  }
}

async function getOne(c, path, uid, markSeen) {
  await openBox(c, path)
  const m = await c.fetchOne(String(uid), { uid: true, source: true, flags: true, size: true }, { uid: true })
  if (!m) throw new Error('This mail is not there any more.')
  if ((m.size || 0) > 25e6) throw new Error('This mail is too big to open here.')
  const p = await PostalMime.parse(m.source)
  let html = p.html || ''
  let budget = 2e6
  const files = []
  ;(p.attachments || []).forEach((a, i) => {
    const size = a.content?.byteLength || 0
    const cid = (a.contentId || '').replace(/^<|>$/g, '')
    if (cid && html.includes(`cid:${cid}`) && size < budget && /^image\//.test(a.mimeType)) {
      budget -= size
      html = html.split(`cid:${cid}`).join(`data:${a.mimeType};base64,${Buffer.from(a.content).toString('base64')}`)
    } else files.push({ i, name: a.filename || 'attachment', mime: a.mimeType || 'application/octet-stream', size })
  })
  if (markSeen && !m.flags?.has('\\Seen')) { try { await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }) } catch { /* read only box */ } }
  const ads = (l) => (l || []).map((a) => ({ name: a.name || '', address: a.address || '' }))
  return {
    uid, path, subject: p.subject || '', date: p.date || '', from: p.from ? { name: p.from.name || '', address: p.from.address || '' } : null,
    to: ads(p.to), cc: ads(p.cc), replyTo: ads(p.replyTo), html, text: p.text || '', files, msgid: p.messageId || '',
  }
}
async function fileOf(c, path, uid, i) {
  await openBox(c, path)
  const m = await c.fetchOne(String(uid), { uid: true, source: true }, { uid: true })
  if (!m) throw new Error('This mail is not there any more.')
  const a = ((await PostalMime.parse(m.source)).attachments || [])[i]
  if (!a) throw new Error('This file is not there any more.')
  return a
}

// ---- the actions ----------------------------------------------------------------------------------------------------
async function handle(user, b) {
  const act = String(b.action || '')
  const lane = b.bg || act === 'counts' ? 'bg' : 'fg'
  if (act === 'counts' || act === 'list') {
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 60).map((x) => ({ account: str(x.account, 80), path: str(x.path, 500) })).filter((x) => x.account && x.path)
    const limit = Math.min(60, Math.max(5, Number(b.limit) || 30))
    const by = new Map()
    for (const it of items) by.set(it.account, [...(by.get(it.account) || []), it])
    const out = { counts: {}, items: [], totals: {}, errors: {} }
    const f = b.find || {}
    let crit = null
    if (b.unseen === true || f.unseen) crit = { ...(crit || {}), seen: false }
    if (f.flagged) crit = { ...(crit || {}), flagged: true }
    if (f.from) crit = { ...(crit || {}), from: str(f.from, 320) }
    if (f.text) crit = { ...(crit || {}), text: str(f.text, 200) }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(f.on || ''))) crit = { ...(crit || {}), on: new Date(String(f.on) + 'T12:00:00Z') }
    await Promise.all([...by.entries()].map(async ([account, list]) => {
      try {
        await withConn(user, account, async (c) => {
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
        }, lane)
      } catch (e) { out.errors[account] = e?.missing ? 'missing' : say(e) }
    }))
    out.items.sort((x, y) => String(y.date).localeCompare(String(x.date)))
    return { body: out }
  }
  const account = str(b.account, 80), path = str(b.path, 500)
  if (!account || !path) return { status: 400, body: { error: 'Missing mail' } }
  if (act === 'get') return { body: await withConn(user, account, (c) => getOne(c, path, Number(b.uid), b.seen !== false), lane) }
  if (act === 'file') {
    const a = await withConn(user, account, (c) => fileOf(c, path, Number(b.uid), Number(b.i) || 0))
    return { raw: Buffer.from(a.content), type: a.mimeType || 'application/octet-stream', name: a.filename || 'attachment' }
  }
  if (act === 'flag' || act === 'move' || act === 'delete') {
    const uid = String(Number(b.uid))
    await withConn(user, account, async (c) => {
      await openBox(c, path)
      if (act === 'flag') {
        const f = b.flag === 'flagged' ? '\\Flagged' : '\\Seen'
        if (b.on) await c.messageFlagsAdd(uid, [f], { uid: true }); else await c.messageFlagsRemove(uid, [f], { uid: true })
      } else if (act === 'move') await c.messageMove(uid, str(b.to, 500), { uid: true })
      else { const to = str(b.trash, 500); if (to && to !== path) await c.messageMove(uid, to, { uid: true }); else await c.messageDelete(uid, { uid: true }) }
    })
    return { body: { ok: true } }
  }
  if (act === 'bulk') {
    const op = str(b.op, 20)
    const uids = (Array.isArray(b.uids) ? b.uids : []).map(Number).filter((n) => n > 0).slice(0, 5000)
    if (!uids.length) return { status: 400, body: { error: 'Missing mail' } }
    await withConn(user, account, async (c) => {
      await openBox(c, path)
      for (let i = 0; i < uids.length; i += 400) {
        const set = uids.slice(i, i + 400).join(',')
        if (op === 'flag') { const f = b.flag === 'flagged' ? '\\Flagged' : '\\Seen'; if (b.on) await c.messageFlagsAdd(set, [f], { uid: true }); else await c.messageFlagsRemove(set, [f], { uid: true }) }
        else if (op === 'move') await c.messageMove(set, str(b.to, 500), { uid: true })
        else if (op === 'delete') { const to = str(b.trash, 500); if (to && to !== path) await c.messageMove(set, to, { uid: true }); else await c.messageDelete(set, { uid: true }) }
      }
    })
    return { body: { ok: true, n: uids.length } }
  }
  if (act === 'empty') {
    const r = await withConn(user, account, async (c) => {
      await c.mailboxOpen(path)
      const uids = ((await c.search({ all: true }, { uid: true })) || []).sort((x, y) => y - x)
      const t0 = Date.now(); let gone = 0
      for (let i = 0; i < uids.length && Date.now() - t0 < 60e3; i += 500) { const part = uids.slice(i, i + 500); await c.messageDelete(part.join(','), { uid: true }); gone += part.length }
      return { ok: true, gone, left: Math.max(0, uids.length - gone) }
    })
    return { body: r }
  }
  return { status: 400, body: { error: 'Unknown action' } }
}

http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.url === '/health') { res.writeHead(200); res.end(`ok ${pool.size}`); return }
  const user = String(req.headers['x-user'] || '')
  if (!user || req.headers['x-live-key'] !== LIVE_KEY) return send(401, { error: 'No' })
  if (req.headers['x-user-token']) tokens.set(user, String(req.headers['x-user-token']))
  let raw = ''
  for await (const ch of req) { raw += ch; if (raw.length > 2e6) return send(413, { error: 'Too big' }) }
  let b = {}
  try { b = JSON.parse(raw || '{}') } catch { return send(400, { error: 'Bad request' }) }
  try {
    const r = await handle(user, b)
    if (r.raw) { res.writeHead(200, { 'Content-Type': r.type, 'X-File-Name': encodeURIComponent(r.name) }); res.end(r.raw); return }
    send(r.status || 200, r.body)
  } catch (e) {
    if (e?.missing) return send(404, { error: 'missing' })
    send(502, { error: say(e) })
  }
}).listen(8080, () => console.log('roarmail-live up'))
