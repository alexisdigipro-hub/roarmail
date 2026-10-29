// Settings > Rules: matching and cleaning (node --test test/)
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanRule, plan, ruleMatches, type RuleMessage } from '../src/main/rules.ts'

const msg = (o: Partial<RuleMessage> = {}): RuleMessage => ({
  fromName: 'Μαρία Παπαδοπούλου', fromEmail: 'maria@studio-north.gr', to: 'Alex <alex@themadlions.com>, nikos@studio-north.gr',
  subject: 'Γύρισμα Παρασκευής', hasAttachments: false, listId: '', ...o,
})
const rule = (o: any) => cleanRule({ id: 'r', name: 'r', enabled: true, match: 'all', conditions: [], actions: [{ kind: 'read' }], ...o })

test('from matches the name or the address, without case or accents', () => {
  assert.ok(ruleMatches(rule({ conditions: [{ field: 'from', value: 'STUDIO-NORTH' }] }), msg()))
  assert.ok(ruleMatches(rule({ conditions: [{ field: 'from', value: 'μαρια' }] }), msg()))
  assert.ok(!ruleMatches(rule({ conditions: [{ field: 'from', value: 'nikos' }] }), msg()))
})

test('to looks at To and Cc, subject at the subject (Greek tonos ignored)', () => {
  assert.ok(ruleMatches(rule({ conditions: [{ field: 'to', value: 'nikos@' }] }), msg()))
  assert.ok(ruleMatches(rule({ conditions: [{ field: 'subject', value: 'γυρισμα' }] }), msg()))
})

test('attachment and list (List-Id)', () => {
  assert.ok(!ruleMatches(rule({ conditions: [{ field: 'attachment', value: '' }] }), msg()))
  assert.ok(ruleMatches(rule({ conditions: [{ field: 'attachment', value: 'ignored' }] }), msg({ hasAttachments: true })))
  assert.ok(ruleMatches(rule({ conditions: [{ field: 'list', value: 'news.filmgear' }] }), msg({ listId: 'Film Gear <news.filmgear-weekly.com>' })))
  assert.ok(!ruleMatches(rule({ conditions: [{ field: 'list', value: 'news' }] }), msg()))
})

test('all and any', () => {
  const conditions = [{ field: 'from', value: 'maria' }, { field: 'subject', value: 'invoice' }]
  assert.ok(!ruleMatches(rule({ match: 'all', conditions }), msg()))
  assert.ok(ruleMatches(rule({ match: 'any', conditions }), msg()))
})

test('a switched-off rule or one without conditions never matches', () => {
  assert.ok(!ruleMatches(rule({ enabled: false, conditions: [{ field: 'from', value: 'maria' }] }), msg()))
  assert.ok(!ruleMatches(rule({ conditions: [] }), msg()))
  assert.ok(!ruleMatches(rule({ conditions: [{ field: 'from', value: '   ' }] }), msg()))
})

test('cleanRule keeps only known fields and actions, and a move only with its folder', () => {
  const r = cleanRule({ name: '  News  ', match: 'weird', conditions: [{ field: 'body', value: 'x' }, { field: 'subject', value: 'a' }],
    actions: [{ kind: 'delete' }, { kind: 'move' }, { kind: 'move', folderId: 'f1' }, { kind: 'flag', folderId: 'x' }] })
  assert.equal(r.name, 'News')
  assert.equal(r.match, 'all')
  assert.equal(r.enabled, true)
  assert.deepEqual(r.conditions, [{ field: 'subject', value: 'a' }])
  assert.deepEqual(r.actions, [{ kind: 'move', folderId: 'f1' }, { kind: 'flag' }])
})

test('plan: marks from every rule, the first move or archive wins', () => {
  const rules = [
    rule({ conditions: [{ field: 'from', value: 'maria' }], actions: [{ kind: 'move', folderId: 'projects' }] }),
    rule({ conditions: [{ field: 'subject', value: 'γύρισμα' }], actions: [{ kind: 'archive' }, { kind: 'flag' }] }),
    rule({ conditions: [{ field: 'to', value: 'alex' }], actions: [{ kind: 'read' }] }),
  ]
  assert.deepEqual(plan(rules, msg()), { read: true, flag: true, archive: false, moveTo: 'projects' })
  assert.deepEqual(plan(rules, msg({ fromName: 'X', fromEmail: 'x@y.z' })), { read: true, flag: true, archive: true, moveTo: null })
  assert.deepEqual(plan(rules, msg({ fromName: 'X', fromEmail: 'x@y.z', subject: 'hi', to: 'z@z.z' })), { read: false, flag: false, archive: false, moveTo: null })
})
