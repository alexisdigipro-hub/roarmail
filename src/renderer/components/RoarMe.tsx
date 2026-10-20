// RoarMe in RoarMail: the account (sign in, two-step code), "Send to RoarMe", "Make it a task", and the side panel
// with RoarMe's tasks, the calls in RoarMe chats and the THEMADLIONS hub's tasks and events.
import { useEffect, useMemo, useState } from 'react'
import type { MessageFull, RoarMeStatus, RoarPerson, RoarRoom, RoarTask, RoarWork } from '../../shared/api'
import { lang, t, type Key } from '../i18n'
import { Icon } from './Icon'
import { initials, tint } from './Viewer'

const api = () => window.roarmail
const clean = (e: any) => {
  const m = String(e?.message || e).replace(/^.*Error:\s*/, '')
  if (!m.startsWith('roarme-')) return m
  const k = m.slice(7).replace(/-/g, '_')
  return (t as Record<string, string>)[k === 'code' ? 'rm_badcode' : `rm_${k}`] || m
}

export function useRoarMe() {
  const [status, setStatus] = useState<RoarMeStatus | null>(null)
  useEffect(() => {
    const load = () => api().roarmeStatus().then(setStatus).catch(() => setStatus({ signedIn: false, needsMfa: false }))
    load()
    return api().on((e) => { if (e.type === 'roarme') load() })
  }, [])
  return [status, setStatus] as const
}

