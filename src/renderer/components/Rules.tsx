// Settings > Rules (Oct 2026): sort new mail as it arrives. Each rule is a soft tile (switch, name, what it does,
// up / down, edit, delete); a rule opens into its editor: if all / any of these hold, then do these.
import { useEffect, useState } from 'react'
import type { Account, Folder, Rule, RuleAction, RuleCondition, RuleField } from '../../shared/api'
import { t, type Key } from '../i18n'
import { Icon } from './Icon'

const FIELDS: RuleField[] = ['from', 'to', 'subject', 'list', 'attachment']
const ACTIONS: RuleAction['kind'][] = ['move', 'read', 'flag', 'archive']
const api = window.roarmail

/** a new rule; from "Make a Rule from This Sender" it comes with the sender's address and a move to choose */
export const blankRule = (o: Partial<Rule> = {}): Rule => ({
  id: '', name: '', enabled: true, match: 'all', conditions: [{ field: 'from', value: '' }], actions: [{ kind: 'move', folderId: '' }], ...o,
})

const folderName = (f: Folder) => (f.role ? t[f.role as Key] || f.name : f.path)

export function RulesPage({ accounts, seed }: { accounts: Account[]; seed?: Rule | null }) {
  const [rules, setRules] = useState<Rule[]>([])
  const [editing, setEditing] = useState<Rule | null>(seed || null)
  const [folders, setFolders] = useState<Record<string, Folder[]>>({})
  const load = () => api.rules().then(setRules)
  useEffect(() => {
    load()
    Promise.all(accounts.map(async (a) => [a.id, await api.folders(a.id).catch(() => [])] as const))
      .then((list) => setFolders(Object.fromEntries(list)))
  }, [])

  const where = (id?: string) => {
    for (const a of accounts) {
      const f = (folders[a.id] || []).find((x) => x.id === id)
      if (f) return `${folderName(f)}${accounts.length > 1 ? ` (${a.description || a.email})` : ''}`
    }
    return '?'
  }
  const summary = (r: Rule) => {
    const ifs = r.conditions.map((c) => (c.field === 'attachment' ? t.ru_attachment : `${t[`ru_${c.field}` as Key]} "${c.value}"`)).join(r.match === 'any' ? ` ${t.ru_or} ` : ' · ')
    const thens = r.actions.map((a) => (a.kind === 'move' ? `${t.ru_move}: ${where(a.folderId)}` : t[`ru_${a.kind}` as Key])).join(' · ')
    return `${ifs} → ${thens}`
  }
  const move = async (i: number, d: number) => {
    const next = [...rules]
    const [r] = next.splice(i, 1)
    next.splice(i + d, 0, r)
    setRules(next)
    await api.orderRules(next.map((x) => x.id))
  }

  if (editing) {
    return <RuleEditor key={editing.id || 'new'} rule={editing} accounts={accounts} folders={folders}
      onDone={async (saved) => { if (saved) await api.saveRule(saved); setEditing(null); load() }} />
  }
  return (
    <div className="stack">
      {!rules.length && <p className="muted small set-note">{t.ru_none}</p>}
      <div className="rule-list">
        {rules.map((r, i) => (
          <div key={r.id} className={`rule-tile ${r.enabled ? '' : 'off'}`}>
            <span className="switch" title={r.enabled ? t.on : t.off}>
              <input type="checkbox" checked={r.enabled} onChange={async (e) => { await api.saveRule({ ...r, enabled: e.target.checked }); load() }} /><i />
            </span>
            <button className="rule-text" onClick={() => setEditing(r)}>
              <b className="ellipsis">{r.name}</b>
              <small className="muted">{summary(r)}</small>
            </button>
            <span className="rule-tools">
              <button className="tool small" title={t.ru_up} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" size={15} /></button>
              <button className="tool small" title={t.ru_down} disabled={i === rules.length - 1} onClick={() => move(i, 1)}><Icon name="down" size={15} /></button>
              <button className="tool small" title={t.edit} onClick={() => setEditing(r)}><Icon name="compose" size={15} /></button>
              <button className="tool small danger" title={t.delete} onClick={async () => { await api.deleteRule(r.id); load() }}><Icon name="trash" size={15} /></button>
            </span>
          </div>
        ))}
      </div>
      <button className="pill small" onClick={() => setEditing(blankRule())}><Icon name="plus" size={13} /> {t.ru_new}</button>
      <p className="muted small set-note">{t.ru_note}</p>
    </div>
  )
}

