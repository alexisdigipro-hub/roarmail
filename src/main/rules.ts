// Settings > Rules: does a message meet a rule, and a rule as the window sent it made safe to keep. Plain
// functions (no database, no Electron), so test/rules.test.ts checks them; mail.ts runs them on new mail.
import type { Rule, RuleAction, RuleCondition, RuleField } from '../shared/api'

/** what a rule looks at in a message (from the local database: headers only, no body needed) */
export interface RuleMessage {
  fromName: string; fromEmail: string
  /** every To and Cc address and name, as one text */
  to: string
  subject: string
  hasAttachments: boolean
  /** the List-Id header, '' when the message is not from a list */
  listId: string
}

const FIELDS: RuleField[] = ['from', 'to', 'subject', 'attachment', 'list']
const ACTIONS: RuleAction['kind'][] = ['move', 'read', 'flag', 'archive']

/** compared without case and accents (Greek tonos too), as search does */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ς/g, 'σ')

function holds(c: RuleCondition, m: RuleMessage): boolean {
  if (c.field === 'attachment') return m.hasAttachments
  const want = fold(c.value.trim())
  if (!want) return false
  const have = c.field === 'from' ? `${m.fromName} <${m.fromEmail}>` : c.field === 'to' ? m.to : c.field === 'subject' ? m.subject : m.listId
  return fold(have || '').includes(want)
}

/** a switched-off rule, or one without conditions, never matches (so an empty rule cannot sweep the inbox) */
export function ruleMatches(rule: Rule, m: RuleMessage): boolean {
  if (!rule.enabled || !rule.conditions.length) return false
  return rule.match === 'any' ? rule.conditions.some((c) => holds(c, m)) : rule.conditions.every((c) => holds(c, m))
}

/** a rule from the window, cleaned: known fields and actions only, short texts, a move only with its folder */
export function cleanRule(x: any): Rule {
  const conditions: RuleCondition[] = (Array.isArray(x?.conditions) ? x.conditions : [])
    .filter((c: any) => FIELDS.includes(c?.field))
    .map((c: any) => ({ field: c.field, value: c.field === 'attachment' ? '' : String(c.value ?? '').slice(0, 200) }))
    .filter((c: RuleCondition) => c.field === 'attachment' || c.value.trim())
    .slice(0, 20)
  const actions: RuleAction[] = (Array.isArray(x?.actions) ? x.actions : [])
    .filter((a: any) => ACTIONS.includes(a?.kind) && (a.kind !== 'move' || (typeof a.folderId === 'string' && a.folderId)))
    .map((a: any) => (a.kind === 'move' ? { kind: 'move', folderId: String(a.folderId) } : { kind: a.kind }))
    .slice(0, 10)
  return {
    id: typeof x?.id === 'string' ? x.id : '',
    name: String(x?.name ?? '').trim().slice(0, 80),
    enabled: x?.enabled !== false,
    match: x?.match === 'any' ? 'any' : 'all',
    conditions, actions,
  }
}

/**
 * what the rules do to one message: every matching rule's mark read and star; the first matching rule that
 * moves or archives decides where it goes (later ones cannot move it again)
 */
export function plan(rules: Rule[], m: RuleMessage): { read: boolean; flag: boolean; archive: boolean; moveTo: string | null } {
  const out = { read: false, flag: false, archive: false, moveTo: null as string | null }
  let placed = false
  for (const r of rules) {
    if (!ruleMatches(r, m)) continue
    for (const a of r.actions) {
      if (a.kind === 'read') out.read = true
      else if (a.kind === 'flag') out.flag = true
      else if (!placed && a.kind === 'archive') { out.archive = true; placed = true }
      else if (!placed && a.kind === 'move' && a.folderId) { out.moveTo = a.folderId; placed = true }
    }
  }
  return out
}
