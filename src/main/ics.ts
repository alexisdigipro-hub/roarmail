// Calendar invitations (iCalendar, RFC 5545, and iMIP, RFC 6047): reading the invitation a message carries, and
// writing the REPLY that answers it. Plain functions (no Electron), checked by test/ics.test.ts.
import type { Address, Invite, InviteAnswer } from '../shared/api'

/** one content line: NAME;PARAM=V;PARAM="V, W":value (unfolded, the value still escaped) */
export interface IcsProp { name: string; params: Record<string, string>; value: string; raw: string }
/** a component (VCALENDAR, VEVENT, VTIMEZONE, STANDARD…) with its lines and the components inside it */
export interface IcsComp { name: string; props: IcsProp[]; comps: IcsComp[]; raw: string[] }

/** long lines are folded: a line break followed by a space or a tab continues the line above */
export function unfold(text: string): string[] {
  return text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((l) => l.trim() !== '')
}

export function parseLine(line: string): IcsProp {
  // the value starts at the first colon outside quotes
  let quoted = false, at = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    else if (c === ':' && !quoted) { at = i; break }
  }
  const head = at < 0 ? line : line.slice(0, at)
  const value = at < 0 ? '' : line.slice(at + 1)
  const parts: string[] = []
  let cur = ''
  quoted = false
  for (const c of head) {
    if (c === '"') quoted = !quoted
    if (c === ';' && !quoted) { parts.push(cur); cur = '' } else cur += c
  }
  parts.push(cur)
  const params: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: parts[0].toUpperCase(), params, value, raw: line }
}

export function parseIcs(text: string): IcsComp | null {
  const root: IcsComp = { name: '', props: [], comps: [], raw: [] }
  const stack: IcsComp[] = [root]
  for (const line of unfold(text)) {
    const p = parseLine(line)
    const top = stack[stack.length - 1]
    if (p.name === 'BEGIN') {
      const c: IcsComp = { name: p.value.trim().toUpperCase(), props: [], comps: [], raw: [line] }
      top.comps.push(c)
      for (const s of stack.slice(1)) s.raw.push(line)
      stack.push(c)
    } else if (p.name === 'END') {
      for (const s of stack.slice(1)) s.raw.push(line)
      if (stack.length > 1) stack.pop()
    } else {
      top.props.push(p)
      for (const s of stack.slice(1)) s.raw.push(line)
    }
  }
  return root.comps.find((c) => c.name === 'VCALENDAR') || null
}

const prop = (c: IcsComp | undefined, name: string) => c?.props.find((p) => p.name === name)

/** text values carry \n, \, \; and \\ */
export const unescapeText = (s: string) => s.replace(/\\([nN,;\\])/g, (_m, c) => (c === 'n' || c === 'N' ? '\n' : c))

// Outlook and Exchange name their zones the Windows way; the common ones, as Intl knows them
const WINDOWS_ZONES: Record<string, string> = {
  'GTB Standard Time': 'Europe/Athens', 'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'Turkey Standard Time': 'Europe/Istanbul', 'Israel Standard Time': 'Asia/Jerusalem', 'Russian Standard Time': 'Europe/Moscow',
  'Arabian Standard Time': 'Asia/Dubai', 'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo', 'AUS Eastern Standard Time': 'Australia/Sydney', 'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
}

function knownZone(tz: string): string | null {
  const tries = [tz, WINDOWS_ZONES[tz], (tz.match(/([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/) || [])[1]].filter(Boolean) as string[]
  for (const z of tries) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z } catch { /* not a zone Intl knows */ }
  }
  return null
}

/** how far the zone is ahead of UTC at that moment, in ms */
function zoneOffset(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms))
  const g = (k: string) => Number(parts.find((p) => p.type === k)?.value)
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - Math.floor(ms / 1000) * 1000
}

/** a wall-clock time in a zone, as UTC ms (the hour that does not exist when clocks go forward moves on) */
function zonedToUtc(f: number[], tz: string): number {
  const wall = Date.UTC(f[0], f[1] - 1, f[2], f[3], f[4], f[5])
  let ms = wall - zoneOffset(wall, tz)
  const again = zoneOffset(ms, tz)
  if (wall - again !== ms) ms = wall - again
  return ms
}

const offsetMs = (v: string) => {
  const m = v.trim().match(/^([+-])(\d\d)(\d\d)(\d\d)?$/)
  return m ? (m[1] === '-' ? -1 : 1) * ((Number(m[2]) * 60 + Number(m[3])) * 60 + Number(m[4] || 0)) * 1000 : 0
}

