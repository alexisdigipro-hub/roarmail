// roarmail-creds: hands one mail account's sign-in to RoarMail Live (the Cloudflare container that keeps the mail
// connections open, live/ in this repository), and to nothing else. Two locks: the shared LIVE_KEY that only Live and
// this function know, and the person's own RoarMe sign-in, which must be the owner of the account asked for. The
// password stays in Supabase Vault; Microsoft accounts get a fresh access token, never the refresh token.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const MS_CLIENT = '1449effc-2b8b-443b-9523-e2f84dd6b677'
const MS_SCOPE = 'offline_access openid email profile https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send'
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// the shared key lives in Supabase Vault (roarmail_live_key, supabase/roarmail-live.sql), read once per instance
let liveKey = ''
async function getKey() {
  if (!liveKey) { const { data } = await sb.rpc('roarmail_live_key'); liveKey = String(data || '') }
  return liveKey
}

Deno.serve(async (req) => {
  const key = await getKey()
  if (!key || req.headers.get('x-live-key') !== key) return reply({ error: 'No' }, 401)
  let b: any = {}
  try { b = await req.json() } catch { return reply({ error: 'Bad request' }, 400) }
  // New-mail notifications (26 Nov, supabase/roarmail-watch.sql): the Worker's five-minute round asks who is watched,
  // with their accounts, the last mail told about and their blocked senders
  if (b.watchers === true) return reply(await watchers())
  const user = String(b.user || ''), account = String(b.account || '').slice(0, 80)
  if (b.seen && /^[0-9a-f-]{36}$/i.test(user)) {
    await sb.from('roarmail_watch_seen').upsert({ user_id: user, account_id: account, validity: Number(b.validity) || 0, last_uid: Number(b.last) || 0, updated_at: new Date().toISOString() })
    return reply({ ok: true })
  }
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  const { data: au } = await sb.auth.getUser(token)
  // the watch reads an Inbox while the person is away, with no sign-in of theirs at hand: allowed only for someone who
  // turned notifications on, for an account they did not keep quiet
  let watching = false
  if (b.watch === true && user && au?.user?.id !== user) {
    const { data: w } = await sb.from('roarmail_watch').select('enabled, muted').eq('user_id', user).maybeSingle()
    watching = !!w?.enabled && !(w.muted || []).includes(account)
  }
  if (!user || (au?.user?.id !== user && !watching)) return reply({ error: 'Sign in first' }, 401)
  const { data: row } = await sb.from('roarmail_cloud').select('cfg, email').eq('user_id', user).eq('account_id', account).maybeSingle()
  if (!row) return reply({ error: 'missing' }, 404)
  const { data: secret } = await sb.rpc('roarmail_cloud_secret', { p_user: user, p_account: account })
  if (!secret) return reply({ error: 'missing' }, 404)
  const cfg = row.cfg as any
  if (cfg.kind !== 'microsoft') return reply({ cfg, email: row.email, pass: secret })
  const r = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: MS_CLIENT, scope: MS_SCOPE, grant_type: 'refresh_token', refresh_token: secret }).toString(),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) return reply({ error: 'Microsoft sign-in expired. Add this account again.' }, 401)
  if (j.refresh_token && j.refresh_token !== secret) await sb.rpc('roarmail_cloud_put', { p_user: user, p_account: account, p_email: row.email, p_cfg: cfg, p_secret: j.refresh_token })
  return reply({ cfg, email: row.email, access: j.access_token })
})

async function watchers() {
  const { data: ws } = await sb.from('roarmail_watch').select('user_id, muted').eq('enabled', true)
  if (!ws?.length) return { users: [] }
  const ids = ws.map((w) => w.user_id)
  const [{ data: accs }, { data: seen }, { data: cb }, { data: sy }] = await Promise.all([
    sb.from('roarmail_cloud').select('user_id, account_id, email').in('user_id', ids),
    sb.from('roarmail_watch_seen').select('user_id, account_id, validity, last_uid').in('user_id', ids),
    sb.from('roarmail_cloud_blocks').select('user_id, emails, domains').in('user_id', ids),
    sb.from('roarmail_sync').select('user_id, data').in('user_id', ids),
  ])
  return {
    users: ws.map((w) => {
      const emails = new Set<string>(), domains = new Set<string>()
      for (const x of (cb || []).filter((r) => r.user_id === w.user_id)) { (x.emails || []).forEach((e: string) => emails.add(String(e).toLowerCase())); (x.domains || []).forEach((d: string) => domains.add(String(d).toLowerCase())) }
      for (const x of (sy || []).filter((r) => r.user_id === w.user_id)) {
        const t = (x.data as any)?.tables || {}
        for (const c of t.contacts || []) if (c?.blocked && c.email) emails.add(String(c.email).toLowerCase())
        for (const r of t.block_rules || []) if (r?.kind === 'domain' && r.value) domains.add(String(r.value).toLowerCase())
      }
      return {
        user: w.user_id,
        accounts: (accs || []).filter((a) => a.user_id === w.user_id && !(w.muted || []).includes(a.account_id)).map((a) => {
          const s = (seen || []).find((x) => x.user_id === w.user_id && x.account_id === a.account_id)
          return { account: a.account_id, validity: s?.validity || 0, last: s?.last_uid || 0 }
        }),
        block: { emails: [...emails], domains: [...domains] },
      }
    }).filter((u) => u.accounts.length),
  }
}