function RuleEditor({ rule, accounts, folders, onDone }: {
  rule: Rule; accounts: Account[]; folders: Record<string, Folder[]>; onDone: (r: Rule | null) => void
}) {
  const [r, setR] = useState<Rule>(rule)
  const [error, setError] = useState('')
  const cond = (i: number, c: Partial<RuleCondition>) => setR({ ...r, conditions: r.conditions.map((x, j) => (j === i ? { ...x, ...c } : x)) })
  const act = (i: number, a: Partial<RuleAction>) => setR({ ...r, actions: r.actions.map((x, j) => (j === i ? { ...x, ...a } : x)) })
  const save = () => {
    const conditions = r.conditions.filter((c) => c.field === 'attachment' || c.value.trim())
    if (!conditions.length || !r.actions.length) { setError(t.ru_needs); return }
    if (r.actions.some((a) => a.kind === 'move' && !a.folderId)) { setError(t.ru_pickFolder); return }
    const first = conditions[0]
    onDone({ ...r, conditions, name: r.name.trim() || (first.field === 'attachment' ? t.ru_attachment : first.value.trim()) })
  }
  return (
    <div className="panel rule-edit">
      <label>{t.name}<input autoFocus value={r.name} placeholder={t.ru_namePh} onChange={(e) => setR({ ...r, name: e.target.value })} /></label>
      <div className="row rule-head">
        <b>{t.ru_if}</b>
        <div className="seg">
          {(['all', 'any'] as const).map((m) => <button key={m} className={r.match === m ? 'on' : ''} onClick={() => setR({ ...r, match: m })}>{m === 'all' ? t.ru_all : t.ru_any}</button>)}
        </div>
      </div>
      {r.conditions.map((c, i) => (
        <div className="row rule-line" key={i}>
          <select value={c.field} onChange={(e) => cond(i, { field: e.target.value as RuleField })}>
            {FIELDS.map((f) => <option key={f} value={f}>{t[`ru_${f}` as Key]}</option>)}
          </select>
          {c.field !== 'attachment' && <input className="grow" value={c.value} placeholder={t.ru_value} onChange={(e) => cond(i, { value: e.target.value })} />}
          {c.field === 'attachment' && <span className="grow" />}
          <button className="tool small" title={t.ru_remove} disabled={r.conditions.length < 2} onClick={() => setR({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>
        </div>
      ))}
      <button className="link small" onClick={() => setR({ ...r, conditions: [...r.conditions, { field: 'subject', value: '' }] })}><Icon name="plus" size={12} /> {t.ru_addCond}</button>
      <div className="row rule-head"><b>{t.ru_then}</b></div>
      {r.actions.map((a, i) => (
        <div className="row rule-line" key={i}>
          <select value={a.kind} onChange={(e) => act(i, { kind: e.target.value as RuleAction['kind'] })}>
            {ACTIONS.map((k) => <option key={k} value={k}>{t[`ru_${k}` as Key]}</option>)}
          </select>
          {a.kind === 'move' ? (
            <select className="grow" value={a.folderId || ''} onChange={(e) => act(i, { folderId: e.target.value })}>
              <option value="" disabled>{t.ru_pickFolder}</option>
              {accounts.map((acc) => (
                <optgroup key={acc.id} label={acc.description || acc.email}>
                  {(folders[acc.id] || []).filter((f) => f.role !== 'snoozed').map((f) => <option key={f.id} value={f.id}>{folderName(f)}</option>)}
                </optgroup>
              ))}
            </select>
          ) : <span className="grow" />}
          <button className="tool small" title={t.ru_remove} disabled={r.actions.length < 2} onClick={() => setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>
        </div>
      ))}
      <button className="link small" onClick={() => setR({ ...r, actions: [...r.actions, { kind: 'read' }] })}><Icon name="plus" size={12} /> {t.ru_addAction}</button>
      {error && <p className="error small">{error}</p>}
      <div className="row end">
        <button className="pill small ghost" onClick={() => onDone(null)}>{t.cancel}</button>
        <button className="pill small primary" onClick={save}>{t.save}</button>
      </div>
    </div>
  )
}