/** sign in with a RoarMe account (and its 6-digit code when it has two-step verification) */
export function RoarMeAccount({ compact }: { compact?: boolean }) {
  const [status, setStatus] = useRoarMe()
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (fn: () => Promise<RoarMeStatus>) => { setBusy(true); setError(''); try { setStatus(await fn()) } catch (e) { setError(clean(e)) } finally { setBusy(false) } }

  if (!status) return <div className="spinner" />
  if (status.signedIn && !status.needsMfa && status.me) {
    return (
      <div className={`roarme-card ${compact ? 'compact' : ''}`}>
        <div className="row">
          <div className="avatar" style={{ width: 44, height: 44, background: tint(status.me.username || status.me.name) }}>{initials(status.me.name)}</div>
          <div className="grow"><b>{status.me.name}</b><div className="muted small">@{status.me.username} · {status.email}</div></div>
          {!compact && <button className="pill small ghost" onClick={() => api().roarmeSignOut()}>{t.rm_signout}</button>}
        </div>
        {!compact && <p className="muted small">{t.rm_connectedHint}</p>}
      </div>
    )
  }
  return (
    <form className="roarme-card" onSubmit={(e) => { e.preventDefault(); status.needsMfa ? run(() => api().roarmeVerify(code)) : run(() => api().roarmeSignIn(email, pass)) }}>
      <div className="row roarme-head"><b className="roar-wm"><span>ROAR</span>ME</b><span className="muted small grow">{t.rm_why}</span></div>
      {status.needsMfa ? (
        <label>{t.rm_code}<input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" /></label>
      ) : (
        <>
          <label>{t.email}<input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>{t.password}<input type="password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="row end">
        {status.needsMfa && <button type="button" className="pill small ghost" onClick={() => api().roarmeSignOut()}>{t.cancel}</button>}
        <button className="pill primary" disabled={busy || (status.needsMfa ? code.replace(/\D/g, '').length < 6 : !email || !pass)}>{status.needsMfa ? t.rm_verify : t.rm_signin}</button>
      </div>
      <p className="muted small">{t.rm_privacy}</p>
    </form>
  )
}

/** Send to RoarMe: pick a chat, add a word, with or without the attachments */
export function ShareSheet({ message, onClose, onDone }: { message: MessageFull; onClose: () => void; onDone: (text: string) => void }) {
  const [status] = useRoarMe()
  const [rooms, setRooms] = useState<RoarRoom[] | null>(null)
  const [q, setQ] = useState('')
  const [pick, setPick] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [withFiles, setWithFiles] = useState(message.attachments.length > 0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ready = status?.signedIn && !status.needsMfa
  useEffect(() => { if (ready) api().roarmeRooms().then(setRooms).catch((e) => setError(clean(e))) }, [ready])
  const list = useMemo(() => (rooms || []).filter((r) => !q || r.title.toLowerCase().includes(q.toLowerCase())), [rooms, q])

  const send = async () => {
    if (!pick) return
    setBusy(true); setError('')
    try {
      const r = await api().roarmeShare(pick, message.id, note, withFiles)
      onDone(r.skipped ? `${t.rm_sent} · ${r.skipped} ${t.rm_skipped}` : t.rm_sent)
    } catch (e) { setError(clean(e)); setBusy(false) }
  }

  return (
    <div className="sheet-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div className="sheet roarme-sheet">
        <div className="row"><Icon name="roar" size={20} /><h3 className="grow">{t.rm_share}</h3><button className="tool" onClick={onClose}><Icon name="close" /></button></div>
        <div className="mail-chip"><b>{message.subject || t.noSubject}</b><span className="muted small">{message.fromName || message.fromEmail}</span></div>
        {!ready ? <RoarMeAccount compact /> : (
          <>
            <label className="search big"><Icon name="search" size={15} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.rm_findChat} /></label>
            <div className="room-list">
              {!rooms && <div className="spinner" />}
              {list.map((r) => (
                <button key={r.id} className={`room ${pick === r.id ? 'on' : ''}`} onClick={() => setPick(r.id)} onDoubleClick={() => { setPick(r.id); setTimeout(send, 0) }}>
                  <div className="avatar" style={{ background: tint(r.title) }}>{r.avatar ? <img src={r.avatar} alt="" /> : initials(r.title)}</div>
                  <span className="grow ellipsis"><b>{r.title}</b>{r.kind !== 'direct' && <small className="muted"> · {r.members.length}</small>}</span>
                  {r.unread > 0 && <span className="count">{r.unread}</span>}
                </button>
              ))}
            </div>
            <textarea className="note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t.rm_note} />
            {message.attachments.length > 0 && (
              <label className="check"><input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} />{t.rm_withFiles} ({message.attachments.length})</label>
            )}
            {error && <p className="error">{error}</p>}
            <div className="row end"><button className="pill primary" disabled={!pick || busy} onClick={send}>{busy ? t.sending : t.send}</button></div>
          </>
        )}
      </div>
    </div>
  )
}

/** Make it a task: for oneself or someone one shares a chat with, with a due day and priority */
export function TaskSheet({ message, onClose, onDone }: { message: MessageFull; onClose: () => void; onDone: (text: string) => void }) {
  const [status] = useRoarMe()
  const [people, setPeople] = useState<RoarPerson[]>([])
  const [title, setTitle] = useState(message.subject || '')
  const [assignee, setAssignee] = useState('')
  const [due, setDue] = useState('')
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal')
  const [notes, setNotes] = useState(() => [
    `${t.from}: ${message.fromName ? `${message.fromName} <${message.fromEmail}>` : message.fromEmail}`,
    new Date(message.date).toLocaleString(lang === 'el' ? 'el-GR' : undefined),
    '', (message.snippet || '').slice(0, 600), '', message.messageId ? `RoarMail · ${message.messageId}` : '',
  ].join('\n').trim())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ready = status?.signedIn && !status.needsMfa
  useEffect(() => { if (ready) api().roarmeContacts().then(setPeople).catch(() => {}) }, [ready])

  const save = async () => {
    setBusy(true); setError('')
    try { await api().roarmeTask({ title, notes, due: due || undefined, priority, assignee: assignee || undefined }); onDone(assignee ? t.rm_taskSent : t.rm_taskMade) }
    catch (e) { setError(clean(e)); setBusy(false) }
  }

  return (
    <div className="sheet-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div className="sheet roarme-sheet">
        <div className="row"><Icon name="tasks" size={20} /><h3 className="grow">{t.rm_task}</h3><button className="tool" onClick={onClose}><Icon name="close" /></button></div>
        {!ready ? <RoarMeAccount compact /> : (
          <>
            <label>{t.rm_taskTitle}<input autoFocus value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} /></label>
            <div className="row two">
              <label className="grow">{t.rm_for}
                <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                  <option value="">{t.rm_me}</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.username ? ` · @${p.username}` : ''}</option>)}
                </select>
              </label>
              <label>{t.rm_due}<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
            </div>
            <div className="row"><span className="muted small">{t.rm_priority}</span>
              <div className="seg">{(['low', 'normal', 'high'] as const).map((p) => <button key={p} className={priority === p ? 'on' : ''} onClick={() => setPriority(p)}>{t[`pr_${p}` as Key]}</button>)}</div>
            </div>
            <label>{t.rm_notes}<textarea rows={6} value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} /></label>
            {assignee && <p className="muted small">{t.rm_askHint}</p>}
            {error && <p className="error">{error}</p>}
            <div className="row end"><button className="pill primary" disabled={busy || !title.trim()} onClick={save}>{t.rm_makeTask}</button></div>
          </>
        )}
      </div>
    </div>
  )
}

