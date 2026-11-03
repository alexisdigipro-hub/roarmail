// The Roar Account's admin view (Alex, 3 Nov 2026: "every account, statistics, what goes on"). Edge Function roar-admin in
// RoarMe's project. Only a signed-in person listed in roar_admins gets an answer; it reads with the project's service role
// (never in a page) and returns the accounts with what each Roar app keeps for them, and totals. Read only.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const who = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: req.headers.get('Authorization') || '', apikey: Deno.env.get('SUPABASE_ANON_KEY') || '' } })
    if (!who.ok) return reply({ error: 'signin' }, 401)
    const me = await who.json()
    const H = { apikey: svc, Authorization: `Bearer ${svc}` }
    const rest = async (path: string) => { const r = await fetch(`${url}/rest/v1/${path}`, { headers: H }); return r.ok ? r.json() : [] }
    const admin = await rest(`roar_admins?user_id=eq.${me.id}&select=user_id`)
    if (!Array.isArray(admin) || !admin.length) return reply({ error: 'not-admin' }, 403)

    // every account (the Auth admin API, a page at a time)
    const users: any[] = []
    for (let page = 1; page <= 20; page++) {
      const r = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: H })
      if (!r.ok) break
      const j = await r.json()
      const list = j.users || []
      users.push(...list)
      if (list.length < 200) break
    }
    // what each app keeps, counted per person (owner columns), in one pass per table
    const per = async (table: string, col: string) => {
      const rows = await rest(`${table}?select=${col}&limit=100000`)
      const m: Record<string, number> = {}
      for (const r of Array.isArray(rows) ? rows : []) { const k = r[col]; if (k) m[k] = (m[k] || 0) + 1 }
      return m
    }
    const [profiles, scripts, lists, ordinos, transfers, devices, tasks, members] = await Promise.all([
      rest('roar_profiles?select=id,username,display_name,last_seen&limit=100000'),
      per('roarwriter_scripts', 'owner'), per('roarlist_projects', 'owner'), per('roardino_ordinos', 'owner'),
      per('roar_transfer_links', 'created_by'), per('roarmail_devices', 'user_id'), per('roar_tasks', 'created_by'), per('roar_members', 'user_id'),
    ])
    const ai = await rest('roarmail_ai_usage?select=user_id,n,day&limit=100000')
    const aiBy: Record<string, number> = {}
    let aiToday = 0
    const today = new Date().toISOString().slice(0, 10)
    for (const r of Array.isArray(ai) ? ai : []) { aiBy[r.user_id] = (aiBy[r.user_id] || 0) + (r.n || 0); if (r.day === today) aiToday += r.n || 0 }
    const prof: Record<string, any> = {}
    for (const p of Array.isArray(profiles) ? profiles : []) prof[p.id] = p

    const accounts = users.map((u) => {
      const p = prof[u.id] || {}
      return {
        id: u.id, email: u.email, created: u.created_at, lastSignIn: u.last_sign_in_at || null, confirmed: !!u.email_confirmed_at,
        name: p.display_name || null, username: p.username || null, lastSeen: p.last_seen || null,
        apps: {
          roarme: (members[u.id] || 0) > 0 || !!p.username, roarmeChats: members[u.id] || 0,
          roarwriter: scripts[u.id] || 0, roarlist: lists[u.id] || 0, roardino: ordinos[u.id] || 0,
          roartransfer: transfers[u.id] || 0, roarmail: devices[u.id] || 0, tasks: tasks[u.id] || 0, ai: aiBy[u.id] || 0,
        },
      }
    }).sort((a, b) => String(b.created).localeCompare(String(a.created)))
    const day = 864e5, now = Date.now()
    const since = (d: string | null, n: number) => !!d && now - Date.parse(d) < n * day
    const totals = {
      accounts: accounts.length,
      new7: accounts.filter((a) => since(a.created, 7)).length, new30: accounts.filter((a) => since(a.created, 30)).length,
      active7: accounts.filter((a) => since(a.lastSignIn, 7) || since(a.lastSeen, 7)).length,
      roarme: accounts.filter((a) => a.apps.roarme).length, roarwriter: accounts.filter((a) => a.apps.roarwriter).length,
      roarlist: accounts.filter((a) => a.apps.roarlist).length, roardino: accounts.filter((a) => a.apps.roardino).length,
      roartransfer: accounts.filter((a) => a.apps.roartransfer).length, roarmail: accounts.filter((a) => a.apps.roarmail).length,
      aiToday,
    }
    // sign-ups per day, the last 30 days
    const byDay: Record<string, number> = {}
    for (let i = 29; i >= 0; i--) byDay[new Date(now - i * day).toISOString().slice(0, 10)] = 0
    for (const a of accounts) { const d = String(a.created).slice(0, 10); if (d in byDay) byDay[d]++ }
    return reply({ totals, signups: byDay, accounts })
  } catch (e) {
    return reply({ error: String((e as Error)?.message || e) }, 500)
  }
})
