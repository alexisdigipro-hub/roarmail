// Contacts (Alex, 29 Oct 2026): everyone you mail with, found as you type; their card fills itself from the
// signatures in their mail, and what you type on it stays. The list on the left, the card on the right.
import { useEffect, useRef, useState, type MouseEvent as RMouseEvent, type ReactNode } from 'react'
import type { Contact, ContactFull, ContactGroup, ContactPatch } from '../../shared/api'
import { t, when, type Key } from '../i18n'
import { useSenderIcons } from '../senders'
import { useLens } from '../look'
import { Icon } from './Icon'
import { initials, tint } from './Viewer'

const GROUPS: ContactGroup[] = ['vip', 'team', 'clients', 'crew', 'written', 'recent', 'blocked']
const TAGS = ['team', 'clients', 'crew']
const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)

export function Avatar({ email, name, pic, big }: { email: string; name: string; pic: string | null; big?: boolean }) {
  return <div className={`avatar ${pic ? 'pic' : ''} ${big ? 'big-av' : ''}`} style={{ background: pic ? '#fff' : tint(email) }}>{pic ? <img src={pic} alt="" /> : initials(name || email)}</div>
}

export function ContactsSheet({ start, pictures, onClose, onWrite, onAllMail }: {
  start?: string; pictures: boolean; onClose: () => void
  onWrite: (email: string) => void; onAllMail: (email: string) => void
}) {
  const [q, setQ] = useState('')
  const [group, setGroup] = useState<ContactGroup | ''>('')
  const [list, setList] = useState<Contact[] | null>(null)
  const [pick, setPick] = useState(start || '')
  const [note, setNote] = useState('')
  const seg = useLens<HTMLDivElement>(group.startsWith('@') ? 'company' : group || 'all')
  // the companies (Alex, 29 Oct: "everyone with the same @madlions.com, and others like it")
  const [domains, setDomains] = useState<{ domain: string; count: number }[]>([])
  useEffect(() => { window.roarmail.contactDomains().then(setDomains).catch(() => {}) }, [])
  const pic = useSenderIcons((list || []).slice(0, 120).map((c) => c.email), pictures)
  // a person's menu in the list (Alex, 29 Oct)
  const rowMenu = async (e: RMouseEvent, c: Contact) => {
    e.preventDefault()
    const tag = (g: string) => ({ id: `tag:${g}`, label: `${c.groups.includes(g) ? '✓ ' : ''}${t[`ct_g_${g}` as Key]}` })
    const id = await window.roarmail.popMenu([
      { id: 'write', label: t.ct_write },
      { id: 'all', label: t.ct_allMail },
      { id: 'copy', label: t.ad_copyAddress },
      null,
      { id: 'vip', label: c.vip ? `✓ VIP` : 'VIP' },
      tag('team'), tag('clients'), tag('crew'),
      null,
      { id: 'company', label: `${t.ct_everyoneAt} @${c.email.split('@')[1] || ''}` },
      { id: 'block', label: c.blocked ? t.unblockSender : t.blockSender },
    ])
    if (id === 'write') onWrite(c.email)
    else if (id === 'all') onAllMail(c.email)
    else if (id === 'copy') navigator.clipboard.writeText(c.email)
    else if (id === 'vip') { await window.roarmail.saveContact(c.email, { vip: !c.vip }); load() }
    else if (id?.startsWith('tag:')) { const g = id.slice(4); await window.roarmail.saveContact(c.email, { groups: c.groups.includes(g) ? c.groups.filter((x) => x !== g) : [...c.groups, g] }); load() }
    else if (id === 'company') setGroup(`@${c.email.split('@')[1]}`)
    else if (id === 'block') { await window.roarmail.blockSender(c.email, !c.blocked); load() }
  }
  const load = () => window.roarmail.contactList(q, group).then((l) => { setList(l); if (!pick && l[0]) setPick(l[0].email) })
  useEffect(() => { const h = setTimeout(load, q ? 160 : 0); return () => clearTimeout(h) }, [q, group])

  return (
    <div className="sheet-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div className="sheet contacts" tabIndex={-1}>
        <div className="ct-head">
          <h2>{t.ct_title}</h2>
          <label className="search ct-search"><Icon name="search" size={15} /><input id="ct-q" autoFocus value={q} placeholder={t.ct_search} onChange={(e) => setQ(e.target.value)} /></label>
          <button className="pill small" onClick={async () => { const n = await window.roarmail.importContacts().catch(() => null); if (n != null) { setNote(`${t.ct_imported} ${n}`); load() } }}>
            <Icon name="down" size={14} /> {t.ct_import}</button>
          <button className="tool" title={t.done} onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="seg lens ct-groups" ref={seg}>
          <button className={!group ? 'on' : ''} onClick={() => setGroup('')}>{t.ct_all}</button>
          {GROUPS.map((g) => <button key={g} className={group === g ? 'on' : ''} onClick={() => setGroup(g)}>{t[`ct_g_${g}` as Key]}</button>)}
        </div>
        {domains.length > 0 && (
          <div className="ct-domains" role="list" aria-label={t.ct_companies}>
            <span className="muted small ct-dlabel">{t.ct_companies}</span>
            {domains.map((d) => (
              <button key={d.domain} className={`chip-tag ${group === `@${d.domain}` ? 'on' : ''}`} onClick={() => setGroup(group === `@${d.domain}` ? '' : `@${d.domain}`)}>
                @{d.domain} <span className="muted">{d.count}</span></button>
            ))}
          </div>
        )}
        {note && <p className="small ok-text">{note}</p>}
        <div className="ct-body">
          <div className="ct-list">
            {list === null ? <div className="stats-wait"><div className="spinner" /></div>
              : !list.length ? <p className="muted small ct-empty">{q ? t.ct_none : t.ct_noneGroup}</p>
              : list.map((c) => (
                <button key={c.email} className={`ct-row ${pick === c.email ? 'on' : ''}`} onClick={() => setPick(c.email)} onContextMenu={(e) => rowMenu(e, c)}>
                  <Avatar email={c.email} name={c.name} pic={pic(c.email)} />
                  <span className="grow ct-who"><b className="ellipsis">{c.name || c.email}{c.vip && <Icon name="star" size={12} filled />}</b>
                    <small className="muted ellipsis">{[c.title, c.company].filter(Boolean).join(' · ') || c.email}</small></span>
                </button>
              ))}
          </div>
          {pick ? <ContactCard key={pick} email={pick} pictures={pictures} onWrite={onWrite} onAllMail={onAllMail} onChanged={load} onCompany={(d) => setGroup(`@${d}`)} />
            : <div className="ct-card empty muted">{t.ct_pick}</div>}
        </div>
      </div>
    </div>
  )
}

