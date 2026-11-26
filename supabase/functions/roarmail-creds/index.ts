// roarmail-creds: hands one mail account's sign-in to RoarMail Live (the Cloudflare container that keeps the mail
// connections open, live/ in this repository), and to nothing else. Two locks: the shared LIVE_KEY that only Live and
// this function know, and the person's own RoarMe sign-in, which must be the owner of the account asked for. The
// password stays in Supabase Vault; Microsoft accounts get a fresh access token, never the refresh token.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const MS_CLIENT = '1449effc-2b8b-443b-9523-e2f84dd6b677'
const MS_SCOPE = 'offline_access openid email profile https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send'
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  const key = Deno.env.get('LIVE_KEY') || ''
  if (!key || req.headers.get('x-live-key') !== key) return reply({ error: 'No' }, 401)
  let b: any = {}
  try { b = await req.json() } catch { return reply({ error: 'Bad request' }, 400) }
  const user = String(b.user || ''), account = String(b.account || '').slice(0, 80)
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  const { data: au } = await sb.auth.getUser(token)
  if (!user || au?.user?.id !== user) return reply({ error: 'Sign in first' }, 401)
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
