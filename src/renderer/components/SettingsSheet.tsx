// Settings, laid out like RoarMe's: a list of pages on the left (icons, current values, a chevron, the lens
// sliding to the open one), the page on the right with a big title. Appearance carries RoarMe's look settings.
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import DOMPurify from 'dompurify'
import type { Account, LockState, Settings, Signature, SwipeAction } from '../../shared/api'
import { t, type Key } from '../i18n'
import { ACCENTS, FONTS, TEXT_SIZES, applyLook, revealFrom, useLens } from '../look'
import { Icon } from './Icon'
import { RoarMeAccount } from './RoarMe'

const COLORS = ['#d40000', '#ff8a00', '#2f9bff', '#33c27f', '#b04cff', '#ff4fa3', '#00b8b0', '#c9a227']
type Page = 'accounts' | 'roarme' | 'appearance' | 'signatures' | 'privacy' | 'general' | 'keys'
const PAGES: [Page, string][] = [
  ['accounts', 'inbox'], ['roarme', 'roar'], ['appearance', 'palette'], ['signatures', 'compose'], ['privacy', 'shield'], ['general', 'gear'], ['keys', 'keyboard'],
]

export function SettingsSheet({ accounts, onAddAccount, onClose, onLook }: {
  accounts: Account[]; onAddAccount: () => void; onClose: () => void; onLook: (s: Settings) => void
}) {
  const [page, setPage] = useState<Page>('accounts')
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

function Accounts({ accounts, sigs, onAdd }: { accounts: Account[]; sigs: Signature[]; onAdd: () => void }) {
  return (
    <div className="stack">
      {accounts.map((a) => <AccountRow key={a.id} a={a} sigs={sigs} />)}
      <button className="pill" onClick={onAdd}><Icon name="plus" size={14} /> {t.addAccount}</button>
    </div>
  )
}

function AccountRow({ a, sigs }: { a: Account; sigs: Signature[] }) {
  const [name, setName] = useState(a.displayName)
  return (
    <div className="panel">
      <div className="row">
        <span className="acc-dot big" style={{ background: a.color }} />
        <b className="grow ellipsis">{a.email}</b>
        <span className={`muted small state ${a.state}`}>{t[a.state as Key] || ''}</span>
      </div>
      <label>{t.name}
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== a.displayName && window.roarmail.updateAccount(a.id, { displayName: name.trim() })} />
      </label>
      <div className="row wrap">
        <span className="muted small label-w">{t.color}</span>
        {COLORS.map((c) => (
          <button key={c} className={`swatch ${a.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => window.roarmail.updateAccount(a.id, { color: c })} />
        ))}
      </div>
      <label>{t.signature}
        <select value={a.signatureId || ''} onChange={(e) => window.roarmail.updateAccount(a.id, { signatureId: e.target.value || null })}>
          <option value="">{t.noSignature}</option>
          {sigs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <p className="muted small">{a.imapHost}:{a.imapPort} · {a.smtpHost}:{a.smtpPort}</p>
      <div className="row end">
        <button className="pill small ghost danger" onClick={() => { if (confirm(`${t.removeQ}\n\n${a.email}`)) window.roarmail.removeAccount(a.id) }}>{t.removeAccount}</button>
      </div>
    </div>
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
  useEffect(() => { window.roarmail.settings().then(setS) }, [])
  if (!s) return null
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => { setS({ ...s, [k]: v }); window.roarmail.setSetting(k, v) }
  const swipes: SwipeAction[] = ['archive', 'trash', 'snooze', 'flag', 'seen', 'none']
  return (
    <div className="stack">
      <Toggle label={t.runAtLoginShort} hint={t.runAtLogin} on={s.runAtLogin} set={(v) => set('runAtLogin', v)} />
      <label>{t.undoSend}
        <select value={s.undoSendSeconds} onChange={(e) => set('undoSendSeconds', Number(e.target.value))}>
          {[0, 5, 10, 20, 30].map((n) => <option key={n} value={n}>{n ? `${n} ${t.seconds}` : t.off}</option>)}
        </select>
      </label>
      <label>{t.swipeLeft}
        <select value={s.swipeLeft} onChange={(e) => set('swipeLeft', e.target.value as SwipeAction)}>
          {swipes.map((w) => <option key={w} value={w}>{t[`sw_${w}` as Key]}</option>)}
        </select>
      </label>
      <label>{t.swipeRight}
        <select value={s.swipeRight} onChange={(e) => set('swipeRight', e.target.value as SwipeAction)}>
          {swipes.map((w) => <option key={w} value={w}>{t[`sw_${w}` as Key]}</option>)}
        </select>
      </label>
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
