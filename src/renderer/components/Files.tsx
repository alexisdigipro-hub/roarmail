// Files (Alex, 29 Oct 2026): every attachment of every account in one place, by kind (PDF, pictures, video, scripts…),
// found by its name, its sender or the subject it came with; open, save, or go to the person.
import { useEffect, useState, type MouseEvent as RMouseEvent } from 'react'
import type { Account, FileKind, MailFile } from '../../shared/api'
import { t, when, type Key } from '../i18n'
import { useLens } from '../look'
import { Icon } from './Icon'

const KINDS: FileKind[] = ['pdf', 'image', 'video', 'audio', 'script', 'doc', 'sheet', 'slides', 'archive', 'other']
const size = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)
const ICON: Record<FileKind, string> = { pdf: 'template', image: 'image', video: 'target', audio: 'bell', script: 'compose', doc: 'template', sheet: 'chart', slides: 'chart', archive: 'archive', other: 'clip' }

export function FilesSheet({ accounts, onClose, onPerson, onCard }: {
  accounts: Account[]; onClose: () => void; onPerson: (email: string) => void; onCard: (email: string) => void
}) {
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<FileKind | ''>('')
  const [sort, setSort] = useState<'date' | 'size'>('date')
  const [acc, setAcc] = useState('all')
  const [res, setRes] = useState<{ files: MailFile[]; counts: Record<string, number> } | null>(null)
  const seg = useLens<HTMLDivElement>(kind || 'all')
  useEffect(() => {
    let live = true
    const h = setTimeout(() => window.roarmail.files(q, kind, sort, acc).then((r) => { if (live) setRes(r) }).catch(() => { if (live) setRes({ files: [], counts: {} }) }), q ? 160 : 0)
    return () => { live = false; clearTimeout(h) }
  }, [q, kind, sort, acc])
  const total = res ? Object.values(res.counts).reduce((a, b) => a + b, 0) : 0
  const accOf = (id: string) => accounts.find((a) => a.id === id)

  const menu = async (e: RMouseEvent, f: MailFile) => {
    e.preventDefault()
    const id = await window.roarmail.popMenu([
      { id: 'open', label: window.roarmail.platform === 'darwin' ? t.preview : t.open },
      { id: 'save', label: t.fl_saveAs },
      { id: 'name', label: t.fl_copyName },
      null,
      { id: 'mail', label: t.fi_mailWith },
      { id: 'card', label: t.ct_card },
    ])
    if (id === 'open') window.roarmail.openAttachment(f.id)
    else if (id === 'save') window.roarmail.saveAttachment(f.id)
    else if (id === 'name') navigator.clipboard.writeText(f.filename)
    else if (id === 'mail') onPerson(f.fromEmail)
    else if (id === 'card') onCard(f.fromEmail)
  }

  return (
    <div className="sheet-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div className="sheet contacts files" tabIndex={-1}>
        <div className="ct-head">
          <h2>{t.fi_title}</h2>
          <label className="search ct-search"><Icon name="search" size={15} /><input id="fi-q" autoFocus value={q} placeholder={t.fi_search} onChange={(e) => setQ(e.target.value)} /></label>
          <select id="fi-acc" value={acc} onChange={(e) => setAcc(e.target.value)} title={t.accounts}>
            <option value="all">{t.allAccounts}</option>
            {accounts.filter((a) => a.enabled).map((a) => <option key={a.id} value={a.id}>{a.description || a.email}</option>)}
          </select>
          <select id="fi-sort" value={sort} onChange={(e) => setSort(e.target.value as 'date' | 'size')} title={t.fl_sort}>
            <option value="date">{t.fi_newest}</option><option value="size">{t.fi_biggest}</option>
          </select>
          <button className="tool" title={t.done} onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="seg lens ct-groups" ref={seg}>
          <button className={!kind ? 'on' : ''} onClick={() => setKind('')}>{t.ct_all} <span className="muted">{total || ''}</span></button>
          {KINDS.filter((k) => res?.counts[k]).map((k) => (
            <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{t[`fk_${k}` as Key]} <span className="muted">{res!.counts[k]}</span></button>
          ))}
        </div>
        <div className="fi-list">
          {!res ? <div className="stats-wait"><div className="spinner" /></div>
            : !res.files.length ? <p className="muted ct-empty">{q || kind ? t.fi_none : t.fi_empty}</p>
            : res.files.map((f) => (
              <div key={f.id} className="fi-row" onContextMenu={(e) => menu(e, f)} onDoubleClick={() => window.roarmail.openAttachment(f.id)}>
                <span className={`fi-ico k-${f.kind}`}><Icon name={ICON[f.kind]} size={16} /></span>
                <button type="button" className="fi-main" title={f.filename} onClick={() => window.roarmail.openAttachment(f.id)}>
                  <b className="ellipsis">{f.filename}</b>
                  <small className="muted ellipsis">{f.fromName || f.fromEmail} · {f.subject || t.noSubject}</small>
                </button>
                <span className="muted small fi-meta">{size(f.size)}</span>
                <span className="muted small fi-meta">{when(f.date)}</span>
                {acc === 'all' && accOf(f.accountId) && <i className="acc-dot" style={{ background: accOf(f.accountId)!.color }} title={accOf(f.accountId)!.email} />}
                <button className="tool small" title={t.save} onClick={() => window.roarmail.saveAttachment(f.id)}><Icon name="download" size={15} /></button>
                <button className="tool small" title={t.mm_more} onClick={(e) => menu(e, f)}><Icon name="more" size={15} /></button>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
