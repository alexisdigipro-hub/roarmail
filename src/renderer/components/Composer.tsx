// Writing a message: new, reply, reply all, forward, or a draft picked up again. Saved as a draft while
// writing; closing offers to keep it in Drafts. Cmd/Ctrl+Enter sends, Esc closes.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import DOMPurify from 'dompurify'
import type { Account, Address, Draft, MessageFull, RoarTransferFile, RoarTransferLink, Signature } from '../../shared/api'
import { fullDate, size, t } from '../i18n'
import { Icon } from './Icon'
import { clean as roarError, useRoarMe } from './RoarMe'
import type { ComposeKind } from './Viewer'
import { TimePicker } from './TimePicker'
import { FONTS } from '../look'

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

// the size of the writing window: dragged at its corner, kept for next time (Alex, 21 Oct 2026)
const SIZE_KEY = 'roarmail.composer'
const SIZE_DEF = { w: 820, h: 720 }
const fit = (v: { w: number; h: number }) => ({ w: Math.round(Math.max(560, Math.min(innerWidth - 24, v.w))), h: Math.round(Math.max(420, Math.min(innerHeight - 24, v.h))) })
const savedSize = () => { try { const v = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null'); return v?.w ? fit(v) : fit(SIZE_DEF) } catch { return fit(SIZE_DEF) } }

// Apple Mail's format bar: paragraph styles, sizes (the editor's 1 to 7) and quick colours
const BLOCKS: [string, string][] = [['p', 'fm_body'], ['h1', 'fm_title'], ['h2', 'fm_heading'], ['h3', 'fm_subheading'], ['blockquote', 'fm_quote'], ['pre', 'fm_mono']]
const SIZES: [string, string][] = [['1', '10'], ['2', '13'], ['3', '16'], ['4', '18'], ['5', '24'], ['6', '32'], ['7', '48']]
// attachments over this go as a RoarTransfer link by default (most mail servers refuse 20-25 MB); any file can
const LINK_AT = 20 * 1024 * 1024

/** the card a RoarTransfer link becomes in the email: one link for all its files (22 Oct 2026, as roartransfer.com),
 * plain inline styles and a table, so every mail program shows it */
function transferCard(l: RoarTransferLink) {
  const until = new Date(l.expires).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  const font = 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif'
  const files = l.files?.length ? l.files : [{ name: l.name, size: l.size }]
  const rows = files.slice(0, 8).map((f) => `<div style="font-size:13.5px;color:#30343b;margin:2px 0">📎 ${esc(f.name)} <span style="color:#8a8f98">· ${size(f.size)}</span></div>`).join('')
    + (files.length > 8 ? `<div style="font-size:12.5px;color:#8a8f98">+ ${files.length - 8}</div>` : '')
  return `<table data-roarmail-transfer cellpadding="0" cellspacing="0" border="0" style="margin:12px 0;border:1px solid #d9dce1;border-radius:12px;border-collapse:separate"><tr><td style="padding:14px 16px;${font}">`
    + `<div style="font-size:11px;letter-spacing:.08em;color:#8a8f98">ROARTRANSFER · ${files.length} · ${size(l.size)}</div>`
    + `<div style="margin:8px 0">${rows}</div>`
    + `<a href="${esc(l.url)}" style="display:inline-block;padding:9px 18px;border-radius:999px;background:#d40000;color:#fff;font-size:14px;font-weight:600;text-decoration:none">⬇ ${esc(t.rt_download)}</a>`
    + `<div style="font-size:12.5px;color:#6b7079;margin-top:8px">${l.locked ? `🔒 ${esc(t.rt_locked)} · ` : ''}${esc(t.rt_until)} ${esc(until)}</div>`
    + `<div style="font-size:11.5px;color:#8a8f98;margin-top:2px">${esc(l.url)}</div></td></tr></table>`
}

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
  // an alias (Settings > Accounts): the draft's, or the one a replied-to message was sent to
  const [identityId, setIdentityId] = useState<string>(() => {
    if (seed.draft?.identityId) return seed.draft.identityId
    const got = [...(seed.source?.to || []), ...(seed.source?.cc || [])].map((x) => x.address.toLowerCase())
    return accounts.find((a) => a.id === init.accountId)?.aliases.find((x) => got.includes(x.email.toLowerCase()))?.id || ''
  })
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
  const [priority, setPriority] = useState<Draft['priority']>(seed.draft?.priority || 'normal')
  const [sigId, setSigId] = useState<string>(() => accounts.find((a) => a.id === init.accountId)?.signatureId || '')
  const [box, setBox] = useState(savedSize)
  // the format bar shows unless it was hidden with the Aa button (29 Oct 2026: on by default, with every text tool)
  const [fmtBar, setFmtBar] = useState(() => { try { return localStorage.getItem('roarmail.fmtbar') !== '0' } catch { return true } })
  const [linkAsk, setLinkAsk] = useState<string | null>(null)
  const [states, setStates] = useState<Record<string, boolean>>({})
  // files sent up with the RoarTransfer button; each becomes a link card in the message
  const [rt, setRt] = useState<string[]>([])
  const range = useRef<Range | null>(null)
  const [roar] = useRoarMe()
  const roarReady = !!roar?.signedIn && !roar.needsMfa
  const [sizes, setSizes] = useState<Record<string, number>>({})
  const [asLink, setAsLink] = useState<Record<string, boolean>>({})
  // RoarTransfer as on roartransfer.com (22 Oct 2026): 1 day up to 5 GB or 3 days up to 3 GB, a password, an email when downloaded
  const [rtDays, setRtDays] = useState(3)
  const [rtPw, setRtPw] = useState('')
  const [rtNotify, setRtNotify] = useState(true)
  const rtMax = (rtDays === 1 ? 5 : 3) * 1024 ** 3
  const [up, setUp] = useState<Record<string, number>>({})
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
    id: draftId.current, accountId, identityId: identityId || undefined, to, cc, bcc, subject,
    html: body.current?.innerHTML || '', text: body.current?.innerText || '',
    ...replyMeta(), replacesMessageId: seed.draft?.replacesMessageId, attachments: files,
    priority: priority === 'normal' ? undefined : priority,
  })

  // the signature of the chosen account, placed above the quoted text
  const placeSignature = (list: Signature[], accId: string, pick?: string) => {
    const el = body.current
    if (!el) return
    const sid = pick ?? accounts.find((a) => a.id === accId)?.signatureId
    const html = sid ? list.find((s) => s.id === sid)?.html || '' : ''
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

  // the size of each attachment; a big one is marked to go as a RoarTransfer link
  useEffect(() => {
    const unknown = files.filter((f) => !(f in sizes))
    if (!unknown.length) return
    window.roarmail.fileSizes(unknown).then((n) => {
      setSizes((s) => ({ ...s, ...Object.fromEntries(unknown.map((f, i) => [f, n[i]])) }))
      setAsLink((a) => ({ ...Object.fromEntries(unknown.map((f, i) => [f, n[i] > LINK_AT])), ...a }))
    }).catch(() => {})
  }, [files])
  useEffect(() => window.roarmail.on((e) => { if (e.type === 'transfer') setUp((u) => (e.file in u ? { ...u, [e.file]: e.progress } : u)) }), [])

  /** files up to RoarTransfer one by one, then ONE link for all of them, which becomes a card in the email */
  async function upload(list: string[], onEach?: (f: string) => void) {
    const done: RoarTransferFile[] = []
    for (const f of list) {
      setUp((u) => ({ ...u, [f]: 0 }))
      try { done.push(await window.roarmail.roarmeTransfer(f, rtDays)); onEach?.(f) } finally { setUp((u) => { const rest = { ...u }; delete rest[f]; return rest }) }
    }
    if (done.length) {
      placeCard(transferCard(await window.roarmail.roarmeTransferBundle(done, { title: subject.trim(), password: rtPw, notify: rtNotify })))
      dirty.current = true
    }
  }
  /** the files marked as links go up first and leave the attachments */
  async function sendLinks(): Promise<string[]> {
    const list = files.filter((x) => roarReady && asLink[x])
    if (list.some((f) => sizes[f] > rtMax)) throw new Error('roarme-too-big')
    let left = files
    await upload(list, (f) => { left = left.filter((x) => x !== f); setFiles(left) })
    return left
  }
  // above the signature, else above the quoted mail, else at the end
  const placeCard = (html: string) => {
    const el = body.current
    if (!el) return
    const box = document.createElement('div')
    box.innerHTML = html
    const quote = el.querySelector('blockquote')
    const at = el.querySelector(`[${SIG}]`) || (quote ? quote.previousElementSibling || quote : null)
      || [...el.querySelectorAll('p')].find((p) => p.textContent?.startsWith('----------'))
    const node = box.firstElementChild!
    if (at && at.parentNode) at.parentNode.insertBefore(node, at)
    else el.appendChild(node)
  }

  // keep a copy while writing, so nothing is lost if the app closes
  useEffect(() => {
    const h = setInterval(() => {
      if (!dirty.current || busy) return
      dirty.current = false
      saving.current = window.roarmail.saveDraft(draft(), false).then((id) => { draftId.current = id })
    }, 3000)
    return () => clearInterval(h)
  })

  // the editor keeps its selection while a select or colour box of the format bar has the focus
  useEffect(() => {
    const keep = () => {
      const sel = getSelection()
      if (sel && sel.rangeCount && body.current?.contains(sel.anchorNode)) range.current = sel.getRangeAt(0).cloneRange()
    }
    // which of bold, italic… the text under the cursor has, so their buttons light up
    const lit = () => {
      const sel = getSelection()
      if (!sel || !body.current?.contains(sel.anchorNode)) return
      const next: Record<string, boolean> = {}
      for (const c of ['bold', 'italic', 'underline', 'strikeThrough', 'superscript', 'subscript', 'insertUnorderedList', 'insertOrderedList',
        'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull']) next[c] = document.queryCommandState(c)
      setStates((s) => (Object.keys(next).some((k) => s[k] !== next[k]) ? next : s))
    }
    document.addEventListener('selectionchange', keep)
    document.addEventListener('selectionchange', lit)
    return () => { document.removeEventListener('selectionchange', keep); document.removeEventListener('selectionchange', lit) }
  }, [])
  const exec = (cmd: string, value?: string) => {
    const el = body.current
    if (!el) return
    el.focus()
    if (range.current) { const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(range.current) }
    document.execCommand('styleWithCSS', false, 'true')
    document.execCommand(cmd, false, value)
    dirty.current = true
  }
  // a format button that lights up while the text under the cursor has that format
  const fb = (c: string, title: string, children: ReactNode) => (
    <button className={`fmt ${states[c] ? 'on' : ''}`} title={title} onClick={() => exec(c)}>{children}</button>
  )
  const toggleFmt = () => setFmtBar((v) => { try { localStorage.setItem('roarmail.fmtbar', v ? '0' : '1') } catch { /* this run only */ } return !v })

  // the corner handle: the window stays centred, so it grows twice as fast as the pointer moves
  const resize = (e: RPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const h = e.currentTarget, x0 = e.clientX, y0 = e.clientY, b0 = box
    h.setPointerCapture(e.pointerId)
    let last = b0
    const move = (ev: PointerEvent) => { last = fit({ w: b0.w + (ev.clientX - x0) * 2, h: b0.h + (ev.clientY - y0) * 2 }); setBox(last) }
    const up = () => {
      h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up)
      try { localStorage.setItem(SIZE_KEY, JSON.stringify(last)) } catch { /* this run only */ }
    }
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up)
  }
  // double-click on the handle: as big as the window, or back to the usual size
  const toggleBig = () => {
    const big = fit({ w: innerWidth, h: innerHeight })
    const next = box.w >= big.w - 4 && box.h >= big.h - 4 ? fit(SIZE_DEF) : big
    setBox(next)
    try { localStorage.setItem(SIZE_KEY, JSON.stringify(next)) } catch { /* this run only */ }
  }

  // the RoarTransfer button (as in RoarMe): files go up at once and one link for them lands in the message
  async function transferNow() {
    if (!roarReady) { setError(t.rt_needSignIn); return }
    const picked = await window.roarmail.pickFiles()
    if (!picked.length) return
    setError('')
    setRt((r) => [...r, ...picked])
    try { await upload(picked) } catch (e: any) {
      if (!/cancel/i.test(String(e?.message || e))) setError(roarError(e))
    } finally { setRt((r) => r.filter((x) => !picked.includes(x))) }
  }

  async function send(at?: number) {
    if (!to.trim() && !cc.trim() && !bcc.trim()) { setError(t.noRecipient); return }
    if (rt.length) { setError(t.rt_wait); return }
    setBusy(true); setError('')
    try {
      await saving.current
      const left = await sendLinks()
      const id = await window.roarmail.send({ ...draft(), attachments: left }, { at, remindDays: remindDays || undefined })
      onSent(id, at)
    } catch (e: any) {
      setError(roarError(e))
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
      <div className="sheet composer" style={{ width: box.w, height: box.h }} onInput={() => { dirty.current = true }}>
        <div className="composer-head">
          <b>{title}</b>
          <span className="grow" />
          <div className="composer-tools">
            <button className={`tool ${fmtBar ? 'on-filter' : ''}`} title={t.fm_bar} onClick={toggleFmt}><Icon name="aa" /></button>
            <button className="tool" title={t.emoji} onMouseDown={(e) => e.preventDefault()} onClick={() => { body.current?.focus(); window.roarmail.emojiPanel() }}><Icon name="emoji" /></button>
            <span className="sep" />
            <button className="tool" title={t.attach} onClick={async () => { const p = await window.roarmail.pickFiles(); if (p.length) { setFiles([...files, ...p]); dirty.current = true } }}><Icon name="clip" /></button>
            <button className="tool rt-btn" title={t.rt_button} onClick={transferNow}><Icon name="roarUp" /></button>
          </div>
          <span className="sep" />
          <button className="tool" onClick={() => close()} title={t.discard}><Icon name="close" /></button>
        </div>
        {(accounts.length > 1 || accounts.some((a) => a.aliases.length) || sigs.length > 0) && (
          <div className="field"><span>{t.from}</span>
            <select value={`${accountId}|${identityId}`} onChange={(e) => {
              const [a, i] = e.target.value.split('|')
              if (a !== accountId) { placeSignature(sigs, a); setSigId(accounts.find((x) => x.id === a)?.signatureId || '') }
              setAccountId(a); setIdentityId(i || ''); dirty.current = true
            }}>
              {accounts.flatMap((a) => [
                <option key={a.id} value={`${a.id}|`}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>,
                ...a.aliases.map((x) => <option key={x.id} value={`${a.id}|${x.id}`}>{(x.name || a.displayName) ? `${x.name || a.displayName} <${x.email}>` : x.email}</option>),
              ])}
            </select>
            {sigs.length > 0 && (
              <label className="sig-pick" title={t.signature}>
                <span className="muted small">{t.signature}</span>
                <select value={sigId} onChange={(e) => { setSigId(e.target.value); placeSignature(sigs, accountId, e.target.value); dirty.current = true }}>
                  <option value="">{t.noSignature}</option>
                  {sigs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </label>
            )}
          </div>
        )}
        <Recipients label={t.to} value={to} onChange={setTo} autoFocus={seed.kind === 'new' && !init.to}
          extra={!showCc && <button className="link small" onClick={() => setShowCc(true)}>{t.cc} / {t.bcc}</button>} />
        {showCc && <Recipients label={t.cc} value={cc} onChange={setCc} />}
        {showCc && <Recipients label={t.bcc} value={bcc} onChange={setBcc} />}
        <div className="field"><span>{t.subject}</span><input value={subject} onChange={(e) => setSubject(e.target.value)} />
          <select className={`priority ${priority}`} title={t.rm_priority} value={priority} onChange={(e) => { setPriority(e.target.value as Draft['priority']); dirty.current = true }}>
            <option value="normal">{t.pr_normal}</option><option value="high">! {t.pr_high}</option><option value="low">↓ {t.pr_low}</option>
          </select>
        </div>
        {fmtBar && (
          <div className="fmt-bar" onMouseDown={(e) => { if ((e.target as HTMLElement).tagName === 'BUTTON' || (e.target as HTMLElement).closest('button')) e.preventDefault() }}>
            <select title={t.fm_style} defaultValue="" onChange={(e) => { exec('formatBlock', e.target.value); e.target.value = '' }}>
              <option value="" disabled>{t.fm_style}</option>
              {BLOCKS.map(([k, label]) => <option key={k} value={k}>{t[label as keyof typeof t] as string}</option>)}
            </select>
            <select title={t.font} defaultValue="" onChange={(e) => { exec('fontName', e.target.value); e.target.value = '' }}>
              <option value="" disabled>{t.font}</option>
              {FONTS.map(([k, label, fam]) => <option key={k} value={fam} style={{ fontFamily: fam }}>{label}</option>)}
            </select>
            <select className="narrow" title={t.fm_size} defaultValue="" onChange={(e) => { exec('fontSize', e.target.value); e.target.value = '' }}>
              <option value="" disabled>{t.fm_size}</option>
              {SIZES.map(([k, px]) => <option key={k} value={k}>{px}</option>)}
            </select>
            <label className="swatch-pick" title={t.fm_color}><input type="color" defaultValue="#d40000" onChange={(e) => exec('foreColor', e.target.value)} /></label>
            <label className="swatch-pick marker" title={t.fm_highlight}><Icon name="marker" size={13} /><input type="color" defaultValue="#fff59d" onChange={(e) => exec('hiliteColor', e.target.value)} /></label>
            <button className="fmt" title={t.fm_clear} onClick={() => exec('removeFormat')}><Icon name="clearFmt" size={15} /></button>
            <span className="sep" />
            {fb('bold', t.fm_bold, <b>B</b>)}
            {fb('italic', t.fm_italic, <i>I</i>)}
            {fb('underline', t.fm_underline, <u>U</u>)}
            {fb('strikeThrough', t.fm_strike, <s>S</s>)}
            {fb('superscript', t.fm_sup, <span>x<sup>2</sup></span>)}
            {fb('subscript', t.fm_sub, <span>x<sub>2</sub></span>)}
            <span className="sep" />
            {fb('justifyLeft', t.fm_left, <Icon name="alignL" size={15} />)}
            {fb('justifyCenter', t.fm_center, <Icon name="alignC" size={15} />)}
            {fb('justifyRight', t.fm_right, <Icon name="alignR" size={15} />)}
            {fb('justifyFull', t.fm_justify, <Icon name="alignJ" size={15} />)}
            <span className="sep" />
            {fb('insertUnorderedList', t.fm_bullets, <Icon name="listUl" size={15} />)}
            {fb('insertOrderedList', t.fm_numbers, <Icon name="listOl" size={15} />)}
            <button className="fmt" title={t.fm_outdent} onClick={() => exec('outdent')}><Icon name="outdent" size={15} /></button>
            <button className="fmt" title={t.fm_indent} onClick={() => exec('indent')}><Icon name="indent" size={15} /></button>
            <span className="sep" />
            <button className="fmt" title={t.fm_quote} onClick={() => exec('formatBlock', 'blockquote')}><Icon name="quote" size={15} /></button>
            <button className={`fmt ${linkAsk != null ? 'on' : ''}`} title={t.fm_link} onClick={() => setLinkAsk((v) => (v == null ? '' : null))}><Icon name="link" size={15} /></button>
            <button className="fmt" title={t.fm_unlink} onClick={() => exec('unlink')}><Icon name="unlink" size={15} /></button>
            <button className="fmt" title={t.fm_rule} onClick={() => exec('insertHorizontalRule')}><Icon name="rule" size={15} /></button>
            <span className="sep" />
            <button className="fmt" title={t.fm_undo} onClick={() => exec('undo')}><Icon name="undo" size={15} /></button>
            <button className="fmt" title={t.fm_redo} onClick={() => exec('redo')}><Icon name="redo" size={15} /></button>
            {linkAsk != null && (
              <form className="link-ask" onSubmit={(e) => {
                e.preventDefault()
                const url = linkAsk.trim()
                if (url) exec('createLink', /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`)
                setLinkAsk(null)
              }}>
                <input autoFocus value={linkAsk} placeholder={t.fm_linkPh} onChange={(e) => setLinkAsk(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setLinkAsk(null) } }} />
                <button className="pill small primary">OK</button>
              </form>
            )}
          </div>
        )}
        <div className="editor" ref={body} contentEditable suppressContentEditableWarning spellCheck />
        {files.length > 0 && (
          <div className="files">
            {files.map((f) => {
              const link = roarReady && asLink[f]
              const p = up[f]
              return (
                <span className={`chip ${link ? 'as-link' : ''}`} key={f}>
                  <Icon name={link ? 'roar' : 'clip'} size={14} /> {f.split(/[\\/]/).pop()}
                  {sizes[f] > 0 && <span className="muted">{size(sizes[f])}</span>}
                  {p != null && <span className="muted">{t.rt_up} {Math.round(p * 100)}%</span>}
                  {roarReady && p == null && (
                    <button className={`link-toggle ${link ? 'on' : ''}`} title={link ? t.rt_asLink : t.rt_attached}
                      onClick={() => { setAsLink({ ...asLink, [f]: !link }) }}>{link ? t.rt_asLink : t.rt_attached}</button>
                  )}
                  <button onClick={() => {
                    if (p != null) { window.roarmail.roarmeCancelTransfer(f); return }
                    setFiles(files.filter((x) => x !== f)); dirty.current = true
                  }}><Icon name="close" size={12} /></button></span>
              )
            })}
          </div>
        )}
        {rt.length > 0 && (
          <div className="files">
            {rt.map((f) => (
              <span className="chip as-link" key={f}>
                <Icon name="roar" size={14} /> {f.split(/[\\/]/).pop()}
                <span className="muted">{t.rt_up} {Math.round((up[f] || 0) * 100)}%</span>
                <button title={t.cancel} onClick={() => window.roarmail.roarmeCancelTransfer(f)}><Icon name="close" size={12} /></button>
              </span>
            ))}
          </div>
        )}
        {roarReady && (files.some((f) => asLink[f]) || rt.length > 0) && (
          <div className="rt-opts">
            <span className="rt-plans">
              {[1, 3].map((d) => <button key={d} className={rtDays === d ? 'on' : ''} disabled={rt.length > 0} onClick={() => setRtDays(d)}>{d === 1 ? t.rt_day1 : t.rt_days3}</button>)}
            </span>
            <input type="password" autoComplete="new-password" placeholder={t.rt_pw} value={rtPw} disabled={rt.length > 0} onChange={(e) => setRtPw(e.target.value.slice(0, 100))} />
            <label><input type="checkbox" checked={rtNotify} disabled={rt.length > 0} onChange={(e) => setRtNotify(e.target.checked)} /> {t.rt_notify}</label>
          </div>
        )}
        {!roarReady && roar && files.some((f) => sizes[f] > LINK_AT) && <p className="muted small hint-big">{t.rt_big}</p>}
        {error && <p className="error">{error}</p>}
        <div className="composer-foot">
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
        <div className="composer-resize" title={t.resizeWin} onPointerDown={resize} onDoubleClick={toggleBig} />
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
