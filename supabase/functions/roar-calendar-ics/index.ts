// The Roar Calendar as a calendar link (Alex, 3 Nov 2026: "on my iPhone's calendar too"). Edge Function roar-calendar-ics in
// RoarMe's project, without the usual sign-in check: the secret token in the link is the key (roar_calendar_feeds; a new
// token from the account page stops the old link). Apple, Google and Outlook Calendar subscribe to it and read it again
// on their own schedule. Read only: changes are made in Roar.
const H = { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache, max-age=0', 'Access-Control-Allow-Origin': '*' }

const esc = (s: unknown) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const utc = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const day = (s: string) => s.slice(0, 10).replace(/-/g, '')
const nextDay = (s: string) => { const d = new Date(`${s.slice(0, 10)}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10).replace(/-/g, '') }
/** lines of at most 75 octets, the rest on lines that start with a space (RFC 5545) */
function fold(line: string) {
  const enc = new TextEncoder()
  if (enc.encode(line).length <= 75) return line
  const out: string[] = []
  let cur = ''
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = '' }
    cur += ch
  }
  out.push(cur)
  return out.join('\r\n ')
}

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get('t') || ''
  if (!/^[0-9a-f]{48}$/.test(token)) return new Response('Not found', { status: 404 })
  const url = Deno.env.get('SUPABASE_URL')!
  const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const A = { apikey: svc, Authorization: `Bearer ${svc}` }
  const get = async (path: string) => { const r = await fetch(`${url}/rest/v1/${path}`, { headers: A }); return r.ok ? r.json() : [] }
  const feed = (await get(`roar_calendar_feeds?token=eq.${token}&select=user_id,include_tasks`))[0]
  if (!feed) return new Response('Not found', { status: 404 })
  const uid = feed.user_id
  const from = new Date(Date.now() - 120 * 864e5).toISOString(), to = new Date(Date.now() + 400 * 864e5).toISOString()
  const shared = (await get(`roar_calendar_shares?user_id=eq.${uid}&select=event_id`)).map((r: any) => r.event_id)
  const who = shared.length ? `or=(owner.eq.${uid},id.in.(${shared.join(',')}))` : `owner=eq.${uid}`
  const events = await get(`roar_calendar_events?${who}&starts_at=gte.${from}&starts_at=lte.${to}&select=*&order=starts_at&limit=5000`)
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Mad Lions//Roar Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Roar', 'X-WR-TIMEZONE:Europe/Athens', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H']
  const stamp = utc(new Date())
  for (const e of events) {
    const cancelled = !!e.deleted_at
    if (cancelled && Date.now() - Date.parse(e.deleted_at) > 30 * 864e5) continue
    lines.push('BEGIN:VEVENT', `UID:${e.id}@roar.themadlions.com`, `DTSTAMP:${stamp}`, `LAST-MODIFIED:${utc(new Date(e.updated_at))}`,
      `SEQUENCE:${Math.floor(Date.parse(e.updated_at) / 1000) % 2147483647}`)
    if (e.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${day(e.starts_at)}`, `DTEND;VALUE=DATE:${e.ends_at ? nextDay(e.ends_at) : nextDay(e.starts_at)}`)
    } else {
      const s = new Date(e.starts_at), en = e.ends_at ? new Date(e.ends_at) : new Date(s.getTime() + 3600e3)
      lines.push(`DTSTART:${utc(s)}`, `DTEND:${utc(en)}`)
    }
    lines.push(`SUMMARY:${esc(e.title)}`)
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`)
    const note = [e.notes, e.source_url].filter(Boolean).join('\n')
    if (note) lines.push(`DESCRIPTION:${esc(note)}`)
    if (e.source_url) lines.push(`URL:${esc(e.source_url)}`)
    if (cancelled) lines.push('STATUS:CANCELLED')
    if (e.remind_minutes != null && !cancelled) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.title)}`, `TRIGGER:-PT${Math.max(0, e.remind_minutes)}M`, 'END:VALARM')
    lines.push('END:VEVENT')
  }
  // RoarMe tasks with a due date, as all-day items (the person can turn them off on the account page)
  if (feed.include_tasks) {
    const tasks = await get(`roar_tasks?or=(created_by.eq.${uid},assignee.eq.${uid})&due=not.is.null&status=neq.declined&select=id,title,notes,due,status,updated_at&limit=2000`)
    for (const k of tasks) {
      lines.push('BEGIN:VEVENT', `UID:task-${k.id}@roar.themadlions.com`, `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${day(k.due)}`, `DTEND;VALUE=DATE:${nextDay(k.due)}`,
        `SUMMARY:${k.status === 'done' ? '✓ ' : '☐ '}${esc(k.title)}`, 'TRANSP:TRANSPARENT')
      if (k.notes) lines.push(`DESCRIPTION:${esc(k.notes)}`)
      lines.push('END:VEVENT')
    }
  }
  lines.push('END:VCALENDAR')
  return new Response(lines.map(fold).join('\r\n') + '\r\n', { headers: H })
})
