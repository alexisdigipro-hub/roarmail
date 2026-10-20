// Writing a message: new, reply, reply all, forward, or a draft picked up again. Saved as a draft while
// writing; closing offers to keep it in Drafts. Cmd/Ctrl+Enter sends, Esc closes.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import DOMPurify from 'dompurify'
import type { Account, Address, Draft, MessageFull, Signature } from '../../shared/api'
import { fullDate, t } from '../i18n'
import { Icon } from './Icon'
import type { ComposeKind } from './Viewer'
import { TimePicker } from './TimePicker'

export interface ComposeSeed {
  kind: ComposeKind | 'new' | 'draft'
  accountId?: string
  to?: string
  subject?: string
  body?: string
  source?: MessageFull
  draft?: Draft
}

const fmt = (a: Address) => (a.name ? `${a.name.replace(/[",]/g, '')} <${a.address}>` : a.address)
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const SIG = 'data-roarmail-signature'

function prefill(seed: ComposeSeed, accounts: Account[]) {
  if (seed.kind === 'draft' && seed.draft) {
    const d = seed.draft
    return { accountId: d.accountId, to: d.to, cc: d.cc || '', bcc: d.bcc || '', subject: d.subject, body: DOMPurify.sanitize(d.html), signed: true }
  }
  const m = seed.source
  const accountId = m?.accountId || seed.accountId || accounts[0]?.id || ''
  if (!m || seed.kind === 'new') return { accountId, to: seed.to || '', cc: '', bcc: '', subject: seed.subject || '', body: seed.body ? esc(seed.body).replace(/\n/g, '<br>') : '', signed: false }
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
    return { accountId, to: '', cc: '', bcc: '', subject: prefix('Fwd'), body: `<br><br>${head}${quoted}`, signed: false }
  }
  const others = seed.kind === 'replyAll'
    ? [...m.to, ...m.cc].filter((a) => a.address.toLowerCase() !== mine && a.address.toLowerCase() !== from.toLowerCase()).map(fmt).join(', ')
    : ''
  const header = `${fullDate(m.date)}, ${esc(m.fromName || m.fromEmail)} ${t.wrote}:`
  return { accountId, to: from, cc: others, bcc: '', subject: prefix('Re'), body: `<br><br><p>${header}</p><blockquote>${quoted}</blockquote>`, signed: false }
}