/** the side panel: RoarMe tasks (tick to finish), calls in RoarMe chats, the hub's tasks and events */
export function WorkPanel({ onClose }: { onClose: () => void }) {
  const [status] = useRoarMe()
  const [work, setWork] = useState<RoarWork | null>(null)
  const [error, setError] = useState('')
  const ready = status?.signedIn && !status.needsMfa
  const load = () => api().roarmeWork().then(setWork).catch((e) => setError(clean(e)))
  useEffect(() => { if (ready) { load(); const h = setInterval(load, 3 * 60e3); return () => clearInterval(h) } }, [ready])

  const fmtDay = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString(lang === 'el' ? 'el-GR' : undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const fmtWhen = (iso: string) => new Date(iso).toLocaleString(lang === 'el' ? 'el-GR' : undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const setStatus = async (task: RoarTask, s: RoarTask['status']) => {
    setWork((w) => w && { ...w, tasks: w.tasks.filter((x) => x.id !== task.id || s !== 'done').map((x) => (x.id === task.id ? { ...x, status: s } : x)) })
    try { await api().roarmeTaskStatus(task.id, s) } catch (e) { setError(clean(e)); load() }
  }

  return (
    <aside className="work-panel">
      <div className="row work-head"><b className="roar-wm small"><span>ROAR</span>ME</b><span className="grow">{t.rm_work}</span>
        <button className="tool small" title={t.refresh} onClick={load}><Icon name="refresh" size={15} /></button>
        <button className="tool small" onClick={onClose}><Icon name="close" size={15} /></button></div>
      {!status ? <div className="spinner" /> : !ready ? <RoarMeAccount compact /> : !work ? (error ? <p className="error">{error}</p> : <div className="spinner" />) : (
        <div className="work-body">
          <h4>{t.rm_tasks} <span className="muted">{work.tasks.length}</span></h4>
          {!work.tasks.length && <p className="muted small">{t.rm_noTasks}</p>}
          {work.tasks.map((x) => (
            <div key={x.id} className={`task ${x.priority} ${x.status}`}>
              {x.mine && x.status !== 'pending'
                ? <button className="tick" title={t.rm_done} onClick={() => setStatus(x, 'done')}><Icon name="dot" size={12} /></button>
                : <span className="tick ghost"><Icon name="tasks" size={12} /></span>}
              <div className="grow">
                <div className="ellipsis"><b>{x.title}</b></div>
                <div className="muted small">{[x.due && fmtDay(x.due), x.from && `${t.rm_from} ${x.from}`, x.to && `${t.rm_to} ${x.to}`, x.status === 'pending' && (x.mine ? t.rm_asked : t.rm_waiting)].filter(Boolean).join(' · ')}</div>
                {x.mine && x.status === 'pending' && (
                  <div className="row"><button className="pill small primary" onClick={() => setStatus(x, 'open')}>{t.rm_accept}</button><button className="pill small ghost" onClick={() => setStatus(x, 'declined')}>{t.rm_decline}</button></div>
                )}
              </div>
            </div>
          ))}

          {work.events.length > 0 && <h4>{t.rm_calls}</h4>}
          {work.events.map((e) => (
            <button key={e.id} className="ev" onClick={() => api().roarmeOpen({ roomId: e.roomId })}>
              <Icon name="clock" size={14} /><span className="grow ellipsis">{e.title}</span><span className="muted small">{fmtWhen(e.start)}</span>
            </button>
          ))}

          {work.hub.linked && (
            <>
              <h4>THEMADLIONS <span className="muted">Hub</span></h4>
              {work.hub.events.slice(0, 20).map((e) => (
                <button key={`he-${e.id}`} className="ev" onClick={() => api().roarmeOpen({ hub: 'calendar' })}>
                  <i className="ev-dot" style={{ background: e.color || '#ff9f0a' }} /><span className="grow ellipsis">{e.title || e.typeLabel}</span>
                  <span className="muted small">{fmtDay(e.date)}{e.start ? ` ${e.start.slice(0, 5)}` : ''}</span>
                </button>
              ))}
              {work.hub.tasks.filter((x) => x.status !== 'done').slice(0, 30).map((x) => (
                <button key={`ht-${x.projectId || ''}-${x.id}`} className="ev" onClick={() => api().roarmeOpen({ hub: 'tasks' })}>
                  <i className="ev-dot" style={{ background: '#bf5af2' }} /><span className="grow ellipsis">{x.title}</span>
                  <span className="muted small">{[x.project, x.due && fmtDay(x.due)].filter(Boolean).join(' · ')}</span>
                </button>
              ))}
            </>
          )}
          <button className="pill small ghost open-roarme" onClick={() => api().roarmeOpen({})}>{t.rm_openRoarMe}</button>
        </div>
      )}
    </aside>
  )
}
