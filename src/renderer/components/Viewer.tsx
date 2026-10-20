// Reading a conversation: every message of it, oldest first; the newest and the unread ones open, the rest
// folded to one line. HTML mail is cleaned (no scripts, forms or frames) and shown in a sandboxed frame;
// images from the web stay hidden until asked for, so senders cannot track opening.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import DOMPurify from 'dompurify'
import type { Account, Address, MessageFull, MessageRow } from '../../shared/api'
import { fullDate, size, t, when } from '../i18n'
import { Icon } from './Icon'

export type ComposeKind = 'reply' | 'replyAll' | 'forward'
type RowAction = 'archive' | 'trash' | 'flag' | 'unflag' | 'unseen' | 'move'

export function Viewer({ row, accounts, onCompose, onAct }: {
  row: MessageRow | null
  accounts: Account[]
  onCompose: (kind: ComposeKind, m: MessageFull) => void
  onAct: (action: RowAction) => void
}) {
  const [items, setItems] = useState<MessageRow[] | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const last = useRef<MessageFull | null>(null)
  const shownKey = useRef<string | null>(null)
  const key = row ? row.threadId || row.id : null

  useEffect(() => {
    setError('')
    if (shownKey.current !== key) last.current = null
    if (!key) { setItems(null); return }
    let live = true
    window.roarmail.thread(key).then((list) => {
      if (!live) return
      const shown = list.length ? list : row ? [row] : []
      setItems(shown)
      const same = shownKey.current === key
      shownKey.current = key
      setOpen((prev) => {
        // a new message in the conversation keeps what was open; another conversation starts fresh
        const next = new Set(same ? prev : [])
        shown.forEach((m, i) => { if (i === shown.length - 1 || !m.seen) next.add(m.id) })
        return next
      })
    }).catch((e) => { if (live) setError(clean(e)) })
    return () => { live = false }
  }, [key, row?.count])

  if (!row) return <section className="viewer empty"><div className="empty-mark"><b>ROAR</b><i>MAIL</i></div><p className="muted">{t.pickMessage}</p></section>
  if (error) return <section className="viewer empty"><p className="error">{error}</p></section>
  if (!items) return <section className="viewer empty"><div className="spinner" /></section>

  const reply = (kind: ComposeKind) => { if (last.current) onCompose(kind, last.current) }

  return (
    <section className="viewer">
      <div className="toolbar">
        <button className="tool" title={`${t.reply} (R)`} onClick={() => reply('reply')}><Icon name="reply" /></button>
        <button className="tool" title={`${t.replyAll} (A)`} onClick={() => reply('replyAll')}><Icon name="replyAll" /></button>
        <button className="tool" title={`${t.forward} (F)`} onClick={() => reply('forward')}><Icon name="forward" /></button>
        <span className="sep" />
        <button className="tool" title={`${t.archiveIt} (E)`} onClick={() => onAct('archive')}><Icon name="archive" /></button>
        <button className="tool" title={`${t.trashIt} (#)`} onClick={() => onAct('trash')}><Icon name="trash" /></button>
        <button className="tool" title={`${t.moveTo} (M)`} onClick={() => onAct('move')}><Icon name="folder" /></button>
        <button className={`tool ${row.flagged ? 'on' : ''}`} title={`${row.flagged ? t.unflag : t.flag} (S)`}
          onClick={() => onAct(row.flagged ? 'unflag' : 'flag')}><Icon name="star" filled={row.flagged} /></button>
        <button className="tool" title={`${t.markUnread} (U)`} onClick={() => onAct('unseen')}><Icon name="unread" /></button>
      </div>

      <div className="read">
        <h2 className="subject">{row.subject || t.noSubject}{items.length > 1 && <span className="muted count-pill">{items.length}</span>}</h2>
        {items.map((m, i) => open.has(m.id)
          ? <MessageCard key={m.id} id={m.id} accounts={accounts} isLast={i === items.length - 1}
              onLoaded={(full) => { if (i === items.length - 1) last.current = full }}
              onFold={items.length > 1 ? () => setOpen((s) => { const n = new Set(s); n.delete(m.id); return n }) : undefined}
              onCompose={onCompose} />
          : (
            <button key={m.id} className="folded" onClick={() => setOpen((s) => new Set(s).add(m.id))}>
              <div className="avatar small-av" style={{ background: tint(m.fromEmail) }}>{initials(m.fromName || m.fromEmail)}</div>
              <b className={m.seen ? '' : 'unread'}>{m.fromName || m.fromEmail}</b>
              <span className="grow ellipsis muted">{m.snippet}</span>
              <span className="muted small">{when(m.date)}</span>
            </button>
          ))}
      </div>
    </section>
  )
}