export function Composer({ seed, accounts, onClose, onSent }: {
  seed: ComposeSeed; accounts: Account[]
  onClose: (saved: boolean) => void; onSent: (outboxId: string, at?: number) => void
}) {
  const init = useRef(prefill(seed, accounts)).current
  const [accountId, setAccountId] = useState(init.accountId)
  const [to, setTo] = useState(init.to)
  const [cc, setCc] = useState(init.cc)
  const [bcc, setBcc] = useState(init.bcc)
  const [showCc, setShowCc] = useState(!!(init.cc || init.bcc))
  const [subject, setSubject] = useState(init.subject)
  const [files, setFiles] = useState<string[]>(seed.draft?.attachments || [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [asking, setAsking] = useState(false)
  const [sigs, setSigs] = useState<Signature[]>([])
  const [later, setLater] = useState(false)
  const [remindDays, setRemindDays] = useState(0)
  const body = useRef<HTMLDivElement>(null)
  const dirty = useRef(false)
  const draftId = useRef<string | undefined>(seed.draft?.id)
  const saving = useRef<Promise<unknown> | null>(null)

  const thread = seed.kind === 'draft' ? seed.draft : seed.source && seed.kind !== 'forward' ? seed.source : undefined
  const replyMeta = () => {
    if (seed.kind === 'draft' && seed.draft) return { inReplyTo: seed.draft.inReplyTo, references: seed.draft.references, replyToMessageId: seed.draft.replyToMessageId }
    const m = seed.source
    if (!m || seed.kind === 'forward' || seed.kind === 'new') return {}
    return { inReplyTo: m.messageId, references: [m.references, m.messageId].filter(Boolean).join(' ') || undefined, replyToMessageId: m.id }
  }

  const draft = (): Draft => ({
    id: draftId.current, accountId, to, cc, bcc, subject,
    html: body.current?.innerHTML || '', text: body.current?.innerText || '',
    ...replyMeta(), replacesMessageId: seed.draft?.replacesMessageId, attachments: files,
  })

  // the signature of the chosen account, placed above the quoted text
  const placeSignature = (list: Signature[], accId: string) => {
    const el = body.current
    if (!el) return
    const sigId = accounts.find((a) => a.id === accId)?.signatureId
    const html = sigId ? list.find((s) => s.id === sigId)?.html || '' : ''
    let box = el.querySelector(`[${SIG}]`) as HTMLElement | null
    if (!box && !html) return
    if (!box) {
      box = document.createElement('div')
      box.setAttribute(SIG, '')
      el.insertBefore(box, el.firstChild)
      el.insertBefore(document.createElement('br'), box)
      el.insertBefore(document.createElement('br'), box)
    }
    box.innerHTML = html ? `-- <br>${DOMPurify.sanitize(html)}` : ''
  }

  useEffect(() => {
    if (body.current) body.current.innerHTML = init.body
    window.roarmail.signatures().then((list) => { setSigs(list); if (!init.signed) placeSignature(list, init.accountId) })
    if (!(seed.kind === 'new' && !init.to) && body.current) {
      body.current.focus()
      const r = document.createRange(); r.setStart(body.current, 0); r.collapse(true)
      getSelection()?.removeAllRanges(); getSelection()?.addRange(r)
    }
  }, [])

  // keep a copy while writing, so nothing is lost if the app closes
  useEffect(() => {
    const h = setInterval(() => {
      if (!dirty.current || busy) return
      dirty.current = false
      saving.current = window.roarmail.saveDraft(draft(), false).then((id) => { draftId.current = id })
    }, 3000)
    return () => clearInterval(h)
  })

  async function send(at?: number) {
    if (!to.trim() && !cc.trim() && !bcc.trim()) { setError(t.noRecipient); return }
    setBusy(true); setError('')
    try {
      await saving.current
      const id = await window.roarmail.send(draft(), { at, remindDays: remindDays || undefined })
      onSent(id, at)
    } catch (e: any) {
      setError(String(e?.message || e).replace(/^.*Error:\s*/, ''))
      setBusy(false)
    }
  }

  async function close(choice?: 'save' | 'discard') {
    const changed = dirty.current || !!draftId.current
    if (!choice && changed) { setAsking(true); return }
    await saving.current
    if (choice === 'save') { await window.roarmail.saveDraft(draft(), true); onClose(true); return }
    if (draftId.current) await window.roarmail.discardDraft(draftId.current)
    onClose(false)
  }

  const title = seed.kind === 'new' ? t.compose : seed.kind === 'forward' ? t.forward : seed.kind === 'replyAll' ? t.replyAll
    : seed.kind === 'draft' ? (thread && (thread as Draft).inReplyTo ? t.reply : t.compose) : t.reply

  return (
    <div className="sheet-wrap" onKeyDown={(e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() }
      if (e.key === 'Escape') { e.preventDefault(); asking ? setAsking(false) : close() }
    }}>
      <div className="sheet composer" onInput={() => { dirty.current = true }}>
        <div className="composer-head">
          <b>{title}</b>
          <button className="tool" onClick={() => close()} title={t.discard}><Icon name="close" /></button>
        </div>
        {accounts.length > 1 && (
          <div className="field"><span>{t.from}</span>
            <select value={accountId} onChange={(e) => { setAccountId(e.target.value); placeSignature(sigs, e.target.value); dirty.current = true }}>
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
                <button onClick={() => { setFiles(files.filter((x) => x !== f)); dirty.current = true }}><Icon name="close" size={12} /></button></span>
            ))}
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="composer-foot">
          <button className="tool" title={t.attach} onClick={async () => { const p = await window.roarmail.pickFiles(); if (p.length) { setFiles([...files, ...p]); dirty.current = true } }}><Icon name="clip" /></button>
          <label className={`remind ${remindDays ? 'on' : ''}`} title={t.remind}>
            <Icon name="bell" size={16} />
            <select value={remindDays} onChange={(e) => setRemindDays(Number(e.target.value))}>
              <option value={0}>{t.remindOff}</option>
              {[1, 2, 3, 7].map((d) => <option key={d} value={d}>{t.remind}: {d} {d === 1 ? t.day : t.days}</option>)}
            </select>
          </label>
          <span className="grow" />
          <span className="muted small">⌘/Ctrl + Enter</span>
          <div className="send-group">
            <button className="pill primary" disabled={busy} onClick={() => send()}>{busy ? t.sending : t.send}</button>
            <button className="pill primary later" disabled={busy} title={t.sendLater} onClick={() => setLater(true)}><Icon name="clock" size={15} /></button>
          </div>
        </div>
        {later && <TimePicker title={t.sendLater} onClose={() => setLater(false)} onPick={(at) => { setLater(false); if (at) send(at) }} />}
        {asking && (
          <div className="ask">
            <p>{t.discardQ}</p>
            <div className="row end">
              <button className="pill small ghost" onClick={() => setAsking(false)}>{t.keepWriting}</button>
              <button className="pill small ghost danger" onClick={() => close('discard')}>{t.discard}</button>
              <button className="pill small primary" autoFocus onClick={() => close('save')}>{t.saveDraft}</button>
            </div>
          </div>
        )}
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
