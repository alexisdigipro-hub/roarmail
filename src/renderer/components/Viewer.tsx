// Reading a conversation: every message of it, oldest first; the newest and the unread ones open, the rest
// folded to one line. HTML mail is cleaned (no scripts, forms or frames) and shown in a sandboxed frame;
// images from the web stay hidden until asked for, so senders cannot track opening.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import DOMPurify from 'dompurify'
import type { Account, Address, MessageFull, MessageRow, Settings } from '../../shared/api'
import { checkLink, isTracker, stripTracking, type LinkWarning } from '../privacy'
import { FONTS, TEXT_SIZES, fontStack } from '../look'
import { fullDate, size, t, when, type Key } from '../i18n'
import { Icon } from './Icon'
import { useSenderIcons } from '../senders'

export type ComposeKind = 'reply' | 'replyAll' | 'forward'
type RowAction = 'archive' | 'trash' | 'flag' | 'unflag' | 'unseen' | 'move' | 'snooze'
export type RoarAction = 'share' | 'task'

export function Viewer({ row, accounts, prefs, onCompose, onAct, onRoar }: {
  row: MessageRow | null
  accounts: Account[]
  prefs: Settings
  onCompose: (kind: ComposeKind, m: MessageFull) => void
  onAct: (action: RowAction) => void
  onRoar: (action: RoarAction, m: MessageFull) => void
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
        <button className="tool" title={`${t.snoozeIt} (B)`} onClick={() => onAct('snooze')}><Icon name="clock" /></button>
        <button className={`tool ${row.flagged ? 'on' : ''}`} title={`${row.flagged ? t.unflag : t.flag} (S)`}
          onClick={() => onAct(row.flagged ? 'unflag' : 'flag')}><Icon name="star" filled={row.flagged} /></button>
        <button className="tool" title={`${t.markUnread} (U)`} onClick={() => onAct('unseen')}><Icon name="unread" /></button>
        <span className="sep" />
        <button className="tool roar" title={t.rm_share} onClick={() => last.current && onRoar('share', last.current)}><Icon name="roar" /></button>
        <button className="tool" title={t.rm_task} onClick={() => last.current && onRoar('task', last.current)}><Icon name="tasks" /></button>
      </div>

      <div className="read">
        <h2 className="subject">{row.subject || t.noSubject}{items.length > 1 && <span className="muted count-pill">{items.length}</span>}</h2>
        {items.map((m, i) => open.has(m.id)
          ? <MessageCard key={m.id} id={m.id} accounts={accounts} prefs={prefs} isLast={i === items.length - 1}
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

function MessageCard({ id, accounts, prefs, isLast, onLoaded, onFold, onCompose }: {
  id: string; accounts: Account[]; prefs: Settings; isLast: boolean
  onLoaded: (m: MessageFull) => void; onFold?: () => void; onCompose: (kind: ComposeKind, m: MessageFull) => void
}) {
  const [m, setM] = useState<MessageFull | null>(null)
  const [error, setError] = useState('')
  const [images, setImages] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [note, setNote] = useState('')
  const senderPic = useSenderIcons(m ? [m.fromEmail] : [], prefs.senderPictures)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    window.roarmail.message(id).then((x) => {
      if (!live) return
      setM(x); setImages(x.imagesAllowed); setBlocked(x.senderBlocked); onLoaded(x)
      // Settings > General > Mark as read: after a few seconds open (on opening is done by the engine; never = by hand)
      if (!x.seen && prefs.markRead === 'delay') timer = setTimeout(() => { if (live) window.roarmail.act([x.id], 'seen') }, 2500)
    }).catch((e) => { if (live) setError(clean(e)) })
    return () => { live = false; clearTimeout(timer) }
  }, [id])

  if (error) return <article className="card"><p className="error">{error}</p></article>
  if (!m) return <article className="card"><div className="spinner" /></article>

  const acc = accounts.find((a) => a.id === m.accountId)
  const people = (list: Address[]) => list.map((a) => (acc && a.address.toLowerCase() === acc.email.toLowerCase() ? t.me : a.name || a.address)).join(', ')

  return (
    <article className={`card ${isLast ? 'last' : ''}`}>
      <header className="head" onClick={onFold} style={{ cursor: onFold ? 'pointer' : undefined }}>
        {(() => { const pic = accounts.find((a) => a.email.toLowerCase() === m.fromEmail)?.avatar || senderPic(m.fromEmail); return (
          <div className={`avatar ${pic ? 'pic' : ''}`} style={{ background: pic ? '#fff' : tint(m.fromEmail) }}>{pic ? <img src={pic} alt="" /> : initials(m.fromName || m.fromEmail)}</div>) })()}
        <div className="who">
          <div><b>{m.fromName || m.fromEmail}</b> {m.fromName && <span className="muted">&lt;{m.fromEmail}&gt;</span>}</div>
          <div className="muted small">{t.to}: {people(m.to)}{m.cc.length ? ` · ${t.cc}: ${people(m.cc)}` : ''}</div>
        </div>
        <div className="muted small date">{fullDate(m.date)}{acc && <i className="acc-dot" style={{ background: acc.color }} title={acc.email} />}</div>
        <div className="card-tools" onClick={(e) => e.stopPropagation()}>
          <button className="tool small" title={t.reply} onClick={() => onCompose('reply', m)}><Icon name="reply" size={16} /></button>
          <button className="tool small" title={t.forward} onClick={() => onCompose('forward', m)}><Icon name="forward" size={16} /></button>
          <button className={`tool small ${blocked ? 'on-danger' : ''}`} title={blocked ? t.unblockSender : t.blockSender}
            onClick={() => {
              if (!blocked && !confirm(`${t.blockQ}\n\n${m.fromEmail}`)) return
              window.roarmail.blockSender(m.fromEmail, !blocked); setBlocked(!blocked); setNote(blocked ? '' : t.blockedNote)
            }}><Icon name="block" size={16} /></button>
        </div>
      </header>

      <SecurityBanner m={m} />
      {(m.listUnsubscribe || note) && (
        <div className="row unsub-row">
          {m.listUnsubscribe && <button className="link small" onClick={async () => {
            if (!confirm(`${t.unsubscribeQ}\n\n${m.fromName || m.fromEmail}`)) return
            const r = await window.roarmail.unsubscribe(m.id).catch(() => 'none' as const)
            setNote(r === 'done' ? t.unsubDone : r === 'sent' ? t.unsubSent : r === 'opened' ? t.unsubOpened : t.unsubNone)
          }}>{m.oneClickUnsubscribe ? t.unsubscribeOne : t.unsubscribe}</button>}
          {note && <span className="muted small">{note}</span>}
        </div>
      )}

      <Body m={m} images={images && !prefs.privacyMode} prefs={prefs} renderBanner={(blocked) => blocked && prefs.privacyMode ? (
        <div className="banner"><Icon name="shield" size={16} /> <span>{t.privacyModeOn}</span></div>
      ) : blocked && !images ? (
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
              <button className="att-name" onClick={() => window.roarmail.openAttachment(a.id)} title={window.roarmail.platform === 'darwin' ? t.preview : t.open}>{a.filename}</button>
              <span className="muted small">{size(a.size)}</span>
              <button className="tool small" title={t.save} onClick={() => window.roarmail.saveAttachment(a.id).then((p) => {
                if (p && prefs.downloadsFolder) window.dispatchEvent(new CustomEvent('roarmail-toast', { detail: `${t.savedTo} ${p.split(/[\\/]/).slice(-2, -1)[0] || ''}` }))
              })}><Icon name="download" size={16} /></button>
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

function SecurityBanner({ m }: { m: MessageFull }) {
  const w = m.security.warnings
  if (!w.length) return null
  const strong = w.includes('auth') || w.includes('nameSpoof')
  return (
    <div className={`banner ${strong ? 'danger-banner' : ''}`}>
      <Icon name={strong ? 'shieldAlert' : 'info'} size={16} />
      <span>
        {w.includes('auth') && <>{t.sec_auth} </>}
        {w.includes('nameSpoof') && <>{t.sec_name} </>}
        {w.includes('replyTo') && <>{t.sec_reply} <b>{m.security.replyTo}</b></>}
      </span>
    </div>
  )
}

// the message body in a sandboxed frame: no scripts, links open in the browser, remote images on request
function Body({ m, images, prefs, renderBanner }: { m: MessageFull; images: boolean; prefs: Settings; renderBanner: (blocked: boolean) => ReactNode }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(120)
  const [hover, setHover] = useState('')
  const [sheet, setSheet] = useState<{ url: string; host: string; warnings: LinkWarning[] } | null>(null)

  const { html, blocked, trackers } = useMemo(() => {
    let blocked = false
    let trackers = 0
    // plain text: lines quoted with > get their level, for the quote colours
    const plain = (m.text || '').split('\n').map((line) => {
      const lvl = Math.min(3, (line.match(/^(\s*>)+/)?.[0].match(/>/g) || []).length)
      const html = prefs.detectLinks ? linkify(line) : escapeHtml(line)
      return lvl ? `<span class="q${lvl}">${html}</span>` : html
    }).join('\n')
    const source = m.html || `<pre class="plain">${plain}</pre>`
    DOMPurify.removeAllHooks()
    DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
      if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noreferrer') }
      // tracking pixels never load, not even with images shown
      if (node.tagName === 'IMG' && prefs.blockTrackers && isTracker(node)) {
        trackers++
        node.removeAttribute('src'); node.setAttribute('width', '0'); node.setAttribute('height', '0'); node.setAttribute('style', 'display:none')
        return
      }
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
    // Settings > Fonts & colours: the message font (mail without its own), fixed width for plain text, quotes by level
    const font = fontStack(prefs.messageFont, FONTS[0][2])
    const mono = fontStack(prefs.monoFont, FONTS.find(([k]) => k === 'mono')![2])
    const q = prefs.quoteColors ? [prefs.quote1, prefs.quote2, prefs.quote3].map((c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#999')) : null
    const quotes = q
      ? `blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid ${q[0]};color:${q[0]}}blockquote blockquote{border-left-color:${q[1]};color:${q[1]}}
        blockquote blockquote blockquote{border-left-color:${q[2]};color:${q[2]}}.q1{color:${q[0]}}.q2{color:${q[1]}}.q3{color:${q[2]}}`
      : 'blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid #ddd;color:#555}'
    const css = `<style>html,body{margin:0;padding:0;background:#fff;color:#1a1a1a;font:${TEXT_SIZES[prefs.textSize] ?? 15.5}px/1.55 ${font};word-wrap:break-word;overflow-wrap:anywhere}
      body{padding:18px 22px}img{max-width:100%;height:auto}pre.plain{white-space:pre-wrap;font:inherit;margin:0}a{color:#c00000}
      ${prefs.plainMono ? `pre.plain{font-family:${mono};font-size:.92em}` : ''}${quotes}table{max-width:100%}</style>`
    return { html: css + clean, blocked, trackers }
  }, [m, images, prefs.detectLinks, prefs.blockTrackers, prefs.textSize, prefs.messageFont, prefs.monoFont, prefs.plainMono, prefs.quoteColors, prefs.quote1, prefs.quote2, prefs.quote3])

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
      // hovering a link shows where it really goes; a link that looks wrong asks first
      doc.addEventListener('mouseover', (e) => {
        const a = (e.target as Element).closest?.('a')
        setHover(a ? (prefs.stripTracking ? stripTracking(a.getAttribute('href') || '') : a.getAttribute('href') || '') : '')
      })
      doc.addEventListener('mouseleave', () => setHover(''))
      doc.addEventListener('click', (e) => {
        const a = (e.target as Element).closest?.('a')
        if (!a) return
        e.preventDefault()
        let href = a.getAttribute('href') || ''
        if (/^tel:/i.test(href)) { window.roarmail.openExternal(href); return }
        if (!/^(https?:|mailto:)/i.test(href)) return
        if (prefs.stripTracking) href = stripTracking(href)
        const check = checkLink(href, a.textContent || '')
        if (check.warnings.some((w) => w !== 'insecure')) setSheet(check)
        else window.roarmail.openExternal(href)
      })
    }
    f.addEventListener('load', onLoad)
    return () => f.removeEventListener('load', onLoad)
  }, [html, prefs.stripTracking])

  return (
    <>
      {renderBanner(blocked)}
      {trackers > 0 && <div className="shield"><Icon name="shield" size={14} /> {trackers === 1 ? t.tracker1 : `${trackers} ${t.trackersN}`}</div>}
      <div className="body-wrap">
        <iframe ref={frame} className="body" title="message" sandbox="allow-same-origin" srcDoc={html} style={{ height }} />
        {hover && <div className="hover-url">{hover}</div>}
      </div>
      {sheet && (
        <div className="sheet-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) setSheet(null) }}>
          <div className="sheet link-sheet">
            <div className="row"><Icon name="shieldAlert" size={20} /><h3 className="grow">{t.linkCheck}</h3></div>
            <p className="muted small">{t.linkGoesTo}</p>
            <p className="link-host">{sheet.host}</p>
            <p className="link-url">{sheet.url}</p>
            <ul className="warn-list">{sheet.warnings.map((w) => <li key={w}>{t[`lw_${w}` as Key]}</li>)}</ul>
            <div className="row end">
              <button className="pill ghost" onClick={() => { navigator.clipboard.writeText(sheet.url); setSheet(null) }}>{t.copyLink}</button>
              <button className="pill ghost danger" onClick={() => { window.roarmail.openExternal(sheet.url); setSheet(null) }}>{t.openAnyway}</button>
              <button className="pill primary" autoFocus onClick={() => setSheet(null)}>{t.cancel}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const clean = (e: any) => String(e?.message || e).replace(/^.*Error:\s*/, '')
// Settings > Advanced > Detect in messages: web links, email addresses and phone numbers in plain text
const DETECT = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]|www\.[^\s<>"]+[^\s<>".,;:!?)\]]|[\w.+-]+@[\w-]+\.[\w.-]*[a-z]{2,}|\+?\d[\d ()-]{7,}\d)/gi
function linkify(line: string): string {
  let out = '', last = 0
  for (const m of line.matchAll(DETECT)) {
    const v = m[0], i = m.index!
    const href = /^https?:/i.test(v) ? v : /^www\./i.test(v) ? `https://${v}` : v.includes('@') ? `mailto:${v}` : `tel:${v.replace(/[^\d+]/g, '')}`
    if (href.startsWith('tel:') && href.replace(/\D/g, '').length < 8) continue
    out += escapeHtml(line.slice(last, i)) + `<a href="${escapeHtml(href)}">${escapeHtml(v)}</a>`
    last = i + v.length
  }
  return out + escapeHtml(line.slice(last))
}
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