function MessageCard({ id, accounts, isLast, onLoaded, onFold, onCompose }: {
  id: string; accounts: Account[]; isLast: boolean
  onLoaded: (m: MessageFull) => void; onFold?: () => void; onCompose: (kind: ComposeKind, m: MessageFull) => void
}) {
  const [m, setM] = useState<MessageFull | null>(null)
  const [error, setError] = useState('')
  const [images, setImages] = useState(false)

  useEffect(() => {
    let live = true
    window.roarmail.message(id).then((x) => { if (live) { setM(x); setImages(x.imagesAllowed); onLoaded(x) } }).catch((e) => { if (live) setError(clean(e)) })
    return () => { live = false }
  }, [id])

  if (error) return <article className="card"><p className="error">{error}</p></article>
  if (!m) return <article className="card"><div className="spinner" /></article>

  const acc = accounts.find((a) => a.id === m.accountId)
  const people = (list: Address[]) => list.map((a) => (acc && a.address.toLowerCase() === acc.email.toLowerCase() ? t.me : a.name || a.address)).join(', ')

  return (
    <article className={`card ${isLast ? 'last' : ''}`}>
      <header className="head" onClick={onFold} style={{ cursor: onFold ? 'pointer' : undefined }}>
        <div className="avatar" style={{ background: tint(m.fromEmail) }}>{initials(m.fromName || m.fromEmail)}</div>
        <div className="who">
          <div><b>{m.fromName || m.fromEmail}</b> {m.fromName && <span className="muted">&lt;{m.fromEmail}&gt;</span>}</div>
          <div className="muted small">{t.to}: {people(m.to)}{m.cc.length ? ` · ${t.cc}: ${people(m.cc)}` : ''}</div>
        </div>
        <div className="muted small date">{fullDate(m.date)}{acc && <i className="acc-dot" style={{ background: acc.color }} title={acc.email} />}</div>
        <div className="card-tools" onClick={(e) => e.stopPropagation()}>
          <button className="tool small" title={t.reply} onClick={() => onCompose('reply', m)}><Icon name="reply" size={16} /></button>
          <button className="tool small" title={t.forward} onClick={() => onCompose('forward', m)}><Icon name="forward" size={16} /></button>
        </div>
      </header>

      {m.listUnsubscribe && <Unsubscribe header={m.listUnsubscribe} />}

      <Body m={m} images={images} renderBanner={(blocked) => blocked && !images ? (
        <div className="banner"><Icon name="image" size={16} /> <span>{t.images}</span>
          <button className="pill small" onClick={() => setImages(true)}>{t.showImages}</button>
          <button className="pill small ghost" onClick={() => { window.roarmail.allowImages(m.fromEmail); setImages(true) }}>{t.alwaysImages}</button>
        </div>
      ) : null} />

      {m.attachments.length > 0 && (
        <div className="atts">
          {m.attachments.map((a) => (
            <div className="att" key={a.id}>
              <Icon name="clip" size={16} />
              <button className="att-name" onClick={() => window.roarmail.openAttachment(a.id)} title={t.open}>{a.filename}</button>
              <span className="muted small">{size(a.size)}</span>
              <button className="tool small" title={t.save} onClick={() => window.roarmail.saveAttachment(a.id)}><Icon name="download" size={16} /></button>
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

function Unsubscribe({ header }: { header: string }) {
  const url = (header.match(/<(https?:[^>]+)>/) || header.match(/<(mailto:[^>]+)>/) || [])[1]
  if (!url) return null
  return <button className="link small unsub" onClick={() => window.roarmail.openExternal(url)}>{t.unsubscribe}</button>
}

// the message body in a sandboxed frame: no scripts, links open in the browser, remote images on request
function Body({ m, images, renderBanner }: { m: MessageFull; images: boolean; renderBanner: (blocked: boolean) => ReactNode }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(120)

  const { html, blocked } = useMemo(() => {
    let blocked = false
    const source = m.html || `<pre class="plain">${escapeHtml(m.text || '')}</pre>`
    DOMPurify.removeAllHooks()
    DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
      if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noreferrer') }
      for (const attr of ['src', 'background', 'poster']) {
        const v = node.getAttribute(attr)
        if (v && /^(https?:)?\/\//i.test(v) && !images) { blocked = true; node.setAttribute(`data-blocked-${attr}`, v); node.removeAttribute(attr) }
      }
      const style = node.getAttribute('style')
      if (style && /url\(/i.test(style) && !images) { blocked = true; node.setAttribute('style', style.replace(/url\([^)]*\)/gi, 'none')) }
    })
    const clean = DOMPurify.sanitize(source, {
      WHOLE_DOCUMENT: true, FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base'],
      FORBID_ATTR: ['srcset'], ALLOW_UNKNOWN_PROTOCOLS: false, ADD_DATA_URI_TAGS: ['img'],
    }) as string
    DOMPurify.removeAllHooks()
    const css = `<style>html,body{margin:0;padding:0;background:#fff;color:#1a1a1a;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;word-wrap:break-word;overflow-wrap:anywhere}
      body{padding:18px 22px}img{max-width:100%;height:auto}pre.plain{white-space:pre-wrap;font:inherit;margin:0}a{color:#c00000}
      blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid #ddd;color:#555}table{max-width:100%}</style>`
    return { html: css + clean, blocked }
  }, [m, images])

  useEffect(() => {
    const f = frame.current
    if (!f) return
    const onLoad = () => {
      const doc = f.contentDocument
      if (!doc) return
      const fit = () => setHeight(Math.max(60, doc.documentElement.scrollHeight))
      fit()
      new ResizeObserver(fit).observe(doc.body)
      doc.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit))
      doc.addEventListener('click', (e) => {
        const a = (e.target as Element).closest?.('a')
        if (!a) return
        e.preventDefault()
        const href = a.getAttribute('href') || ''
        if (/^(https?:|mailto:)/i.test(href)) window.roarmail.openExternal(href)
      })
    }
    f.addEventListener('load', onLoad)
    return () => f.removeEventListener('load', onLoad)
  }, [html])

  return (
    <>
      {renderBanner(blocked)}
      <iframe ref={frame} className="body" title="message" sandbox="allow-same-origin" srcDoc={html} style={{ height }} />
    </>
  )
}

const clean = (e: any) => String(e?.message || e).replace(/^.*Error:\s*/, '')
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

export function initials(s: string) {
  const p = s.replace(/[<>"]/g, '').split(/[\s@.]+/).filter(Boolean)
  return ((p[0]?.[0] || '?') + (p[1]?.[0] || '')).toUpperCase()
}

export function tint(s: string) {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return `hsl(${h} 45% 38%)`
}
