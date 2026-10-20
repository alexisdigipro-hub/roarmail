// Settings, laid out like RoarMe's: a list of pages on the left (icons, current values, a chevron, the lens
// sliding to the open one), the page on the right with a big title. Appearance carries RoarMe's look settings.
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import DOMPurify from 'dompurify'
import type { Account, LockState, NewMailSound, Settings, Signature, SwipeAction, Tls } from '../../shared/api'
import { t, type Key } from '../i18n'
import { ACCENTS, FONTS, TEXT_SIZES, applyLook, fontStack, revealFrom, useLens } from '../look'
import { NEW_MAIL_SOUNDS, playNewMail } from '../sounds'
import { Icon } from './Icon'
import { RoarMeAccount } from './RoarMe'

const COLORS = ['#d40000', '#ff8a00', '#2f9bff', '#33c27f', '#b04cff', '#ff4fa3', '#00b8b0', '#c9a227']
type Page = 'general' | 'accounts' | 'roarme' | 'appearance' | 'fonts' | 'signatures' | 'privacy' | 'keys'
const PAGES: [Page, string][] = [
  ['general', 'gear'], ['accounts', 'inbox'], ['roarme', 'roar'], ['appearance', 'palette'], ['fonts', 'type'], ['signatures', 'compose'], ['privacy', 'shield'], ['keys', 'keyboard'],
]

export function SettingsSheet({ accounts, onAddAccount, onClose, onLook }: {
  accounts: Account[]; onAddAccount: () => void; onClose: () => void; onLook: (s: Settings) => void
}) {
  const [page, setPage] = useState<Page>('general')
  const [sigs, setSigs] = useState<Signature[]>([])
  const [prefs, setPrefs] = useState<Settings | null>(null)
  const nav = useLens<HTMLDivElement>(page)
  const loadSigs = () => window.roarmail.signatures().then(setSigs)
  useEffect(() => { loadSigs(); window.roarmail.settings().then(setPrefs) }, [])

  const value = (p: Page) => {
    if (!prefs) return ''
    if (p === 'accounts') return String(accounts.length)
    if (p === 'appearance') return prefs.theme === 'pumba' ? 'Pumba' : 'Simba'
    if (p === 'signatures') return sigs.length ? String(sigs.length) : ''
    if (p === 'privacy') return prefs.lock ? t.appLockShort : ''
    return ''
  }

  return (
    <div className="sheet-wrap" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet settings">
        <nav className="set-side">
          <div className="set-brand"><b>ROAR</b><i>MAIL</i></div>
          <div className="set-list list-lens lens" ref={nav}>
            {PAGES.map(([k, icon]) => (
              <button key={k} className={`set-nav ${page === k ? 'on' : ''}`} onClick={() => setPage(k)}>
                <Icon name={icon} size={17} />
                <span className="grow">{t[k as Key]}</span>
                <span className="set-val">{value(k)}</span>
                <Icon name="chevron" size={13} />
              </button>
            ))}
          </div>
        </nav>
        <section className="set-page" key={page}>
          <div className="set-head">
            <h2>{t[page as Key]}</h2>
            <button className="tool" onClick={onClose} title={t.done}><Icon name="close" /></button>
          </div>
          <div className="settings-body">
            {page === 'accounts' && <Accounts accounts={accounts} sigs={sigs} onAdd={onAddAccount} />}
            {page === 'roarme' && <RoarMeAccount />}
            {page === 'appearance' && prefs && <Appearance s={prefs} onChange={(n) => { setPrefs(n); applyLook(n); onLook(n) }} />}
            {page === 'signatures' && <Signatures sigs={sigs} reload={loadSigs} />}
            {page === 'privacy' && <Privacy />}
            {page === 'general' && <General />}
            {page === 'fonts' && prefs && <Fonts s={prefs} onChange={(n) => { setPrefs(n); applyLook(n); onLook(n) }} />}
            {page === 'keys' && <Shortcuts />}
          </div>
        </section>
      </div>
    </div>
  )
}

