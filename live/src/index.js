// RoarMail Live, the front door (Cloudflare Worker). It checks the RoarMe sign-in, then hands the call to that
// person's own container (MailBox, ../container/server.mjs), which keeps their mail connections open.
import { Container, getContainer } from '@cloudflare/containers'

export class MailBox extends Container {
  defaultPort = 8080
  sleepAfter = '60m' // an hour after the last call, so opening Mail again later in the day finds it awake
  constructor(ctx, env) {
    super(ctx, env)
    this.envVars = { SUPABASE_URL: env.SUPABASE_URL, LIVE_KEY: env.LIVE_KEY }
  }
}

const ORIGINS = ['https://roarme.app', 'https://www.roarme.app', 'https://alexisdigipro-hub.github.io', 'capacitor://localhost', 'app://roarme', 'http://localhost:5173']
const seen = new Map() // a token already checked -> { user, at }

async function who(env, token) {
  const had = seen.get(token)
  if (had && Date.now() - had.at < 5 * 60e3) return had.user
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_KEY } })
  if (!r.ok) return ''
  const user = (await r.json()).id || ''
  if (user) { seen.set(token, { user, at: Date.now() }); if (seen.size > 500) seen.delete(seen.keys().next().value) }
  return user
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || ''
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : 'https://roarme.app',
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Expose-Headers': 'X-File-Name',
      Vary: 'Origin',
    }
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
    const url = new URL(req.url)
    if (url.pathname === '/health') return new Response('ok', { headers: cors })
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    const user = token ? await who(env, token) : ''
    if (!user) return json({ error: 'Sign in first' }, 401)
    const box = getContainer(env.MAILBOX, user)
    const body = await req.text()
    // a container that is waking (or was just replaced) can refuse the first call: it is asked again, three times in
    // all, before the app is told to go the slow way (26 Nov)
    let r = null, last = null
    for (let i = 0; i < 3 && !r; i++) {
      try {
        const got = await box.fetch(new Request('http://mailbox/do', {
          method: 'POST', body,
          headers: { 'Content-Type': 'application/json', 'x-user': user, 'x-live-key': env.LIVE_KEY, 'x-user-token': token },
        }))
        if (got.status >= 500 && got.status !== 502) { last = `status ${got.status}`; await new Promise((ok) => setTimeout(ok, 600 * (i + 1))); continue }
        r = got
      } catch (e) { last = String(e?.message || e); console.error('mailbox', last); await new Promise((ok) => setTimeout(ok, 600 * (i + 1))) }
    }
    if (!r) return json({ error: 'waking', detail: last }, 503)
    const h = new Headers(r.headers)
    for (const [k, v] of Object.entries(cors)) h.set(k, v)
    return new Response(r.body, { status: r.status, headers: h })
  },
}
