// Writing a message: new, reply, reply all, forward. Cmd/Ctrl+Enter sends, Esc closes.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import DOMPurify from 'dompurify'
import type { Account, Address, MessageFull } from '../../shared/api'
import { fullDate, t } from '../i18n'
import { Icon } from './Icon'
import type { ComposeKind } from './Viewer'

export interface ComposeSeed {
  kind: ComposeKind | 'new'
  accountId?: string
  to?: string
  subject?: string
  body?: string
  source?: MessageFull
}

const fmt = (a: Address) => (a.name ? `${a.name.replace(/[",]/g, '')} <${a.address}>` : a.address)
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

function prefill(seed: ComposeSeed, accounts: Account[]) {
  const m = seed.source
  const accountId = m?.accountId || seed.accountId || accounts[0]?.id || ''
  if (!m || seed.kind === 'new') return { accountId, to: seed.to || '', cc: '', subject: seed.subject || '', body: seed.body ? esc(seed.body).replace(/\n/g, '<br>') : '' }
  const mine = accounts.find((a) => a.id === m.accountId)?.email.toLowerCase()
  const from = m.replyTo || m.fromEmail
  // the quoted mail is cleaned like in the reader, and its web images are left out
  const quoted = m.html
    ? DOMPurify.sanitize(m.html.replace(/<style[\s\S]*?<\/style>/gi, ''), {
      FORBID_TAGS: ['script', 'style', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base', 'img'],
      FORBID_ATTR: ['srcset', 'background'],
    }) as string
    : esc(m.text || '').replace(/\n/g, '<br>')
  const prefix = (p: string) => (new RegExp(`^${p}:`, 'i').test(m.subject) ? m.subject : `${p}: ${m.subject}`)
  if (seed.kind === 'forward') {
    const head = `<p>---------- ${t.original} ----------<br>${t.from}: ${esc(m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail)}<br>${fullDate(m.date)}<br>${t.subject}: ${esc(m.subject)}<br>${t.to}: ${esc(m.to.map(fmt).join(', '))}</p>`
    return { accountId, to: '', cc: '', subject: prefix('Fwd'), body: `<br><br>${head}${quoted}` }
  }
  const others = seed.kind === 'replyAll'
    ? [...m.to, ...m.cc].filter((a) => a.address.toLowerCase() !== mine && a.address.toLowerCase() !== from.toLowerCase()).map(fmt).join(', ')
    : ''
  const header = `${fullDate(m.date)}, ${esc(m.fromName || m.fromEmail)} ${t.wrote}:`
  return { accountId, to: from, cc: others, subject: prefix('Re'), body: `<br><br><p>${header}</p><blockquote>${quoted}</blockquote>` }
}

export function Composer({ seed, accounts, onClose, onSent }: { seed: ComposeSeed; accounts: Account[]; onClose: () => void; onSent: () => void }) {
  const init = useRef(prefill(seed, accounts)).current
  const [accountId, setAccountId] = useState(init.accountId)
  const [to, setTo] = useState(init.to)
  const [cc, setCc] = useState(init.cc)
  const [bcc, setBcc] = useState('')
  const [showCc, setShowCc] = useState(!!init.cc)
  const [subject, setSubject] = useState(init.subject)
  const [files, setFiles] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const body = useRef<HTMLDivElement>(null)
  const dirty = useRef(false)

  useEffect(() => {
    if (body.current) body.current.innerHTML = init.body
    const focus = seed.kind === 'new' && !init.to ? 'to' : 'body'
    if (focus === 'body' && body.current) { body.current.focus(); const r = document.createRange(); r.setStart(body.current, 0); r.collapse(true); getSelection()?.removeAllRanges(); getSelection()?.addRange(r) }
  }, [])

  async function send() {
    if (!to.trim() && !cc.trim() && !bcc.trim()) { setError(t.noRecipient); return }
    setBusy(true); setError('')
    const m = seed.source
    try {
      await window.roarmail.send({
        accountId, to, cc, bcc, subject,
        html: body.current?.innerHTML || '', text: body.current?.innerText || '',
        inReplyTo: m && seed.kind !== 'forward' ? m.messageId : undefined,
        references: m && seed.kind !== 'forward' ? m.messageId : undefined,
        replyToMessageId: m && seed.kind !== 'forward' ? m.id : undefined,
        attachments: files,
      })
      onSent()
    } catch (e: any) {
      setError(String(e?.message || e).replace(/^.*Error:\s*/, ''))
      setBusy(false)
    }
  }

  function close() {
    if (dirty.current && !confirm(t.discardQ)) return
    onClose()
  }

  return (
    <div className="sheet-wrap" onKeyDown={(e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() }
      if (e.key === 'Escape') { e.preventDefault(); close() }
    }}>
      <div className="sheet composer" onInput={() => { dirty.current = true }}>
        <div className="composer-head">
          <b>{seed.kind === 'new' ? t.compose : seed.kind === 'forward' ? t.forward : seed.kind === 'replyAll' ? t.replyAll : t.reply}</b>
          <button className="tool" onClick={close} title={t.discard}><Icon name="close" /></button>
        </div>
        {accounts.length > 1 && (
          <div className="field"><span>{t.from}</span>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>)}
            </select>
          </div>
        )}
        <Recipients label={t.to} value={to} onChange={setTo} autoFocus={seed.kind === 'new' && !init.to}
          extra={!showCc && <button className="link small" onClick={() => setShowCc(true)}>{t.cc} / {t.bcc}</button>} />
        {showCc && <Recipients label={t.cc} value={cc} onChange={setCc} />}
        {showCc && <Recipients label={t.bcc} value={bcc} onChange={setBcc} />}
        <div className="field"><span>{t.subject}</span><input value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
        <div className="editor" ref={body} contentEditable suppressContentEditableWarning spellCheck />
        {files.length > 0 && (
          <div className="files">
            {files.map((f) => (
              <span className="chip" key={f}><Icon name="clip" size={14} /> {f.split(/[\\/]/).pop()}
                <button onClick={() => setFiles(files.filter((x) => x !== f))}><Icon name="close" size={12} /></button></span>
            ))}
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="composer-foot">
          <button className="tool" title={t.attach} onClick={async () => { const p = await window.roarmail.pickFiles(); if (p.length) { setFiles([...files, ...p]); dirty.current = true } }}><Icon name="clip" /></button>
          <span className="grow" />
          <span className="muted small">⌘/Ctrl + Enter</span>
          <button className="pill primary" disabled={busy} onClick={send}>{busy ? t.sending : t.send}</button>
        </div>
      </div>
    </div>
  )
}

