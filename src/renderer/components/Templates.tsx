// Templates (quick replies, Oct 2026): Settings > Templates keeps them (like Signatures), the Templates button of
// the writing window's format bar drops one into the message with {name} {first} {project} {date} filled in.
import { useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import type { Template } from '../../shared/api'
import { lang, t } from '../i18n'
import { fillTemplate, recipientName, type TemplateValues } from '../templates'
import { Icon } from './Icon'

const api = window.roarmail
const PROJECT_KEY = 'roarmail.tplProject'

export function TemplatesPage() {
  const [list, setList] = useState<Template[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const load = () => api.templates().then((l) => { setList(l); setEditing((e) => e ?? l[0]?.id ?? null); return l })
  useEffect(() => { load() }, [])
  const current = list.find((x) => x.id === editing)
  return (
    <div className="stack">
      <div className="sig-layout">
        <div className="sig-list">
          {list.map((x) => <button key={x.id} className={`folder ${x.id === editing ? 'on' : ''}`} onClick={() => setEditing(x.id)}><span className="grow ellipsis">{x.name}</span></button>)}
          <button className="pill small" onClick={async () => { const n = await api.saveTemplate({ id: '', name: t.tp_new, subject: '', html: '' }); await load(); setEditing(n.id) }}>
            <Icon name="plus" size={13} /> {t.tp_new}
          </button>
        </div>
        {current
          ? <TemplateEditor key={current.id} tpl={current} reload={load} onDeleted={() => setEditing(null)} />
          : <div className="muted sig-empty">{t.tp_none}</div>}
      </div>
      <p className="muted small set-note">{t.tp_hint}</p>
    </div>
  )
}

function TemplateEditor({ tpl, reload, onDeleted }: { tpl: Template; reload: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(tpl.name)
  const [subject, setSubject] = useState(tpl.subject)
  const [saved, setSaved] = useState(false)
  const ed = useRef<HTMLDivElement>(null)
  useEffect(() => { if (ed.current) ed.current.innerHTML = DOMPurify.sanitize(tpl.html) }, [])
  const save = async () => {
    await api.saveTemplate({ id: tpl.id, name: name.trim() || t.tp_new, subject: subject.trim(), html: DOMPurify.sanitize(ed.current?.innerHTML || '') })
    reload(); setSaved(true); setTimeout(() => setSaved(false), 1500)
  }
  return (
    <div className="sig-edit">
      <label>{t.tp_name}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>{t.tp_subject}<input value={subject} placeholder="{project}" onChange={(e) => setSubject(e.target.value)} /></label>
      <div className="editor sig" ref={ed} contentEditable suppressContentEditableWarning />
      <div className="row end">
        <button className="pill small ghost danger" onClick={async () => { await api.deleteTemplate(tpl.id); onDeleted(); reload() }}>{t.delete}</button>
        <button className="pill small primary" onClick={save}>{saved ? t.saved : t.save}</button>
      </div>
    </div>
  )
}

/** what fills the placeholders now: the first person in To (or the one replied to), the project typed, today */
export function templateValues(to: string, fallbackName: string, project: string): TemplateValues {
  return {
    name: recipientName(to) || fallbackName,
    project,
    date: new Date().toLocaleDateString(lang === 'el' ? 'el-GR' : undefined, { day: 'numeric', month: 'long', year: 'numeric' }),
  }
}

/**
 * the format bar's Templates menu: the project for {project} (kept for next time), the templates, and
 * Save as Template… for what is written now
 */
export function TemplatesMenu({ onPick, onSave, onClose }: {
  onPick: (tpl: Template, project: string) => void; onSave: (name: string) => Promise<void>; onClose: () => void
}) {
  const [list, setList] = useState<Template[] | null>(null)
  const [project, setProject] = useState(() => { try { return localStorage.getItem(PROJECT_KEY) || '' } catch { return '' } })
  const [asking, setAsking] = useState<string | null>(null)
  useEffect(() => { api.templates().then(setList).catch(() => setList([])) }, [])
  const keep = (v: string) => { setProject(v); try { localStorage.setItem(PROJECT_KEY, v) } catch { /* this run only */ } }
  return (
    <div className="attach-menu tpl-menu" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <label className="tpl-project"><span className="muted small">{t.tp_project}</span>
        <input value={project} placeholder="{project}" onChange={(e) => keep(e.target.value)} /></label>
      {list?.map((x) => (
        <button key={x.id} onClick={() => onPick(x, project)}>
          <Icon name="template" size={16} /><span><b>{x.name}</b>{x.subject && <small>{x.subject}</small>}</span>
        </button>
      ))}
      {list && !list.length && <p className="muted small tpl-empty">{t.tp_manage}</p>}
      <hr />
      {asking == null
        ? <button onClick={() => setAsking('')}><Icon name="plus" size={16} /><span><b>{t.tp_save}</b><small>{t.tp_manage}</small></span></button>
        : (
          <form className="tpl-save" onSubmit={async (e) => { e.preventDefault(); if (asking.trim()) await onSave(asking.trim()) }}>
            <input autoFocus value={asking} placeholder={t.tp_name} onChange={(e) => setAsking(e.target.value)} />
            <button className="pill small primary" disabled={!asking.trim()}>{t.save}</button>
          </form>
        )}
    </div>
  )
}

/** a template's subject and body for this message (the body cleaned again, the values escaped into it) */
export function filled(tpl: Template, v: TemplateValues) {
  return { subject: fillTemplate(tpl.subject || '', v), html: fillTemplate(DOMPurify.sanitize(tpl.html), v, true) }
}