function ContactCard({ email, pictures, onWrite, onAllMail, onChanged, onCompany }: {
  email: string; pictures: boolean; onWrite: (e: string) => void; onAllMail: (e: string) => void; onChanged: () => void; onCompany: (domain: string) => void
}) {
  const domain = email.split('@')[1] || ''
  const [c, setC] = useState<ContactFull | null>(null)
  const pic = useSenderIcons([email], pictures)
  useEffect(() => { window.roarmail.contactCard(email).then(setC) }, [email])
  if (!c) return <div className="ct-card"><div className="stats-wait"><div className="spinner" /></div></div>
  const save = (p: ContactPatch) => { setC({ ...c, ...p }); window.roarmail.saveContact(email, p).then(onChanged) }
  const field = (k: 'name' | 'title' | 'company' | 'phone' | 'website', label: Key, ph?: string) => (
    <label className="ct-field"><span className="muted small">{t[label]}</span>
      <input id={`ct-${k}`} defaultValue={c[k]} placeholder={ph || '—'} onBlur={(e) => { if (e.target.value.trim() !== c[k]) save({ [k]: e.target.value.trim() }) }} /></label>
  )
  return (
    <div className="ct-card">
      <div className="ct-top">
        <Avatar email={email} name={c.name} pic={pic(email)} big />
        <div className="grow ct-id">
          <h3 className="ellipsis">{c.name || email}</h3>
          <span className="muted ellipsis">{[c.title, c.company].filter(Boolean).join(' · ')}</span>
          <span className="muted small ellipsis">{email} · <button type="button" className="link small" onClick={() => onCompany(domain)}>{t.ct_everyoneAt} @{domain}</button></span>
        </div>
      </div>
      <div className="row wrap ct-acts">
        <button className="pill small primary" onClick={() => onWrite(email)}><Icon name="compose" size={14} /> {t.ct_write}</button>
        <button className="pill small" onClick={() => onAllMail(email)}><Icon name="target" size={14} /> {t.ct_allMail}</button>
        {c.phone && <button className="pill small" title={t.ct_copyPhone} onClick={() => navigator.clipboard.writeText(c.phone)}><Icon name="phone" size={14} /> {c.phone}</button>}
        <button className={`pill small ${c.vip ? 'on-vip' : ''}`} onClick={() => save({ vip: !c.vip })}><Icon name="star" size={14} filled={c.vip} /> VIP</button>
        <button className="pill small danger-text" onClick={async () => { await window.roarmail.blockSender(email, !c.blocked); setC({ ...c, blocked: !c.blocked }); onChanged() }}>
          <Icon name="block" size={14} /> {c.blocked ? t.unblockSender : t.blockSender}</button>
      </div>
      <div className="ct-tags">
        {TAGS.map((g) => {
          const on = c.groups.includes(g)
          return <button key={g} className={`chip-tag ${on ? 'on' : ''}`} onClick={() => save({ groups: on ? c.groups.filter((x) => x !== g) : [...c.groups, g] })}>{t[`ct_g_${g}` as Key]}</button>
        })}
      </div>
      <div className="ct-fields">
        {field('name', 'name')}{field('title', 'ct_role')}{field('company', 'ct_company')}{field('phone', 'ct_phone')}{field('website', 'ct_site')}
      </div>
      <label className="ct-field"><span className="muted small">{t.ct_notes}</span>
        <textarea id="ct-notes" defaultValue={c.notes} rows={3} placeholder={t.ct_notesPh} onBlur={(e) => { if (e.target.value.trim() !== c.notes) save({ notes: e.target.value.trim() }) }} /></label>
      <p className="muted small">{t.ct_auto}</p>
      {c.recent.length > 0 && (
        <section className="ct-sec"><h4>{t.ct_recent} <span className="muted">{c.count}</span></h4>
          {c.recent.map((r) => (
            <button key={r.id} className="ct-mail" onClick={() => onAllMail(email)}>
              <span className="grow ellipsis"><b>{r.subject || t.noSubject}</b> <span className="muted">{r.snippet}</span></span>
              <span className="muted small">{when(r.date)}</span>
            </button>
          ))}
        </section>
      )}
      {c.files.length > 0 && (
        <section className="ct-sec"><h4>{t.ct_files} <span className="muted">{c.files.length}</span></h4>
          <div className="ct-files">
            {c.files.map((f) => (
              <button key={f.id} className="ct-file" title={f.filename} onClick={() => window.roarmail.openAttachment(f.id)}>
                <Icon name="clip" size={14} /><span className="ellipsis grow">{f.filename}</span><span className="muted small">{size(f.size)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** the little card over a sender's name in a message: who they are, at a glance */
export function SenderHover({ email, name, pictures, onOpen, onWrite, children }: {
  email: string; name: string; pictures: boolean; onOpen?: (e: string) => void; onWrite?: (e: string) => void; children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [c, setC] = useState<ContactFull | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pic = useSenderIcons(open ? [email] : [], pictures)
  const enter = () => { clearTimeout(timer.current); timer.current = setTimeout(() => { setOpen(true); window.roarmail.contactCard(email).then(setC).catch(() => {}) }, 450) }
  const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 250) }
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <span className="sender-hover" onMouseEnter={enter} onMouseLeave={leave}>
      {children}
      {open && (
        <span className="hover-card" onClick={(e) => e.stopPropagation()} onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={leave}>
          <span className="row"><Avatar email={email} name={c?.name || name} pic={pic(email)} />
            <span className="grow ct-who"><b className="ellipsis">{c?.name || name || email}</b>
              <small className="muted ellipsis">{c ? [c.title, c.company].filter(Boolean).join(' · ') || email : email}</small></span></span>
          {c?.phone && <span className="small">{c.phone}</span>}
          {c && <span className="muted small">{c.count} {t.ct_mails}{c.last ? ` · ${when(c.last)}` : ''}</span>}
          <span className="row">
            {onWrite && <button className="pill small" onClick={() => onWrite(email)}><Icon name="compose" size={13} /> {t.ct_write}</button>}
            {onOpen && <button className="pill small" onClick={() => { setOpen(false); onOpen(email) }}>{t.ct_card}</button>}
          </span>
        </span>
      )}
    </span>
  )
}
