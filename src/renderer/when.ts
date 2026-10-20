// The ready-made times of the snooze and send-later pickers, like Airmail's: later today, this evening,
// tomorrow morning, the weekend, next week.
import { lang, t } from './i18n'

export interface Preset { key: string; label: string; at: number }

const at = (d: Date, h: number, m = 0) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x.getTime() }

export function presets(from = new Date()): Preset[] {
  const out: Preset[] = []
  const later = new Date(from.getTime() + 3 * 3600e3); later.setMinutes(0, 0, 0)
  if (later.getDate() === from.getDate() && later.getHours() < 21) out.push({ key: 'later', label: t.w_later, at: later.getTime() })
  if (from.getHours() < 17) out.push({ key: 'evening', label: t.w_evening, at: at(from, 18) })
  const tomorrow = new Date(from); tomorrow.setDate(from.getDate() + 1)
  out.push({ key: 'tomorrow', label: t.w_tomorrow, at: at(tomorrow, 8) })
  const day = from.getDay() // 0 Sunday
  if (day >= 1 && day <= 4) { const sat = new Date(from); sat.setDate(from.getDate() + (6 - day)); out.push({ key: 'weekend', label: t.w_weekend, at: at(sat, 9) }) }
  const mon = new Date(from); mon.setDate(from.getDate() + ((8 - day) % 7 || 7)); out.push({ key: 'nextweek', label: t.w_nextweek, at: at(mon, 8) })
  return out
}

export function short(ms: number): string {
  const d = new Date(ms), n = new Date()
  const loc = lang === 'el' ? 'el-GR' : undefined
  const time = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === n.toDateString()) return time
  const diff = (d.getTime() - n.getTime()) / 864e5
  if (diff < 6) return `${d.toLocaleDateString(loc, { weekday: 'short' })} ${time}`
  return `${d.toLocaleDateString(loc, { day: 'numeric', month: 'short' })} ${time}`
}

/** value for <input type="datetime-local"> */
export const localInput = (ms: number) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60e3); return d.toISOString().slice(0, 16) }