/** a zone the message describes itself (VTIMEZONE) and Intl does not know: its yearly STANDARD / DAYLIGHT changes */
function vtimezoneToUtc(f: number[], tz: IcsComp): number | null {
  const wall = Date.UTC(f[0], f[1] - 1, f[2], f[3], f[4], f[5])
  const changes: { at: number; offset: number }[] = []
  for (const sub of tz.comps.filter((c) => c.name === 'STANDARD' || c.name === 'DAYLIGHT')) {
    const to = offsetMs(prop(sub, 'TZOFFSETTO')?.value || '')
    const start = (prop(sub, 'DTSTART')?.value || '').match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)/)
    if (!start) continue
    const [h, mi, s] = [Number(start[4]), Number(start[5]), Number(start[6])]
    const rule = Object.fromEntries((prop(sub, 'RRULE')?.value || '').split(';').map((x) => x.split('=') as [string, string]))
    for (const year of [f[0] - 1, f[0]]) {
      let at: number
      if (rule.FREQ === 'YEARLY' && rule.BYMONTH && rule.BYDAY) {
        // e.g. BYMONTH=3;BYDAY=-1SU: the last Sunday of March
        const m = rule.BYDAY.match(/^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/)
        if (!m) continue
        const n = Number(m[1] || 1), wd = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(m[2]), mon = Number(rule.BYMONTH) - 1
        let day: number
        if (n > 0) { const first = new Date(Date.UTC(year, mon, 1)).getUTCDay(); day = 1 + ((wd - first + 7) % 7) + (n - 1) * 7 }
        else { const lastDay = new Date(Date.UTC(year, mon + 1, 0)).getUTCDate(); const last = new Date(Date.UTC(year, mon, lastDay)).getUTCDay(); day = lastDay - ((last - wd + 7) % 7) + (n + 1) * 7 }
        at = Date.UTC(year, mon, day, h, mi, s)
      } else if (year === Number(start[1])) {
        at = Date.UTC(year, Number(start[2]) - 1, Number(start[3]), h, mi, s)
      } else continue
      changes.push({ at, offset: to })
    }
  }
  if (!changes.length) return null
  changes.sort((a, b) => a.at - b.at)
  const now = [...changes].reverse().find((c) => c.at <= wall) || changes[0]
  return wall - now.offset
}

/** DTSTART / DTEND as UTC ms: UTC (Z), a TZID, a floating local time, or a whole day (VALUE=DATE) */
export function icsTime(p: IcsProp, zones: IcsComp[] = []): { ms: number; allDay: boolean } | null {
  const v = p.value.trim()
  const d = v.match(/^(\d{4})(\d\d)(\d\d)$/)
  if (d || p.params.VALUE === 'DATE') {
    const m = d || v.match(/^(\d{4})(\d\d)(\d\d)/)
    return m ? { ms: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])), allDay: true } : null
  }
  const m = v.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)?(Z?)$/)
  if (!m) return null
  const f = [m[1], m[2], m[3], m[4], m[5], m[6] || '0'].map(Number)
  if (m[7] === 'Z') return { ms: Date.UTC(f[0], f[1] - 1, f[2], f[3], f[4], f[5]), allDay: false }
  const tzid = p.params.TZID
  if (tzid) {
    const z = knownZone(tzid)
    if (z) return { ms: zonedToUtc(f, z), allDay: false }
    const own = zones.find((c) => prop(c, 'TZID')?.value === tzid)
    const ms = own ? vtimezoneToUtc(f, own) : null
    if (ms != null) return { ms, allDay: false }
  }
  // floating: the same wall-clock time wherever you are
  return { ms: new Date(f[0], f[1] - 1, f[2], f[3], f[4], f[5]).getTime(), allDay: false }
}

/** P1D, PT1H30M, -PT15M… in ms */
export function durationMs(v: string): number {
  const m = v.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return 0
  const n = (i: number) => Number(m[i] || 0)
  return (m[1] === '-' ? -1 : 1) * ((((n(2) * 7 + n(3)) * 24 + n(4)) * 60 + n(5)) * 60 + n(6)) * 1000
}

const mailto = (v: string) => v.trim().replace(/^mailto:/i, '').toLowerCase()
const ANSWERS: Record<string, InviteAnswer> = { ACCEPTED: 'accepted', TENTATIVE: 'tentative', DECLINED: 'declined' }

