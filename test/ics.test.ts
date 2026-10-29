// Calendar invitations: reading them and answering them (node --test test/)
import test from 'node:test'
import assert from 'node:assert/strict'
import { attendeeFor, buildReply, durationMs, fold, icsTime, parseIcs, parseLine, readInvite, unfold } from '../src/main/ics.ts'

const CRLF = (lines: string[]) => lines.join('\r\n') + '\r\n'

// as Google Calendar sends it: a folded description, a quoted CN with a comma, a TZID
const GOOGLE = CRLF([
  'BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:REQUEST',
  'BEGIN:VTIMEZONE', 'TZID:Europe/Athens', 'BEGIN:STANDARD', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0200', 'TZNAME:EET',
  'DTSTART:19701025T040000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0300', 'TZNAME:EEST', 'DTSTART:19700329T030000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'DTSTART;TZID=Europe/Athens:20261106T100000', 'DTEND;TZID=Europe/Athens:20261106T113000',
  'DTSTAMP:20261029T090000Z', 'ORGANIZER;CN=Μαρία Παπαδοπούλου:mailto:maria@studio-north.gr', 'UID:abc123@google.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="Konstantinidis, Alex";X-NUM-GUESTS=0:mailto:Alex@TheMadLions.com',
  'ATTENDEE;PARTSTAT=ACCEPTED;CN=maria@studio-north.gr:mailto:maria@studio-north.gr',
  'DESCRIPTION:Location scout for the Friday shoot\\, bring the second camera an',
  ' d the lights.\\nSee you there.', 'LOCATION:Studio North\\, Kerameikos\\, Athens', 'SEQUENCE:2', 'STATUS:CONFIRMED',
  'SUMMARY:Location scout', 'TRANSP:OPAQUE', 'END:VEVENT', 'END:VCALENDAR',
])

test('unfold joins folded lines; parseLine reads quoted parameters', () => {
  assert.deepEqual(unfold('A:1\r\n  2\r\n\tthree\r\nB:x\r\n'), ['A:1 2three', 'B:x'])
  const p = parseLine('ATTENDEE;CN="Doe, John: the 2nd";PARTSTAT=ACCEPTED:mailto:john@x.com')
  assert.equal(p.name, 'ATTENDEE')
  assert.equal(p.params.CN, 'Doe, John: the 2nd')
  assert.equal(p.params.PARTSTAT, 'ACCEPTED')
  assert.equal(p.value, 'mailto:john@x.com')
})

test('readInvite: title, place, organizer, TZID time, my answer', () => {
  const inv = readInvite(GOOGLE, ['alex@themadlions.com'])!
  assert.equal(inv.method, 'REQUEST')
  assert.equal(inv.uid, 'abc123@google.com')
  assert.equal(inv.title, 'Location scout')
  assert.equal(inv.location, 'Studio North, Kerameikos, Athens')
  assert.deepEqual(inv.organizer, { name: 'Μαρία Παπαδοπούλου', address: 'maria@studio-north.gr' })
  // 6 Nov 2026 is winter time in Athens (UTC+2): 10:00 there is 08:00 UTC
  assert.equal(new Date(inv.start).toISOString(), '2026-11-06T08:00:00.000Z')
  assert.equal(new Date(inv.end!).toISOString(), '2026-11-06T09:30:00.000Z')
  assert.equal(inv.allDay, false)
  assert.equal(inv.answer, null)
  assert.equal(readInvite(GOOGLE, ['maria@studio-north.gr'])!.answer, 'accepted')
})

test('TZID in summer time, UTC, floating and Windows zone names', () => {
  assert.equal(new Date(icsTime(parseLine('DTSTART;TZID=Europe/Athens:20260710T100000'))!.ms).toISOString(), '2026-07-10T07:00:00.000Z')
  assert.equal(new Date(icsTime(parseLine('DTSTART:20260710T100000Z'))!.ms).toISOString(), '2026-07-10T10:00:00.000Z')
  assert.equal(new Date(icsTime(parseLine('DTSTART;TZID=GTB Standard Time:20260710T100000'))!.ms).toISOString(), '2026-07-10T07:00:00.000Z')
  assert.equal(new Date(icsTime(parseLine('DTSTART;TZID="/mozilla.org/20050126_1/America/New_York":20260115T090000'))!.ms).toISOString(), '2026-01-15T14:00:00.000Z')
  const floating = icsTime(parseLine('DTSTART:20260710T100000'))!
  assert.equal(floating.ms, new Date(2026, 6, 10, 10, 0, 0).getTime())
})

