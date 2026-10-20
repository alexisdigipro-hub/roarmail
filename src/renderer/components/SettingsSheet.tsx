// Settings: accounts (name, colour, signature, remove), signatures, and general (undo send, swipes).
import { useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import type { Account, LockState, Settings, Signature, SwipeAction } from '../../shared/api'
import { t, type Key } from '../i18n'
import { Icon } from './Icon'

const COLORS = ['#d40000', '#ff8a00', '#2f9bff', '#33c27f', '#b04cff', '#ff4fa3', '#00b8b0', '#c9a227']
type Tab = 'accounts' | 'signatures' | 'privacy' | 'general'

export function SettingsSheet({ accounts, onAddAccount, onClose }: { accounts: Account[]; onAddAccount: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('accounts')
  const [sigs, setSigs] = useState<Signature[]>([])
  const loadSigs = () => window.roarmail.signatures().then(setSigs)
  useEffect(() => { loadSigs() }, [])

  return (
    <div className="sheet-wrap" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div className="sheet settings">
        <div className="settings-head">
          <div className="tabs">
            {(['accounts', 'signatures', 'privacy', 'general'] as Tab[]).map((k) => (
              <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{t[k]}</button>
            ))}
          </div>
          <button className="tool" onClick={onClose} title={t.done}><Icon name="close" /></button>
        </div>
        <div className="settings-body">
          {tab === 'accounts' && <Accounts accounts={accounts} sigs={sigs} onAdd={onAddAccount} />}
          {tab === 'signatures' && <Signatures sigs={sigs} reload={loadSigs} />}
          {tab === 'privacy' && <Privacy />}
          {tab === 'general' && <General />}
        </div>
      </div>
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
  const swipes: SwipeAction[] = ['archive', 'trash', 'flag', 'seen', 'none']
  return (
    <div className="stack">
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
      <p className="muted small">{t.shortcuts}</p>
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
      <label className="check"><input type="checkbox" checked={s.blockTrackers} onChange={(e) => set('blockTrackers', e.target.checked)} />{t.blockTrackers}</label>
      <label className="check"><input type="checkbox" checked={s.stripTracking} onChange={(e) => set('stripTracking', e.target.checked)} />{t.stripTracking}</label>

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