/** the event an invitation is about: the series (no RECURRENCE-ID) when there is one */
function mainEvent(cal: IcsComp): IcsComp | undefined {
  const events = cal.comps.filter((c) => c.name === 'VEVENT')
  return events.find((e) => !prop(e, 'RECURRENCE-ID')) || events[0]
}

/**
 * the invitation in an iCalendar text: title, times, place, organizer and how one of these addresses answered
 * (its ATTENDEE's PARTSTAT); null when it holds no event
 */
export function readInvite(text: string, mine: string[] = []): Invite | null {
  const cal = parseIcs(text)
  const ev = cal && mainEvent(cal)
  if (!cal || !ev) return null
  const zones = cal.comps.filter((c) => c.name === 'VTIMEZONE')
  const ds = prop(ev, 'DTSTART')
  const start = ds ? icsTime(ds, zones) : null
  if (!start) return null
  const de = prop(ev, 'DTEND'), du = prop(ev, 'DURATION')
  const end = de ? icsTime(de, zones)?.ms ?? null : du ? start.ms + durationMs(du.value) : start.allDay ? start.ms + 864e5 : null
  const org = prop(ev, 'ORGANIZER')
  const me = new Set(mine.map((x) => x.toLowerCase()))
  const att = ev.props.find((p) => p.name === 'ATTENDEE' && me.has(mailto(p.value)))
  return {
    method: (prop(cal, 'METHOD')?.value || 'PUBLISH').trim().toUpperCase(),
    uid: (prop(ev, 'UID')?.value || '').trim(),
    title: unescapeText(prop(ev, 'SUMMARY')?.value || '').trim(),
    start: start.ms, end, allDay: start.allDay,
    location: unescapeText(prop(ev, 'LOCATION')?.value || '').trim(),
    organizer: org ? { name: org.params.CN || undefined, address: mailto(org.value) } : null,
    answer: (att && ANSWERS[(att.params.PARTSTAT || '').toUpperCase()]) || null,
  }
}

/** the ATTENDEE address of these that the invitation names (as it wrote it), else the first of them */
export function attendeeFor(text: string, mine: string[]): string {
  const cal = parseIcs(text)
  const ev = cal && mainEvent(cal)
  const me = new Set(mine.map((x) => x.toLowerCase()))
  const hit = ev?.props.find((p) => p.name === 'ATTENDEE' && me.has(mailto(p.value)))
  return hit ? hit.value.trim().replace(/^mailto:/i, '') : mine[0] || ''
}

/** content lines longer than 75 octets are folded (UTF-8 aware: a letter is never cut in two) */
export function fold(line: string): string {
  const out: string[] = []
  let cur = '', size = 0, limit = 75
  for (const ch of line) {
    const n = Buffer.byteLength(ch)
    if (size + n > limit) { out.push(cur); cur = ' '; size = 1; limit = 75 }
    cur += ch; size += n
  }
  out.push(cur)
  return out.join('\r\n')
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const PARTSTAT: Record<InviteAnswer, string> = { accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED' }

/**
 * The iMIP REPLY to an invitation (RFC 6047): the same UID, times and SEQUENCE, the organizer, and only this
 * attendee with the answer. The invitation's own time zones go along, so its TZIDs still mean something.
 */
export function buildReply(text: string, me: Address, answer: InviteAnswer, now = new Date()): string {
  const cal = parseIcs(text)
  const ev = cal && mainEvent(cal)
  if (!cal || !ev) throw new Error('no-event')
  const keep = ['UID', 'RECURRENCE-ID', 'DTSTART', 'DTEND', 'DURATION', 'SEQUENCE', 'SUMMARY', 'LOCATION', 'ORGANIZER']
  const name = (me.name || '').replace(/"/g, '')
  const cn = name ? `;CN=${/[,;:]/.test(name) ? `"${name}"` : name}` : ''
  const lines = [
    'BEGIN:VCALENDAR', 'PRODID:-//THEMADLIONS//RoarMail//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:REPLY',
    ...cal.comps.filter((c) => c.name === 'VTIMEZONE').flatMap((c) => c.raw),
    'BEGIN:VEVENT',
    ...keep.flatMap((k) => ev.props.filter((p) => p.name === k).map((p) => p.raw)),
    `DTSTAMP:${stamp(now)}`,
    `ATTENDEE;PARTSTAT=${PARTSTAT[answer]}${cn}:mailto:${me.address}`,
    'END:VEVENT', 'END:VCALENDAR',
  ]
  return lines.map(fold).join('\r\n') + '\r\n'
}