/** RoarMe's Appearance page: theme, day and night, accent, font, spacing, corners, text size, motion and the rest */
function Appearance({ s, onChange }: { s: Settings; onChange: (s: Settings) => void }) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K], e?: MouseEvent) => {
    const next = { ...s, [k]: v }
    window.roarmail.setSetting(k, v)
    if (e && (k === 'appearance' || k === 'theme')) revealFrom(e, () => onChange(next)); else onChange(next)
  }
  const modes: [Settings['appearance'], string][] = [['system', t.ap_auto], ['dark', t.ap_dark], ['light', t.ap_light]]
  const dens: [Settings['density'], string][] = [['relaxed', t.den_relaxed], ['standard', t.den_standard], ['tight', t.den_tight]]
  const themeSeg = useLens<HTMLDivElement>(s.theme)
  const modeSeg = useLens<HTMLDivElement>(s.appearance)
  const denSeg = useLens<HTMLDivElement>(s.density)
  return (
    <div className="stack">
      <div className="set-preview">
        <div className="msg on"><div className="avatar" style={{ background: 'hsl(20 45% 38%)' }}>ΜΠ</div>
          <div className="msg-body"><div className="row"><i className="dot" /><b className="grow">Μαρία Παπαδοπούλου</b><span className="count">2</span><span className="muted small">10:24</span></div>
            <div className="subj">{t.previewSubject}</div><div className="snip muted">{t.previewText}</div></div></div>
        <div className="row"><button className="pill primary small">{t.send}</button><button className="pill small">{t.reply}</button></div>
      </div>

      <div className="set-row"><span>{t.theme}</span>
        <div className="theme-tiles seg lens" ref={themeSeg}>
          {(['simba', 'pumba'] as const).map((th) => (
            <button key={th} className={`theme-tile ${th} ${s.theme === th ? 'on' : ''}`} onClick={(e) => set('theme', th, e)}>
              <i className="tile-art" /><span>{th === 'simba' ? 'Simba' : 'Pumba'}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="set-row"><span>{t.dayNight}</span>
        <div className="seg lens" ref={modeSeg}>
          {modes.map(([k, label]) => <button key={k} className={s.appearance === k ? 'on' : ''} onClick={(e) => set('appearance', k, e)}>{label}</button>)}
        </div>
      </div>
      <div className="set-row"><span>{t.accent}</span>
        <div className="accents">
          <button className={`accent-dot theme-own ${!s.accent ? 'on' : ''}`} title={t.themeColor} onClick={() => set('accent', '')} />
          {ACCENTS.map(([k, label, hex]) => (
            <button key={k} className={`accent-dot ${s.accent === k ? 'on' : ''} ${k === 'white' ? 'white' : ''}`} title={label} style={{ ['--c' as any]: hex }} onClick={() => set('accent', k)} />
          ))}
        </div>
      </div>
      <div className="set-row"><span>{t.font}</span>
        <select value={s.font} onChange={(e) => set('font', e.target.value as Settings['font'])}>
          {FONTS.map(([k, label, fam]) => <option key={k} value={k} style={{ fontFamily: fam }}>{label}</option>)}
        </select>
      </div>
      <div className="set-row"><span>{t.density}</span>
        <div className="seg lens" ref={denSeg}>
          {dens.map(([k, label]) => <button key={k} className={s.density === k ? 'on' : ''} onClick={() => set('density', k)}>{label}</button>)}
        </div>
      </div>
      <div className="set-row"><span>{t.corners} <b className="muted">{s.radius}px</b></span>
        <input type="range" min={4} max={16} step={2} value={s.radius} onChange={(e) => set('radius', Number(e.target.value))} />
      </div>
      <div className="set-row"><span>{t.textSize} <b className="muted">{TEXT_SIZES[s.textSize]}px</b></span>
        <input type="range" min={0} max={4} step={1} value={s.textSize} onChange={(e) => set('textSize', Number(e.target.value))} />
      </div>
      <Toggle label={t.motion} hint={t.motionHint} on={s.motion} set={(v) => set('motion', v)} />
      <Toggle label={t.glassLook} hint={t.glassHint} on={s.glass} set={(v) => set('glass', v)} />
      <Toggle label={t.focusRings} hint={t.focusHint} on={s.focusRings} set={(v) => set('focusRings', v)} />
      <Toggle label={t.lite} hint={t.liteHint} on={s.lite} set={(v) => set('lite', v)} />
    </div>
  )
}

export function Toggle({ label, hint, on, set, disabled }: { label: string; hint?: string; on: boolean; set: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`toggle ${disabled ? 'off' : ''}`}>
      <span className="grow"><b>{label}</b>{hint && <small className="muted">{hint}</small>}</span>
      <span className="switch"><input type="checkbox" checked={on} disabled={disabled} onChange={(e) => set(e.target.checked)} /><i /></span>
    </label>
  )
}

function Shortcuts() {
  const rows: [string, Key][] = [
    ['C', 'compose'], ['R', 'reply'], ['A', 'replyAll'], ['F', 'forward'], ['E', 'archiveIt'], ['#', 'trashIt'], ['M', 'moveTo'],
    ['B', 'snoozeIt'], ['S', 'flag'], ['U', 'markUnread'], ['Z', 'undo'], ['/', 'search'], ['J / ↓', 'nextMsg'], ['K / ↑', 'prevMsg'],
    ['⌘A', 'selectAll'], ['⌘↵', 'send'], ['Esc', 'cancel'],
  ]
  return (
    <div className="keys">
      {rows.map(([k, label]) => <div className="key-row" key={k}><kbd>{k}</kbd><span>{t[label]}</span></div>)}
    </div>
  )
}

function Accounts({ sigs, onAdd }: { accounts: Account[]; sigs: Signature[]; onAdd: () => void }) {
  // every account, the switched-off ones too, kept fresh while the page is open
  const [all, setAll] = useState<Account[]>([])
  const [pick, setPick] = useState('')
  useEffect(() => {
    const load = () => window.roarmail.allAccounts().then(setAll)
    load()
    return window.roarmail.on((e) => { if (e.type === 'accounts') load() })
  }, [])
  const a = all.find((x) => x.id === pick) || all[0]
  return (
    <div className="stack">
      <div className="acct-pick">
        {all.map((x) => (
          <button key={x.id} className={`acct-chip ${x.id === a?.id ? 'on' : ''} ${x.enabled ? '' : 'disabled'}`} onClick={() => setPick(x.id)} title={x.email}>
            <span className="acc-dot" style={{ background: x.color }} />
            <span className="ellipsis">{x.description || x.email}</span>
          </button>
        ))}
        <button className="acct-chip add" onClick={onAdd} title={t.addAccount}><Icon name="plus" size={14} /></button>
      </div>
      {a && <AccountDetail key={a.id} a={a} sigs={sigs} />}
    </div>
  )
}

type AccTab = 'info' | 'folders' | 'server'

function AccountDetail({ a, sigs }: { a: Account; sigs: Signature[] }) {
  const [tab, setTab] = useState<AccTab>('info')
  const seg = useLens<HTMLDivElement>(tab)
  const tabs: [AccTab, string][] = [['info', t.ac_info], ['folders', t.ac_folders], ['server', t.ac_server]]
  return (
    <div className="panel acct-detail">
      <div className="row">
        <span className="acc-dot big" style={{ background: a.color }} />
        <span className="grow"><b className="ellipsis">{a.email}</b>
          <span className={`muted small state ${a.state}`}>{a.enabled ? t[a.state as Key] || '' : t.ac_off}</span></span>
        <div className="seg lens" ref={seg}>
          {tabs.map(([k, label]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}
        </div>
      </div>
      {tab === 'info' && <AccountInfo a={a} sigs={sigs} />}
      {tab === 'folders' && <AccountFolders a={a} />}
      {tab === 'server' && <AccountServer a={a} />}
    </div>
  )
}

function AccountInfo({ a, sigs }: { a: Account; sigs: Signature[] }) {
  const [name, setName] = useState(a.displayName)
  const [desc, setDesc] = useState(a.description)
  const [alias, setAlias] = useState({ email: '', name: '' })
  const [error, setError] = useState('')
  const up = (patch: Parameters<typeof window.roarmail.updateAccount>[1]) => window.roarmail.updateAccount(a.id, patch)
  const addAlias = async () => {
    setError('')
    try { await window.roarmail.addAlias(a.id, alias.email, alias.name); setAlias({ email: '', name: '' }) } catch { setError(t.ac_badAlias) }
  }
  return (
    <>
      <Toggle label={t.ac_enabled} hint={t.ac_enabledHint} on={a.enabled} set={(v) => up({ enabled: v })} />
      <div className="row two">
        <label className="grow">{t.ac_description}
          <input value={desc} placeholder={a.email} onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== a.description && up({ description: desc })} />
        </label>
        <label className="grow">{t.name}
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== a.displayName && up({ displayName: name.trim() })} />
        </label>
      </div>
      <div className="row wrap">
        <span className="muted small label-w">{t.color}</span>
        {COLORS.map((c) => <button key={c} className={`swatch ${a.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => up({ color: c })} />)}
      </div>
      <label>{t.signature}
        <select value={a.signatureId || ''} onChange={(e) => up({ signatureId: e.target.value || null })}>
          <option value="">{t.noSignature}</option>
          {sigs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label>{t.ac_attachments}
        <select value={a.attachments} onChange={(e) => up({ attachments: e.target.value as Account['attachments'] })}>
          <option value="all">{t.ac_att_all}</option>
          <option value="recent">{t.ac_att_recent}</option>
          <option value="none">{t.ac_att_none}</option>
        </select>
      </label>

      <div className="aliases">
        <b>{t.ac_aliases}</b>
        <p className="muted small">{t.ac_aliasesHint}</p>
        {a.aliases.map((x) => (
          <div className="row blocked-row" key={x.id}>
            <span className="grow ellipsis">{x.name ? `${x.name} <${x.email}>` : x.email}</span>
            <button className="pill small ghost" onClick={() => window.roarmail.removeAlias(x.id)}>{t.delete}</button>
          </div>
        ))}
        <div className="row">
          <input className="grow" placeholder={t.ac_aliasEmail} value={alias.email} onChange={(e) => setAlias({ ...alias, email: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') addAlias() }} />
          <input className="grow" placeholder={t.ac_aliasName} value={alias.name} onChange={(e) => setAlias({ ...alias, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') addAlias() }} />
          <button className="pill small" disabled={!alias.email.trim()} onClick={addAlias}><Icon name="plus" size={13} /> {t.ac_addAlias}</button>
        </div>
        {error && <p className="error small">{error}</p>}
      </div>

      <div className="row end">
        <button className="pill small ghost danger" onClick={() => { if (confirm(`${t.removeQ}\n\n${a.email}`)) window.roarmail.removeAccount(a.id) }}>{t.removeAccount}</button>
      </div>
    </>
  )
}

const ROLE_ROWS: [keyof Account['roles'], Key][] = [['drafts', 'drafts'], ['sent', 'sent'], ['spam', 'spam'], ['trash', 'trash'], ['archive', 'archive']]
const ERASE_DAYS = [0, 1, 7, 30, 90]

/** Apple Mail's "Mailbox Behaviours": which folder is which, and erasing old Trash and Junk */
function AccountFolders({ a }: { a: Account }) {
  const [list, setList] = useState<{ path: string; name: string }[]>([])
  useEffect(() => { window.roarmail.serverFolders(a.id).then(setList) }, [a.id])
  const days = (n: number) => (n === 0 ? t.ac_never : n === 1 ? `1 ${t.day}` : `${n} ${t.days}`)
  return (
    <>
      <p className="muted small">{t.ac_foldersHint}</p>
      {ROLE_ROWS.map(([role, label]) => (
        <div className="set-row" key={role}><span>{t[label]}</span>
          <select value={a.roles[role] || ''} onChange={(e) => window.roarmail.updateAccount(a.id, { roles: { ...a.roles, [role]: e.target.value } })}>
            <option value="">{t.ac_serverChoice}</option>
            {list.map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}
          </select>
        </div>
      ))}
      <div className="set-row"><span>{t.ac_eraseTrash}</span>
        <select value={a.trashDays} onChange={(e) => window.roarmail.updateAccount(a.id, { trashDays: Number(e.target.value) })}>
          {ERASE_DAYS.map((n) => <option key={n} value={n}>{days(n)}</option>)}
        </select>
      </div>
      <div className="set-row"><span>{t.ac_eraseJunk}</span>
        <select value={a.junkDays} onChange={(e) => window.roarmail.updateAccount(a.id, { junkDays: Number(e.target.value) })}>
          {ERASE_DAYS.map((n) => <option key={n} value={n}>{days(n)}</option>)}
        </select>
      </div>
    </>
  )
}

/** Apple Mail's "Server Settings": tested before they are kept */
function AccountServer({ a }: { a: Account }) {
  const [c, setC] = useState({ imapHost: a.imapHost, imapPort: a.imapPort, imapTls: a.imapTls, smtpHost: a.smtpHost, smtpPort: a.smtpPort, smtpTls: a.smtpTls, username: a.username })
  const [pass, setPass] = useState('')
  const [state, setState] = useState<{ busy?: boolean; ok?: boolean; error?: string }>({})
  const changed = pass || (Object.keys(c) as (keyof typeof c)[]).some((k) => c[k] !== a[k])
  const save = async () => {
    setState({ busy: true })
    const r = await window.roarmail.updateServer(a.id, { ...c, email: a.email, displayName: a.displayName, provider: a.provider }, pass || undefined)
    setState(r.ok ? { ok: true } : { error: t[`err_${r.error}` as Key] || r.error })
    if (r.ok) setPass('')
  }
  const tls = (v: Tls, set: (v: Tls) => void) => (
    <select value={v} onChange={(e) => set(e.target.value as Tls)}>
      <option value="tls">SSL/TLS</option><option value="starttls">STARTTLS</option><option value="none">{t.ac_noTls}</option>
    </select>
  )
  return (
    <>
      <b className="small muted">{t.ac_incoming}</b>
      <div className="row two">
        <label className="grow">{t.ac_host}<input value={c.imapHost} onChange={(e) => setC({ ...c, imapHost: e.target.value.trim() })} /></label>
        <label className="port">{t.ac_port}<input type="number" value={c.imapPort} onChange={(e) => setC({ ...c, imapPort: Number(e.target.value) })} /></label>
        <label>{t.ac_security}{tls(c.imapTls, (v) => setC({ ...c, imapTls: v }))}</label>
      </div>
      <b className="small muted">{t.ac_outgoing}</b>
      <div className="row two">
        <label className="grow">{t.ac_host}<input value={c.smtpHost} onChange={(e) => setC({ ...c, smtpHost: e.target.value.trim() })} /></label>
        <label className="port">{t.ac_port}<input type="number" value={c.smtpPort} onChange={(e) => setC({ ...c, smtpPort: Number(e.target.value) })} /></label>
        <label>{t.ac_security}{tls(c.smtpTls, (v) => setC({ ...c, smtpTls: v }))}</label>
      </div>
      <div className="row two">
        <label className="grow">{t.ac_username}<input value={c.username} onChange={(e) => setC({ ...c, username: e.target.value.trim() })} /></label>
        <label className="grow">{t.ac_password}<input type="password" value={pass} placeholder={t.ac_passwordKeep} onChange={(e) => setPass(e.target.value)} /></label>
      </div>
      <div className="row end">
        {state.ok && <span className="small ok-text">{t.ac_serverSaved}</span>}
        {state.error && <span className="small error">{state.error}</span>}
        <button className="pill small primary" disabled={!changed || state.busy} onClick={save}>{state.busy ? t.ac_testing : t.ac_testSave}</button>
      </div>
    </>
  )
}

function Signatures({ sigs, reload }: { sigs: Signature[]; reload: () => void }) {
  const [editing, setEditing] = useState<string | null>(sigs[0]?.id || null)
  const current = sigs.find((s) => s.id === editing)
  return (
    <div className="sig-layout">
      <div className="sig-list">
        {sigs.map((s) => <button key={s.id} className={`folder ${s.id === editing ? 'on' : ''}`} onClick={() => setEditing(s.id)}><span className="grow ellipsis">{s.name}</span></button>)}
        <button className="pill small" onClick={async () => { const s = await window.roarmail.saveSignature({ id: '', name: t.newSignature, html: '' }); await reload(); setEditing(s.id) }}>
          <Icon name="plus" size={13} /> {t.newSignature}
        </button>
      </div>
      {current ? <SignatureEditor key={current.id} sig={current} reload={reload} onDeleted={() => setEditing(null)} /> : <div className="muted sig-empty">{t.signatures}</div>}
    </div>
  )
}

function SignatureEditor({ sig, reload, onDeleted }: { sig: Signature; reload: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(sig.name)
  const [saved, setSaved] = useState(false)
  const ed = useRef<HTMLDivElement>(null)
  useEffect(() => { if (ed.current) ed.current.innerHTML = DOMPurify.sanitize(sig.html) }, [])
  const save = async () => {
    await window.roarmail.saveSignature({ id: sig.id, name: name.trim() || t.signature, html: DOMPurify.sanitize(ed.current?.innerHTML || '') })
    reload(); setSaved(true); setTimeout(() => setSaved(false), 1500)
  }
  return (
    <div className="sig-edit">
      <label>{t.signatureName}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="editor sig" ref={ed} contentEditable suppressContentEditableWarning />
      <div className="row end">
        <button className="pill small ghost danger" onClick={async () => { await window.roarmail.deleteSignature(sig.id); reload(); onDeleted() }}>{t.delete}</button>
        <button className="pill small primary" onClick={save}>{saved ? t.saved : t.save}</button>
      </div>
    </div>
  )
}

function General() {
  const [s, setS] = useState<Settings | null>(null)
  const [isDefault, setIsDefault] = useState<boolean | null>(null)
  useEffect(() => { window.roarmail.settings().then(setS); window.roarmail.isDefaultMail().then(setIsDefault) }, [])
  if (!s) return null
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => { setS({ ...s, [k]: v }); window.roarmail.setSetting(k, v) }
  const swipes: SwipeAction[] = ['archive', 'trash', 'snooze', 'flag', 'seen', 'none']
  const every: [number, string][] = [[1, t.g_every1], [5, t.g_every5], [15, t.g_every15], [30, t.g_every30], [60, t.g_every60], [0, t.g_manually]]
  const folderName = s.downloadsFolder.split(/[\\/]/).filter(Boolean).pop() || ''
  return (
    <div className="stack">
      <div className="set-row"><span>{t.g_defaultApp}</span>
        {isDefault
          ? <span className="muted small ok-text"><Icon name="shield" size={14} /> RoarMail</span>
          : <button className="pill small" disabled={isDefault == null} onClick={() => window.roarmail.makeDefaultMail().then(setIsDefault)}>{t.g_makeDefault}</button>}
      </div>
      <div className="set-row"><span>{t.g_checkEvery}</span>
        <select value={s.checkEvery} onChange={(e) => set('checkEvery', Number(e.target.value))}>
          {every.map(([n, label]) => <option key={n} value={n}>{label}</option>)}
        </select>
      </div>
      <div className="set-row"><span>{t.g_sound}</span>
        <div className="row">
          <select value={s.newMailSound} onChange={(e) => { const v = e.target.value as Settings['newMailSound']; set('newMailSound', v); if (v !== 'system' && v !== 'none') playNewMail(v) }}>
            <option value="system">{t.g_soundSystem}</option>
            {NEW_MAIL_SOUNDS.map((k) => <option key={k} value={k}>{t[`snd_${k}` as Key]}</option>)}
            <option value="none">{t.g_soundNone}</option>
          </select>
          <button className="tool small" title={t.g_play} disabled={s.newMailSound === 'system' || s.newMailSound === 'none'} onClick={() => playNewMail(s.newMailSound as NewMailSound)}><Icon name="bell" size={15} /></button>
        </div>
      </div>
      <Toggle label={t.g_actionSounds} hint={t.g_actionSoundsHint} on={s.actionSounds} set={(v) => set('actionSounds', v)} />
      <div className="set-row"><span>{t.g_badge}</span>
        <select value={s.dockBadge} onChange={(e) => set('dockBadge', e.target.value as Settings['dockBadge'])}>
          <option value="inbox">{t.g_badgeInbox}</option><option value="all">{t.g_badgeAll}</option><option value="none">{t.g_badgeNone}</option>
        </select>
      </div>
      <div className="set-row"><span>{t.g_notify}</span>
        <select value={s.notifyFor} onChange={(e) => set('notifyFor', e.target.value as Settings['notifyFor'])}>
          <option value="inbox">{t.g_notifyInbox}</option><option value="known">{t.g_notifyKnown}</option><option value="none">{t.g_notifyNone}</option>
        </select>
      </div>
      <div className="set-row"><span>{t.g_downloads}</span>
        <div className="row">
          <span className="muted small ellipsis dl-name" title={s.downloadsFolder}>{s.downloadsFolder ? folderName : t.g_askEachTime}</span>
          <button className="pill small" onClick={() => window.roarmail.pickFolder().then((p) => { if (p) set('downloadsFolder', p) })}>{t.g_choose}</button>
          {s.downloadsFolder && <button className="pill small ghost" onClick={() => set('downloadsFolder', '')}>{t.g_askEachTime}</button>}
        </div>
      </div>
      <Toggle label={t.g_retry} hint={t.g_retryHint} on={s.retrySending} set={(v) => set('retrySending', v)} />
      <Toggle label={t.runAtLoginShort} hint={t.runAtLogin} on={s.runAtLogin} set={(v) => set('runAtLogin', v)} />
      <div className="set-row"><span>{t.undoSend}</span>
        <select value={s.undoSendSeconds} onChange={(e) => set('undoSendSeconds', Number(e.target.value))}>
          {[0, 5, 10, 20, 30].map((n) => <option key={n} value={n}>{n ? `${n} ${t.seconds}` : t.off}</option>)}
        </select>
      </div>
      <div className="set-row"><span>{t.swipeLeft}</span>
        <select value={s.swipeLeft} onChange={(e) => set('swipeLeft', e.target.value as SwipeAction)}>
          {swipes.map((w) => <option key={w} value={w}>{t[`sw_${w}` as Key]}</option>)}
        </select>
      </div>
      <div className="set-row"><span>{t.swipeRight}</span>
        <select value={s.swipeRight} onChange={(e) => set('swipeRight', e.target.value as SwipeAction)}>
          {swipes.map((w) => <option key={w} value={w}>{t[`sw_${w}` as Key]}</option>)}
        </select>
      </div>
      <h4 className="set-sub">{t.g_searchIn}</h4>
      <Toggle label={t.trash} on={s.searchTrash} set={(v) => set('searchTrash', v)} />
      <Toggle label={t.spam} on={s.searchJunk} set={(v) => set('searchJunk', v)} />
    </div>
  )
}

const QUOTE_COLORS: [string, Key][] = [
  ['#6d5dfc', 'qc_purple'], ['#1fa3b8', 'qc_teal'], ['#3fae49', 'qc_green'], ['#2f7bff', 'qc_blue'],
  ['#e0413a', 'qc_red'], ['#f08a24', 'qc_orange'], ['#e5489b', 'qc_pink'], ['#8a8f98', 'qc_grey'],
]

/** Apple Mail's "Fonts & Colours": the list, messages and fixed width; quoted text coloured by level */
function Fonts({ s, onChange }: { s: Settings; onChange: (s: Settings) => void }) {
  const [local, setLocal] = useState<string[] | null>(null)
  const [noLocal, setNoLocal] = useState(false)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => { window.roarmail.setSetting(k, v); onChange({ ...s, [k]: v }) }
  // the fonts installed on this computer (Cera GR and the rest), asked for when the person wants them
  const loadLocal = async () => {
    try {
      const q = (window as any).queryLocalFonts as undefined | (() => Promise<{ family: string }[]>)
      if (!q) throw new Error('none')
      const fams = [...new Set((await q()).map((f) => f.family))].sort((x, y) => x.localeCompare(y))
      if (!fams.length) throw new Error('none')
      setLocal(fams)
    } catch { setNoLocal(true) }
  }
  const picker = (k: 'listFont' | 'messageFont' | 'monoFont') => (
    <select value={s[k]} style={{ fontFamily: fontStack(s[k]) }} onChange={(e) => set(k, e.target.value)}>
      <optgroup label="RoarMail">
        {FONTS.map(([key, label, fam]) => <option key={key} value={key} style={{ fontFamily: fam }}>{label}</option>)}
      </optgroup>
      {(local || (s[k].startsWith('local:') ? [s[k].slice(6)] : [])).length > 0 && (
        <optgroup label={t.f_computer}>
          {(local || [s[k].slice(6)]).map((f) => <option key={f} value={`local:${f}`} style={{ fontFamily: `"${f}"` }}>{f}</option>)}
        </optgroup>
      )}
    </select>
  )
  const levels: ['quote1' | 'quote2' | 'quote3', Key][] = [['quote1', 'f_level1'], ['quote2', 'f_level2'], ['quote3', 'f_level3']]
  return (
    <div className="stack">
      <div className="set-row"><span>{t.f_list}</span>
        <div className="row">{picker('listFont')}
          <select value={s.listSize} onChange={(e) => set('listSize', Number(e.target.value))}>
            {[12, 13, 14, 15, 16, 18].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>
      <div className="set-row"><span>{t.f_message}</span>
        <div className="row">{picker('messageFont')}
          <select value={s.textSize} onChange={(e) => set('textSize', Number(e.target.value))}>
            {TEXT_SIZES.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select>
        </div>
      </div>
      <div className="set-row"><span>{t.f_mono}</span>{picker('monoFont')}</div>
      {!local && (
        <div className="set-row"><span className="muted small">{noLocal ? t.f_noComputer : t.f_computerHint}</span>
          {!noLocal && <button className="pill small" onClick={loadLocal}>{t.f_showComputer}</button>}
        </div>
      )}
      <Toggle label={t.f_plainMono} on={s.plainMono} set={(v) => set('plainMono', v)} />
      <Toggle label={t.f_quoteColors} on={s.quoteColors} set={(v) => set('quoteColors', v)} />
      {s.quoteColors && (
        <div className="quote-set">
          <div className="quote-levels">
            {levels.map(([k, label]) => (
              <div className="row" key={k}>
                <span className="muted small label-w">{t[label]}</span>
                {QUOTE_COLORS.map(([hex, name]) => (
                  <button key={hex} className={`swatch ${s[k] === hex ? 'on' : ''}`} title={t[name]} style={{ background: hex }} onClick={() => set(k, hex)} />
                ))}
              </div>
            ))}
          </div>
          <div className="quote-preview" style={{ fontFamily: fontStack(s.messageFont) }}>
            <div style={{ borderColor: s.quote1, color: s.quote1 }}>{t.f_level1}
              <div style={{ borderColor: s.quote2, color: s.quote2 }}>{t.f_level2}
                <div style={{ borderColor: s.quote3, color: s.quote3 }}>{t.f_level3}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Privacy() {
  const [s, setS] = useState<Settings | null>(null)
  const [lock, setLock] = useState<LockState | null>(null)
  const [blocked, setBlocked] = useState<string[]>([])
  useEffect(() => {
    window.roarmail.settings().then(setS)
    window.roarmail.lockState().then(setLock)
    window.roarmail.blockedSenders().then(setBlocked)
  }, [])
  if (!s || !lock) return null
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => { setS({ ...s, [k]: v }); window.roarmail.setSetting(k, v) }
  return (
    <div className="stack">
      <Toggle label={t.blockTrackersShort} hint={t.blockTrackers} on={s.blockTrackers} set={(v) => set('blockTrackers', v)} />
      <Toggle label={t.stripTrackingShort} hint={t.stripTracking} on={s.stripTracking} set={(v) => set('stripTracking', v)} />

      <div className="panel">
        <label className="check"><input type="checkbox" disabled={!lock.available} checked={s.lock && lock.available} onChange={(e) => set('lock', e.target.checked)} />
          <Icon name="lock" size={15} /> {t.appLock}</label>
        {!lock.available && <p className="muted small">{t.lockUnavailable}</p>}
        {lock.available && s.lock && (
          <div className="row">
            <label className="grow">{t.lockAfter}
              <select value={s.lockAfter} onChange={(e) => set('lockAfter', Number(e.target.value))}>
                {[0, 1, 5, 15, 60].map((n) => <option key={n} value={n}>{n ? `${n} ${t.minutes}` : t.onlySleep}</option>)}
              </select>
            </label>
            <button className="pill small" onClick={() => window.roarmail.lockNow()}>{t.lockNow}</button>
          </div>
        )}
      </div>

      <div className="panel">
        <b>{t.blockedSenders}</b>
        {!blocked.length && <p className="muted small">{t.noneBlocked}</p>}
        {blocked.map((e) => (
          <div className="row blocked-row" key={e}>
            <span className="grow ellipsis">{e}</span>
            <button className="pill small ghost" onClick={async () => { await window.roarmail.blockSender(e, false); setBlocked(blocked.filter((x) => x !== e)) }}>{t.unblock}</button>
          </div>
        ))}
      </div>
    </div>
  )
}
