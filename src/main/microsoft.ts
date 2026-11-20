// Sign in with Microsoft (29 Oct 2026): Outlook.com and Microsoft 365 no longer take a password over IMAP and SMTP,
// only a token from Microsoft's own sign-in (OAuth 2.0 with PKCE). The sign-in page opens in the browser, Microsoft
// sends the browser back to a little server on this computer, and the code it brings is traded for tokens.
// The refresh token is kept like a password (sealed in the system key store); access tokens live only in memory.
import http from 'http'
import { createHash, randomBytes } from 'crypto'
import { clipboard, dialog, net, shell } from 'electron'

/**
 * RoarMail's app registration in Microsoft Entra (portal.azure.com > App registrations): "Accounts in any
 * organizational directory and personal Microsoft accounts", platform "Mobile and desktop applications" with the
 * redirect URI http://localhost, public client flows on. The id is not a secret.
 */
const BUILT_IN = '1449effc-2b8b-443b-9523-e2f84dd6b677'
export const MS_CLIENT_ID = process.env.ROARMAIL_MS_CLIENT_ID || BUILT_IN

const AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0'
const SCOPE = 'offline_access openid email profile https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send'
/** what is kept in the account's secret instead of a password */
export const OAUTH_PREFIX = 'oauth2:microsoft:'

export interface MsTokens { access: string; refresh: string; expires: number; email: string; name: string }

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function claims(idToken: string | undefined): { email: string; name: string } {
  try {
    const p = JSON.parse(Buffer.from((idToken || '').split('.')[1] || '', 'base64').toString('utf8'))
    return { email: String(p.email || p.preferred_username || '').toLowerCase(), name: String(p.name || '') }
  } catch { return { email: '', name: '' } }
}

async function token(form: Record<string, string>): Promise<any> {
  const r = await net.fetch(`${AUTH}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: MS_CLIENT_ID, scope: SCOPE, ...form }).toString(),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) {
    // a refresh token that was revoked or expired: the account has to sign in again
    if (j.error === 'invalid_grant' || j.error === 'interaction_required') throw new Error('auth: Microsoft sign-in expired')
    throw new Error(`Microsoft: ${j.error_description || j.error || r.status}`)
  }
  return j
}

const page = (ok: boolean) => `<!doctype html><meta charset="utf-8"><title>RoarMail</title>
<body style="font:16px -apple-system,Segoe UI,sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><p style="font-size:28px;letter-spacing:.14em;margin:0 0 12px"><b style="font-weight:300">ROAR</b><b style="color:#d40000">MAIL</b></p>
<p>${ok ? 'Έτοιμο. Μπορείς να κλείσεις αυτή τη σελίδα. / Done. You can close this page.' : 'Η σύνδεση δεν ολοκληρώθηκε. / Sign-in did not finish.'}</p></div>`

/**
 * The Mac App Store build (20 Nov 2026): Apple does not let it listen on a port (App Review flagged the
 * network.server entitlement), so there the sign-in is Microsoft's device code flow: RoarMail shows a short code
 * (also copied), Microsoft's page opens, the person pastes the code and signs in, and RoarMail asks Microsoft every
 * few seconds until the tokens are ready. Needs "Allow public client flows" on the app registration, which is on.
 */
async function signInWithCode(): Promise<MsTokens> {
  const r = await net.fetch(`${AUTH}/devicecode`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: MS_CLIENT_ID, scope: SCOPE }).toString(),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok || !d.device_code) throw new Error(`Microsoft: ${d.error_description || d.error || r.status}`)
  clipboard.writeText(d.user_code)
  shell.openExternal(d.verification_uri || 'https://microsoft.com/devicelogin').catch(() => {})
  let stop = false
  dialog.showMessageBox({
    type: 'info', buttons: ['Cancel'], title: 'Sign in with Microsoft',
    message: `Your code: ${d.user_code}`,
    detail: 'It is copied. Paste it on the Microsoft page that just opened and sign in. RoarMail continues by itself.\n\nΟ κωδικός αντιγράφηκε. Επικόλλησέ τον στη σελίδα της Microsoft που άνοιξε και συνδέσου.',
  }).then(() => { stop = true }).catch(() => {})
  const until = Date.now() + (Number(d.expires_in) || 900) * 1e3
  let wait = (Number(d.interval) || 5) * 1e3
  while (Date.now() < until) {
    await new Promise((ok) => setTimeout(ok, wait))
    if (stop) throw new Error('ms_cancelled')
    const t = await net.fetch(`${AUTH}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: MS_CLIENT_ID, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code }).toString(),
    })
    const j = await t.json().catch(() => ({}))
    if (t.ok && j.access_token) {
      const who = claims(j.id_token)
      return { access: j.access_token, refresh: j.refresh_token || '', expires: Date.now() + (Number(j.expires_in) || 3600) * 1e3, email: who.email, name: who.name }
    }
    if (j.error === 'authorization_pending') continue
    if (j.error === 'slow_down') { wait += 5e3; continue }
    if (j.error === 'authorization_declined') throw new Error('ms_cancelled')
    if (j.error === 'expired_token') break
    throw new Error(`Microsoft: ${j.error_description || j.error || t.status}`)
  }
  throw new Error('ms_timeout')
}

/** the whole sign-in: browser, consent, back to RoarMail with tokens (5 minutes to finish) */
export async function signIn(loginHint?: string): Promise<MsTokens> {
  if (!MS_CLIENT_ID) throw new Error('ms_setup')
  if (process.mas) return signInWithCode()
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  const server = http.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  // exactly as registered in Entra (http://localhost, any port, no path)
  const redirect = `http://localhost:${port}`
  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ms_timeout')), 5 * 60e3)
      server.on('request', (req, res) => {
        const u = new URL(req.url || '/', redirect)
        if (u.pathname !== '/') { res.writeHead(404).end(); return }
        const got = u.searchParams.get('code')
        const ok = !!got && u.searchParams.get('state') === state
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(ok))
        clearTimeout(timer)
        if (ok) resolve(got!)
        else reject(new Error(u.searchParams.get('error') === 'access_denied' ? 'ms_cancelled' : `Microsoft: ${u.searchParams.get('error_description') || 'sign-in failed'}`))
      })
      const q = new URLSearchParams({
        client_id: MS_CLIENT_ID, response_type: 'code', redirect_uri: redirect, response_mode: 'query', scope: SCOPE,
        state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
      })
      if (loginHint) q.set('login_hint', loginHint)
      shell.openExternal(`${AUTH}/authorize?${q}`).catch(reject)
    })
    const j = await token({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier })
    const who = claims(j.id_token)
    return { access: j.access_token, refresh: j.refresh_token || '', expires: Date.now() + (Number(j.expires_in) || 3600) * 1e3, email: who.email, name: who.name }
  } finally {
    server.close()
  }
}

/** a fresh access token from the refresh token; Microsoft may hand back a new refresh token too */
export async function refresh(refreshToken: string): Promise<{ access: string; refresh: string; expires: number }> {
  if (!MS_CLIENT_ID) throw new Error('ms_setup')
  const j = await token({ grant_type: 'refresh_token', refresh_token: refreshToken })
  return { access: j.access_token, refresh: j.refresh_token || refreshToken, expires: Date.now() + (Number(j.expires_in) || 3600) * 1e3 }
}
