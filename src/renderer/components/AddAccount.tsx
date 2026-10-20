// Add an account: email, name and password; the server settings are found by themselves and
// can be opened and changed by hand.
import { useState } from 'react'
import type { ServerConfig, Tls } from '../../shared/api'
import { t, type Key } from '../i18n'
import { Icon } from './Icon'

export function AddAccount({ first, onDone, onCancel }: { first: boolean; onDone: () => void; onCancel: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [pass, setPass] = useState('')
  const [cfg, setCfg] = useState<ServerConfig | null>(null)
  const [manual, setManual] = useState(false)
  const [busy, setBusy] = useState<'' | 'checking' | 'testing'>('')
  const [error, setError] = useState('')

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

  async function lookup() {
    setBusy('checking'); setError('')
    try {
      const c = await window.roarmail.autodetect(email.trim())
      setCfg({ ...c, displayName: name.trim() })
    } finally { setBusy('') }
  }

  async function connect() {
    if (!cfg) return
    setBusy('testing'); setError('')
    const full = { ...cfg, email: email.trim(), displayName: name.trim(), username: cfg.username || email.trim() }
    try {
      const r = await window.roarmail.testAccount(full, pass)
      if (!r.ok) { setError(errorText(r.error)); if (r.error !== 'auth') setManual(true); return }
      await window.roarmail.addAccount(r.cfg, pass)
      onDone()
    } catch (e: any) {
      setError(errorText(String(e?.message || e).replace(/^.*Error:\s*/, '')))
    } finally { setBusy('') }
  }

  const set = (k: keyof ServerConfig) => (v: string) => setCfg((c) => c && ({ ...c, [k]: /Port$/.test(k) ? Number(v) || 0 : v }))

  return (
    <div className="sheet-wrap">
      <form className="sheet add" onSubmit={(e) => { e.preventDefault(); cfg ? connect() : lookup() }}>
        <div className="brand"><b>ROAR</b><i>MAIL</i></div>
        <h1>{first ? t.welcome : t.addAccount}</h1>
        <p className="muted">{t.welcomeSub}</p>

        <label>{t.email}<input type="email" autoFocus value={email} disabled={!!cfg} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label>
        <label>{t.name}<input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.namePh} /></label>

        {cfg && (
          <>
            <label>{t.password}<input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} /></label>
            {cfg.hint && <p className="hint">{t[`hint_${cfg.hint}` as Key]}</p>}
            <button type="button" className="link" onClick={() => setManual((m) => !m)}>
              <Icon name="chevron" size={14} /> {t.advanced}
            </button>
            {manual && (
              <div className="servers">
                <Server title={t.incoming} host={cfg.imapHost} port={cfg.imapPort} tls={cfg.imapTls}
                  onHost={set('imapHost')} onPort={set('imapPort')} onTls={set('imapTls')} />
                <Server title={t.outgoing} host={cfg.smtpHost} port={cfg.smtpPort} tls={cfg.smtpTls}
                  onHost={set('smtpHost')} onPort={set('smtpPort')} onTls={set('smtpTls')} />
                <label>{t.username}<input value={cfg.username} onChange={(e) => set('username')(e.target.value)} /></label>
              </div>
            )}
          </>
        )}

        {error && <p className="error">{error}</p>}
        {busy && <p className="muted">{busy === 'checking' ? t.checking : t.testing}</p>}

        <div className="row end">
          {cfg ? <button type="button" className="pill ghost" onClick={() => { setCfg(null); setError(''); setManual(false) }}>{t.back}</button>
            : !first && <button type="button" className="pill ghost" onClick={onCancel}>{t.cancel}</button>}
          <button className="pill primary" disabled={!!busy || !validEmail || (!!cfg && !pass)}>{cfg ? t.connect : t.next}</button>
        </div>
      </form>
    </div>
  )
}

function Server(p: { title: string; host: string; port: number; tls: Tls; onHost: (v: string) => void; onPort: (v: string) => void; onTls: (v: string) => void }) {
  return (
    <fieldset>
      <legend>{p.title}</legend>
      <div className="row">
        <label className="grow">{t.host}<input value={p.host} onChange={(e) => p.onHost(e.target.value)} /></label>
        <label className="port">{t.port}<input inputMode="numeric" value={p.port} onChange={(e) => p.onPort(e.target.value)} /></label>
        <label className="sec">{t.security}
          <select value={p.tls} onChange={(e) => p.onTls(e.target.value)}>
            <option value="tls">SSL/TLS</option><option value="starttls">STARTTLS</option><option value="none">—</option>
          </select>
        </label>
      </div>
    </fieldset>
  )
}

function errorText(code: string) {
  const k = `err_${code}` as Key
  return (t as Record<string, string>)[k] || code
}