test('a zone only the message describes (VTIMEZONE) still gives the right time', () => {
  const cal = parseIcs(GOOGLE.replace(/Europe\/Athens/g, 'Custom Athens'))!
  const zones = cal.comps.filter((c) => c.name === 'VTIMEZONE')
  assert.equal(new Date(icsTime(parseLine('DTSTART;TZID=Custom Athens:20261106T100000'), zones)!.ms).toISOString(), '2026-11-06T08:00:00.000Z')
  assert.equal(new Date(icsTime(parseLine('DTSTART;TZID=Custom Athens:20260710T100000'), zones)!.ms).toISOString(), '2026-07-10T07:00:00.000Z')
})

test('all-day events: VALUE=DATE, the end is the next day; DURATION', () => {
  const text = CRLF(['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:day1', 'SUMMARY:Shoot day', 'DTSTART;VALUE=DATE:20261113',
    'DTEND;VALUE=DATE:20261115', 'END:VEVENT', 'END:VCALENDAR'])
  const inv = readInvite(text)!
  assert.equal(inv.allDay, true)
  assert.equal(new Date(inv.start).toISOString(), '2026-11-13T00:00:00.000Z')
  assert.equal(new Date(inv.end!).toISOString(), '2026-11-15T00:00:00.000Z')
  const noEnd = readInvite(text.replace('DTEND;VALUE=DATE:20261115\r\n', ''))!
  assert.equal(noEnd.end! - noEnd.start, 864e5)
  const dur = readInvite(CRLF(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:d', 'DTSTART:20261113T090000Z', 'DURATION:PT1H30M', 'END:VEVENT', 'END:VCALENDAR']))!
  assert.equal(dur.end! - dur.start, 90 * 60e3)
  assert.equal(dur.method, 'PUBLISH')
  assert.equal(durationMs('P1W2DT3H'), (9 * 24 + 3) * 3600e3)
})

test('METHOD:CANCEL is read as a cancellation', () => {
  const inv = readInvite(GOOGLE.replace('METHOD:REQUEST', 'METHOD:CANCEL'))!
  assert.equal(inv.method, 'CANCEL')
  assert.equal(inv.title, 'Location scout')
})

test('no event, no invitation', () => {
  assert.equal(readInvite('BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n'), null)
  assert.equal(readInvite('not a calendar'), null)
})

test('attendeeFor keeps the address as the invitation wrote it', () => {
  assert.equal(attendeeFor(GOOGLE, ['alex@themadlions.com']), 'Alex@TheMadLions.com')
  assert.equal(attendeeFor(GOOGLE, ['other@x.com']), 'other@x.com')
})

test('buildReply: METHOD:REPLY, same UID / times / SEQUENCE / organizer, only me with my PARTSTAT', () => {
  const r = buildReply(GOOGLE, { name: 'Konstantinidis, Alex', address: 'Alex@TheMadLions.com' }, 'tentative', new Date('2026-10-29T10:00:00Z'))
  const lines = unfold(r)
  assert.ok(r.endsWith('\r\n'))
  assert.ok(lines.includes('METHOD:REPLY'))
  assert.ok(lines.includes('UID:abc123@google.com'))
  assert.ok(lines.includes('DTSTART;TZID=Europe/Athens:20261106T100000'))
  assert.ok(lines.includes('DTEND;TZID=Europe/Athens:20261106T113000'))
  assert.ok(lines.includes('SEQUENCE:2'))
  assert.ok(lines.includes('ORGANIZER;CN=Μαρία Παπαδοπούλου:mailto:maria@studio-north.gr'))
  assert.ok(lines.includes('DTSTAMP:20261029T100000Z'))
  assert.ok(lines.includes('ATTENDEE;PARTSTAT=TENTATIVE;CN="Konstantinidis, Alex":mailto:Alex@TheMadLions.com'))
  assert.equal(lines.filter((l) => l.startsWith('ATTENDEE')).length, 1)
  assert.ok(lines.includes('TZID:Europe/Athens'), 'the time zone goes along')
  assert.ok(!lines.some((l) => l.startsWith('DESCRIPTION')))
  // it reads back as the same event, answered
  const back = readInvite(r, ['alex@themadlions.com'])!
  assert.equal(back.method, 'REPLY')
  assert.equal(back.answer, 'tentative')
  assert.equal(new Date(back.start).toISOString(), '2026-11-06T08:00:00.000Z')
  assert.throws(() => buildReply('BEGIN:VCALENDAR\r\nEND:VCALENDAR', { address: 'a@b.c' }, 'accepted'))
})

test('fold: no line over 75 octets, Greek letters never cut, unfolds back', () => {
  const long = 'SUMMARY:' + 'Γύρισμα στο στούντιο '.repeat(8)
  const f = fold(long)
  for (const l of f.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75, l)
  assert.equal(unfold(f + '\r\n')[0], long)
  assert.equal(fold('SHORT:x'), 'SHORT:x')
})
