// One sign-in for every Roar app (Alex, 3 Nov 2026). An app that is not signed in asks for a code ("start"), opens
// https://themadlions.com/account/?connect=CODE and waits ("poll", with the secret only it holds). On the account page,
// already signed in, the person sees which app asks ("look") and presses Allow ("allow"): this function makes a one-time
// sign-in token for that person (no email is sent) and the app trades it for its own session with
// supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }). Codes live 10 minutes and work once.
// Table: public.roar_connect (roarmail/supabase/roar-account.sql). Deploy with verify_jwt off: "allow" checks the JWT itself.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const URL_ = Deno.env.get('SUPABASE_URL')!
const admin = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const APPS: Record<string, string> = {
  roarmail: 'RoarMail', roarwriter: 'RoarWriter', roarlist: 'RoarList', roardino: 'Roardino', roartransfer: 'RoarTransfer',
  roarme: 'RoarMe', roarkit: 'RoarKit', roarmorph: 'RoarMorph', roarplay: 'RoarPlay', roarmind: 'RoarMind', roargrab: 'RoarGrab',
}
const LIFE = 10 * 60 * 1000
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const out = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const sha = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
const norm = (c: unknown) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2')

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const r = crypto.getRandomValues(new Uint8Array(8))
  const s = [...r].map((x) => A[x % A.length]).join('')
  return s.slice(0, 4) + '-' + s.slice(4)
}

async function userOf(req: Request) {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!jwt) return null
  const { data } = await admin.auth.getUser(jwt)
  if (!data?.user) return null
  let aal = 'aal1'
  try { aal = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).aal || 'aal1' } catch { /* keep aal1 */ }
  return { user: data.user, aal }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return out({ error: 'POST only' }, 405)
  let b: Record<string, unknown> = {}
  try { b = await req.json() } catch { return out({ error: 'bad request' }, 400) }
  const old = new Date(Date.now() - LIFE).toISOString()

  if (b.do === 'start') {
    const app = String(b.app || '').toLowerCase()
    if (!APPS[app]) return out({ error: 'unknown app' }, 400)
    await admin.from('roar_connect').delete().lt('created_at', old)
    const secret = hex(crypto.getRandomValues(new Uint8Array(32)))
    for (let i = 0; i < 5; i++) {
      const code = newCode()
      const { error } = await admin.from('roar_connect').insert({ code, secret_hash: await sha(secret), app })
      if (!error) return out({ code, secret, url: `https://themadlions.com/account/?connect=${code}`, expires_in: LIFE / 1000 })
    }
    return out({ error: 'try again' }, 500)
  }

  const code = norm(b.code)
  const { data: row } = await admin.from('roar_connect').select('*').eq('code', code).maybeSingle()
  const live = row && row.created_at > old

  if (b.do === 'poll') {
    if (!live) return out({ expired: true })
    if (row.secret_hash !== await sha(String(b.secret || ''))) return out({ error: 'not yours' }, 403)
    if (!row.token_hash) return out({ waiting: true })
    await admin.from('roar_connect').delete().eq('code', code)
    const { data: u } = await admin.auth.admin.getUserById(row.user_id)
    return out({ token_hash: row.token_hash, email: u?.user?.email || null })
  }

  const me = await userOf(req)
  if (!me) return out({ error: 'sign in first' }, 401)

  if (b.do === 'look') {
    if (!live || row.token_hash) return out({ error: 'This code has expired or was used. Ask the app for a new one.' }, 404)
    return out({ app: row.app, name: APPS[row.app] || row.app })
  }

  if (b.do === 'allow') {
    if (!live || row.token_hash) return out({ error: 'This code has expired or was used. Ask the app for a new one.' }, 404)
    const { data: f } = await admin.auth.admin.mfa.listFactors({ userId: me.user.id })
    if ((f?.factors || []).some((x: { status: string }) => x.status === 'verified') && me.aal !== 'aal2') return out({ error: 'two-step verification needed' }, 403)
    const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: me.user.email! })
    if (error || !link?.properties?.hashed_token) return out({ error: error?.message || 'could not make the sign-in' }, 500)
    await admin.from('roar_connect').update({ user_id: me.user.id, token_hash: link.properties.hashed_token, allowed_at: new Date().toISOString() }).eq('code', code)
    return out({ ok: true, name: APPS[row.app] || row.app })
  }

  if (b.do === 'deny') {
    if (row && !row.token_hash) await admin.from('roar_connect').delete().eq('code', code)
    return out({ ok: true })
  }
  return out({ error: 'unknown action' }, 400)
})