// a recipients field with suggestions from people already written to or heard from
function Recipients({ label, value, onChange, autoFocus, extra }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; extra?: ReactNode }) {
  const [hits, setHits] = useState<Address[]>([])
  const [pick, setPick] = useState(0)
  const last = value.split(',').pop()!.trim()

  useEffect(() => {
    if (last.length < 2) { setHits([]); return }
    let live = true
    window.roarmail.contacts(last).then((r) => { if (live) { setHits(r); setPick(0) } })
    return () => { live = false }
  }, [last])

  const choose = (a: Address) => {
    const parts = value.split(',').slice(0, -1).map((x) => x.trim()).filter(Boolean)
    onChange([...parts, fmt(a)].join(', ') + ', ')
    setHits([])
  }

  return (
    <div className="field recip">
      <span>{label}</span>
      <input value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)}
        onBlur={() => setTimeout(() => setHits([]), 150)}
        onKeyDown={(e) => {
          if (!hits.length) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setPick((pick + 1) % hits.length) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setPick((pick - 1 + hits.length) % hits.length) }
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(hits[pick]) }
        }} />
      {extra}
      {hits.length > 0 && (
        <ul className="suggest">
          {hits.map((a, i) => (
            <li key={a.address} className={i === pick ? 'on' : ''} onMouseDown={() => choose(a)}>
              <b>{a.name || a.address}</b>{a.name && <span className="muted"> {a.address}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
