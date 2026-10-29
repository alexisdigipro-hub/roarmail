// Move to another computer (Alex, 29 Oct): on the old computer Export makes one file sealed with a passphrase the
// person picks; on the new one Import with the same passphrase brings back every account, signature, template, rule,
// setting, folder look and contact. The mail comes again from the servers.
import { useState } from 'react'
import { t, type Key } from '../i18n'
import { Icon } from './Icon'

export function MoveSetup({ only, onImported }: { only?: 'import'; onImported?: () => void }) {
  const [mode, setMode] = useState<'' | 'export' | 'import'>(only || '')
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const err = (e: unknown) => { const k = String((e as Error)?.message || e).replace(/^.*Error:\s*/, ''); return t[`mv_err_${k}` as Key] || k }

  const go = async () => {
    setBusy(true); setNote(null)
    try {
      if (mode === 'export') {
        const p = await window.roarmail.exportSetup(pass)
        if (p) { setNote({ ok: true, text: `${t.mv_saved} ${p.split(/[\\/]/).pop()}` }); setPass(''); setAgain('') }
      } else {
        const r = await window.roarmail.importSetup(pass)
        if (r) { setNote({ ok: true, text: `${t.mv_done} ${r.accounts} ${t.mv_accounts}, ${r.signatures} ${t.mv_signatures}, ${r.templates} ${t.mv_templates}, ${r.rules} ${t.mv_rules}.` }); setPass(''); onImported?.() }
      }
    } catch (e) { setNote({ ok: false, text: err(e) }) } finally { setBusy(false) }
  }

  const can = mode === 'export' ? pass.length >= 6 && pass === again : pass.length > 0
  return (
    <div className="move-setup">
      {!only && (
        <div className="row">
          <button type="button" className={`pill small ${mode === 'export' ? 'primary' : ''}`} onClick={() => { setMode(mode === 'export' ? '' : 'export'); setNote(null); setPass(''); setAgain('') }}><Icon name="up" size={14} /> {t.mv_export}</button>
          <button type="button" className={`pill small ${mode === 'import' ? 'primary' : ''}`} onClick={() => { setMode(mode === 'import' ? '' : 'import'); setNote(null); setPass(''); setAgain('') }}><Icon name="down" size={14} /> {t.mv_import}</button>
        </div>
      )}
      {mode && (
        <div className="move-form" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (can && !busy) go() } }}>
          <p className="muted small">{mode === 'export' ? t.mv_exportHint : t.mv_importHint}</p>
          <div className="row two">
            <label className="grow">{t.mv_pass}<input id={`mv-pass-${mode}`} type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
            {mode === 'export' && <label className="grow">{t.mv_again}<input id="mv-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>}
          </div>
          {mode === 'export' && pass && again && pass !== again && <p className="error small">{t.mv_mismatch}</p>}
          <div className="row end">
            <button className="pill small primary" type="button" onClick={go} disabled={!can || busy}>{busy ? '…' : mode === 'export' ? t.mv_exportGo : t.mv_importGo}</button>
          </div>
        </div>
      )}
      {note && <p className={`small ${note.ok ? 'ok-text' : 'error'}`}>{note.text}</p>}
    </div>
  )
}
