// RoarMail's window, laid out like Airmail: accounts rail, folders, conversation list, reader.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type WheelEvent } from 'react'
import type { Account, Action, Folder, ListScope, MessageFull, MessageRow, OutboxItem, Settings, SwipeAction } from '../shared/api'
import { t, when, type Key } from './i18n'
import { Icon, folderIcon } from './components/Icon'
import { AddAccount } from './components/AddAccount'
import { Viewer, initials, tint, type ComposeKind } from './components/Viewer'
import { Composer, type ComposeSeed } from './components/Composer'
import { MovePicker } from './components/MovePicker'
import { SettingsSheet } from './components/SettingsSheet'

const api = window.roarmail
const keyOf = (r: MessageRow) => r.threadId || r.id
const clean = (e: any) => String(e?.message || e).replace(/^.*Error:\s*/, '')

interface Toast { text: string; undo?: () => void; ms?: number }

export default function App() {
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [scope, setScope] = useState<ListScope>({ accountId: 'all', role: 'inbox' })
  const [folders, setFolders] = useState<Folder[]>([])
  const [rows, setRows] = useState<MessageRow[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MessageRow[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [compose, setCompose] = useState<ComposeSeed | null>(null)
  const [moving, setMoving] = useState<{ accountId: string; ids: string[]; exclude?: string } | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [outbox, setOutbox] = useState<OutboxItem[]>([])
  const [prefs, setPrefs] = useState<Settings>({ undoSendSeconds: 5, swipeLeft: 'trash', swipeRight: 'archive', blockTrackers: true, stripTracking: true, lock: false, lockAfter: 15, appearance: 'system' })
  const [locked, setLocked] = useState(false)
  const [syncing, setSyncing] = useState<Record<string, boolean>>({})
  const [update, setUpdate] = useState<{ status: string; version: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const scopeRef = useRef(scope); scopeRef.current = scope
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const loadAccounts = useCallback(() => api.accounts().then(setAccounts), [])
  const loadFolders = useCallback(() => {
    const s = scopeRef.current
    if (s.accountId === 'all') setFolders([])
    else api.folders(s.accountId).then(setFolders)
  }, [])
  const loadRows = useCallback(() => api.messages(scopeRef.current).then(setRows), [])
  const loadOutbox = useCallback(() => api.outbox().then(setOutbox), [])

  const flash = useCallback((tst: Toast) => {
    clearTimeout(toastTimer.current)
    setToast(tst)
    toastTimer.current = setTimeout(() => setToast(null), tst.ms ?? 6000)
  }, [])

  useEffect(() => { api.lockState().then((l) => { setLocked(l.locked); if (!l.locked) { loadAccounts(); loadOutbox(); api.settings().then(setPrefs) } }) }, [])
  useEffect(() => { loadFolders(); loadRows(); setSelected([]) }, [scope])
  useEffect(() => api.on((e) => {
    if (e.type === 'accounts') loadAccounts()
    if (e.type === 'folders' && e.accountId === scopeRef.current.accountId) loadFolders()
    if (e.type === 'messages') { if (scopeRef.current.accountId === 'all' || scopeRef.current.accountId === e.accountId) loadRows() }
    if (e.type === 'sync') setSyncing((s) => ({ ...s, [e.accountId]: e.busy }))
    if (e.type === 'open') { setScope({ accountId: 'all', role: 'inbox' }); setTimeout(() => setSelected([e.messageId]), 80) }
    if (e.type === 'compose') setCompose({ kind: 'new', to: e.to, subject: e.subject, body: e.body })
    if (e.type === 'outbox') loadOutbox()
    if (e.type === 'opFailed') flash({ text: `${t.opFailed} (${e.error})` })
    if (e.type === 'lock') { setLocked(e.locked); if (!e.locked) { loadAccounts(); loadOutbox(); loadFolders(); loadRows(); api.settings().then(setPrefs) } }
  }), [])
  useEffect(() => {
    api.update?.state().then(setUpdate).catch(() => {})
    return api.update?.on(setUpdate)
  }, [])

  // search as you type, across the open account (or all)
  useEffect(() => {
    if (!query.trim()) { setResults(null); return }
    const h = setTimeout(() => api.search(query, scope.accountId === 'all' ? undefined : scope.accountId).then(setResults), 160)
    return () => clearTimeout(h)
  }, [query, scope.accountId])

  const list = results ?? rows
  const chosen = list.filter((r) => selected.includes(keyOf(r)))
  const current = chosen.length === 1 ? chosen[0] : null
  const index = current ? list.indexOf(current) : -1
  const folderRole = scope.folderId ? folders.find((f) => f.id === scope.folderId)?.role : scope.role
  const inDrafts = folderRole === 'drafts' && !results

  const act = useCallback(async (targets: MessageRow[], action: Action, folderId?: string) => {
    if (!targets.length) return
    const ids = targets.flatMap((r) => r.ids)
    const keys = targets.map(keyOf)
    if (action === 'archive' || action === 'trash' || action === 'move') {
      // the selection moves on to the next conversation, like Airmail
      const first = list.findIndex((r) => keys.includes(keyOf(r)))
      const rest = list.filter((r) => !keys.includes(keyOf(r)))
      const next = rest[Math.min(first, rest.length - 1)]
      setRows((rs) => rs.filter((r) => !keys.includes(keyOf(r))))
      setResults((rs) => rs && rs.filter((r) => !keys.includes(keyOf(r))))
      setSelected(next ? [keyOf(next)] : [])
    } else {
      const patch = action === 'seen' ? { seen: true } : action === 'unseen' ? { seen: false } : action === 'flag' ? { flagged: true } : { flagged: false }
      const upd = (rs: MessageRow[]) => rs.map((r) => (keys.includes(keyOf(r)) ? { ...r, ...patch } : r))
      setRows(upd); setResults((rs) => rs && upd(rs))
      if (action === 'unseen' && targets.length === 1) setSelected([])
    }
    try {
      const token = await api.act(ids, action, folderId)
      if (token) {
        const word = action === 'archive' ? t.archived : action === 'move' ? t.moved : folderRole === 'trash' ? t.deleted : t.trashed
        flash({ text: targets.length > 1 ? `${word} · ${targets.length}` : word, undo: () => { api.undo(token).then((ok) => { if (ok) { loadRows(); setSelected(keys) } }) } })
      }
    } catch (e) { flash({ text: clean(e) }); loadRows() }
  }, [list, folderRole])

  const swipe = useCallback((r: MessageRow, a: SwipeAction) => {
    if (a === 'archive' || a === 'trash') act([r], a)
    else if (a === 'flag') act([r], r.flagged ? 'unflag' : 'flag')
    else if (a === 'seen') act([r], r.seen ? 'unseen' : 'seen')
  }, [act])

  /** reply / forward from the keyboard: the newest message of the conversation */
  const openCompose = useCallback(async (kind: ComposeKind, m?: MessageFull) => {
    let source = m
    if (!source && current) {
      const items = await api.thread(keyOf(current))
      const last = items[items.length - 1] || current
      source = await api.message(last.id)
    }
    if (source) setCompose({ kind, source })
  }, [current])

  const openRow = useCallback(async (r: MessageRow) => {
    if (inDrafts) {
      try { setCompose({ kind: 'draft', draft: await api.draftFromMessage(r.id) }) } catch (e) { flash({ text: clean(e) }) }
      return
    }
    setSelected([keyOf(r)]); setAnchor(keyOf(r))
  }, [inDrafts])

  const click = (r: MessageRow, e: MouseEvent) => {
    const k = keyOf(r)
    if (e.metaKey || e.ctrlKey) {
      setSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k])); setAnchor(k)
    } else if (e.shiftKey && anchor) {
      const a = list.findIndex((x) => keyOf(x) === anchor), b = list.indexOf(r)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      setSelected(list.slice(lo, hi + 1).map(keyOf))
    } else openRow(r)
  }

  const openMove = useCallback((targets: MessageRow[]) => {
    if (!targets.length) return
    const accountId = targets[0].accountId
    setMoving({ accountId, ids: targets.filter((r) => r.accountId === accountId).map(keyOf), exclude: scope.folderId })
  }, [scope.folderId])

  const sent = (outboxId: string) => {
    setCompose(null)
    loadOutbox()
    if (prefs.undoSendSeconds > 0) {
      flash({
        text: t.sentIn, ms: prefs.undoSendSeconds * 1000,
        undo: async () => { const d = await api.cancelSend(outboxId); if (d) setCompose({ kind: 'draft', draft: d }) },
      })
    } else flash({ text: t.sent_ok, ms: 2600 })
  }

  // keyboard: Airmail-style single keys, and arrows / j k to move
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (compose || adding || moving || settingsOpen || el.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(el.tagName)) {
        if (e.key === 'Escape' && el === searchRef.current) { setQuery(''); searchRef.current?.blur() }
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); setSelected(list.map(keyOf)); return }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key
      const move = (d: number) => {
        const i = index >= 0 ? index : d > 0 ? -1 : list.length
        const n = list[Math.max(0, Math.min(list.length - 1, i + d))]
        if (n) { setSelected([keyOf(n)]); setAnchor(keyOf(n)) }
      }
      if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); move(1) }
      else if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); move(-1) }
      else if (k === 'c' || k === 'n') { e.preventDefault(); setCompose({ kind: 'new', accountId: scope.accountId === 'all' ? undefined : scope.accountId }) }
      else if (k === '/') { e.preventDefault(); searchRef.current?.focus() }
      else if (k === 'z' && toast?.undo) { toast.undo(); setToast(null) }
      else if (k === 'Escape') setSelected([])
      else if (!chosen.length) return
      else if (k === 'e') act(chosen, 'archive')
      else if (k === '#' || k === 'Delete' || k === 'Backspace') act(chosen, 'trash')
      else if (k === 'm') { e.preventDefault(); openMove(chosen) }
      else if (k === 's') act(chosen, chosen.every((r) => r.flagged) ? 'unflag' : 'flag')
      else if (k === 'u') act(chosen, chosen.every((r) => r.seen) ? 'unseen' : 'seen')
      else if (!current) return
      else if (k === 'r') { e.preventDefault(); openCompose('reply') }
      else if (k === 'a') { e.preventDefault(); openCompose('replyAll') }
      else if (k === 'f') { e.preventDefault(); openCompose('forward') }
      else if (k === 'Enter' && inDrafts) openRow(current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [list, index, current, chosen, compose, adding, moving, settingsOpen, scope, act, openCompose, openMove, toast, inDrafts, openRow])

  const title = useMemo(() => {
    if (results) return t.searchResults
    if (scope.folderId) { const f = folders.find((x) => x.id === scope.folderId); return f ? (f.role ? t[f.role as Key] : f.name) : '' }
    if (scope.accountId === 'all') return t.allInboxes
    return t.inbox
  }, [scope, folders, results])

  if (locked) return <LockScreen />
  if (!accounts) return <div className="boot"><div className="spinner" /></div>
  if (!accounts.length) return <AddAccount first onDone={loadAccounts} onCancel={() => {}} />

  const busy = Object.values(syncing).some(Boolean)
  const accountOf = (id: string) => accounts.find((a) => a.id === id)
  const failed = outbox.filter((o) => o.status === 'failed')
  const waiting = outbox.filter((o) => o.status !== 'failed' && o.sendAt < Date.now() - 1000)

  return (
    <div className="app">
      <nav className="rail">
        <div className="drag" />
        <button className={`acc all ${scope.accountId === 'all' ? 'on' : ''}`} title={t.allInboxes} onClick={() => setScope({ accountId: 'all', role: 'inbox' })}>
          <Icon name="inbox" size={20} />
        </button>
        {accounts.map((a) => (
          <button key={a.id} className={`acc ${scope.accountId === a.id ? 'on' : ''} ${a.state}`} style={{ ['--c' as any]: a.color }}
            title={`${a.email}${a.state !== 'online' ? ` · ${t[a.state as Key] || a.state}` : ''}`}
            onClick={() => setScope({ accountId: a.id, role: 'inbox' })}>
            {initials(a.displayName || a.email)}
          </button>
        ))}
        <button className="acc add" title={t.addAccount} onClick={() => setAdding(true)}><Icon name="plus" size={18} /></button>
        <span className="grow" />
        <button className={`acc tool-btn ${busy ? 'spin' : ''}`} title={t.refresh} onClick={() => api.refresh()}><Icon name="refresh" size={18} /></button>
        <button className="acc tool-btn" title={t.settings} onClick={() => setSettingsOpen(true)}><Icon name="gear" size={18} /></button>
      </nav>

      {scope.accountId !== 'all' && (
        <aside className="folders">
          <div className="drag" />
          <div className="acct-name">
            <b>{accountOf(scope.accountId)?.displayName || accountOf(scope.accountId)?.email.split('@')[0]}</b>
            <span className="muted small">{accountOf(scope.accountId)?.email}</span>
          </div>
          {folders.map((f) => {
            const on = scope.folderId ? scope.folderId === f.id : f.role === 'inbox'
            return (
              <button key={f.id} className={`folder ${on ? 'on' : ''}`} style={{ paddingLeft: 14 + Math.min(f.depth, 4) * 14 }}
                onClick={() => setScope(f.role === 'inbox' ? { accountId: f.accountId, role: 'inbox' } : { accountId: f.accountId, folderId: f.id })}>
                <Icon name={folderIcon(f.role)} size={16} />
                <span className="grow ellipsis">{f.role ? t[f.role as Key] : f.name}</span>
                {f.unread > 0 && f.role !== 'sent' && f.role !== 'trash' && f.role !== 'drafts' && <span className="count">{f.unread}</span>}
              </button>
            )
          })}
        </aside>
      )}

      <section className="list">
        <div className="list-head">
          <div className="drag" />
          <div className="row">
            <h3 className="grow ellipsis">{title}</h3>
            <button className="tool" title={`${t.compose} (C)`} onClick={() => setCompose({ kind: 'new', accountId: scope.accountId === 'all' ? undefined : scope.accountId })}><Icon name="compose" /></button>
          </div>
          <label className="search">
            <Icon name="search" size={15} />
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`${t.search}  /`} />
            {query && <button onClick={() => setQuery('')}><Icon name="close" size={13} /></button>}
          </label>
          {failed.map((o) => (
            <div key={o.id} className="outbox-bar failed">
              <span className="grow ellipsis"><b>{t.sendFailed}:</b> {o.subject || t.noSubject} ({o.error})</span>
              <button className="pill small" onClick={() => api.retrySend(o.id)}>{t.retry}</button>
              <button className="pill small ghost" onClick={async () => { const d = await api.cancelSend(o.id); if (d) setCompose({ kind: 'draft', draft: d }) }}>{t.edit}</button>
            </div>
          ))}
          {waiting.length > 0 && <div className="outbox-bar"><Icon name="sent" size={14} /> <span>{waiting.length} {t.outboxWaiting}</span></div>}
        </div>
        <div className="rows">
          {list.map((r) => (
            <Row key={keyOf(r)} r={r} on={selected.includes(keyOf(r))} acc={scope.accountId === 'all' ? accountOf(r.accountId) : undefined}
              prefs={prefs} onClick={(e) => click(r, e)} onAct={(a) => act([r], a)} onSwipe={(side) => swipe(r, side === 'left' ? prefs.swipeLeft : prefs.swipeRight)} />
          ))}
          {!list.length && (
            <div className="list-empty">
              {results ? t.noResults : (scope.role === 'inbox' && !scope.folderId) ? <><b className="zero">ROAR</b><span>{t.inboxZero}</span></> : t.empty}
            </div>
          )}
        </div>
        <div className="list-foot muted small" title={t.shortcuts}>
          {accounts.filter((a) => a.state !== 'online').map((a) => (
            <span key={a.id} className={`state ${a.state}`}>{a.email}: {t[a.state as Key] || a.state}</span>
          ))}
          {accounts.every((a) => a.state === 'online') && <span className="ellipsis">{t.shortcuts}</span>}
        </div>
      </section>

      {chosen.length > 1 ? (
        <section className="viewer empty multi">
          <div className="stack-count">{chosen.length}</div>
          <p className="muted">{t.messages} {t.selected}</p>
          <div className="row">
            <button className="pill" onClick={() => act(chosen, 'archive')}><Icon name="archive" size={15} /> {t.archiveIt}</button>
            <button className="pill" onClick={() => act(chosen, 'trash')}><Icon name="trash" size={15} /> {t.trashIt}</button>
            <button className="pill" onClick={() => openMove(chosen)}><Icon name="folder" size={15} /> {t.moveTo}</button>
          </div>
          <div className="row">
            <button className="pill ghost" onClick={() => act(chosen, 'seen')}>{t.markRead}</button>
            <button className="pill ghost" onClick={() => act(chosen, 'unseen')}>{t.markUnread}</button>
            <button className="pill ghost" onClick={() => act(chosen, chosen.every((r) => r.flagged) ? 'unflag' : 'flag')}>{t.flag}</button>
          </div>
        </section>
      ) : (
        <Viewer row={inDrafts ? null : current} accounts={accounts} prefs={prefs}
          onCompose={(kind, m) => openCompose(kind, m)}
          onAct={(a) => { if (!current) return; if (a === 'move') openMove([current]); else act([current], a) }} />
      )}

      {update?.status === 'ready' && (
        <button className="update pill primary" onClick={() => api.update.install()}>{t.updateReady} {update.version} · {t.restart}</button>
      )}
      {adding && <AddAccount first={false} onDone={() => { setAdding(false); loadAccounts() }} onCancel={() => setAdding(false)} />}
      {settingsOpen && <SettingsSheet accounts={accounts} onAddAccount={() => setAdding(true)} onClose={() => { setSettingsOpen(false); api.settings().then(setPrefs) }} />}
      {moving && (
        <MovePicker accountId={moving.accountId} exclude={moving.exclude} onClose={() => setMoving(null)}
          onPick={(fid) => { const targets = list.filter((r) => moving.ids.includes(keyOf(r))); setMoving(null); act(targets, 'move', fid) }} />
      )}
      {compose && <Composer seed={compose} accounts={accounts} onClose={(saved) => { setCompose(null); if (saved) flash({ text: t.draftSaved, ms: 2600 }) }} onSent={sent} />}
      {toast && (
        <div className="toast">
          <span>{toast.text}</span>
          {toast.undo && <button className="link" onClick={() => { toast.undo!(); setToast(null) }}>{t.undo}</button>}
        </div>
      )}
    </div>
  )
}

/** one conversation in the list: hover buttons, and a two-finger swipe on the trackpad */
function Row({ r, on, acc, prefs, onClick, onAct, onSwipe }: {
  r: MessageRow; on: boolean; acc?: Account; prefs: Settings
  onClick: (e: MouseEvent) => void; onAct: (a: Action) => void; onSwipe: (side: 'left' | 'right') => void
}) {
  const [dx, setDx] = useState(0)
  const sum = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const LIMIT = 90

  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    sum.current = Math.max(-150, Math.min(150, sum.current - e.deltaX))
    setDx(sum.current)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const v = sum.current
      sum.current = 0
      setDx(0)
      if (v <= -LIMIT && prefs.swipeLeft !== 'none') onSwipe('left')
      else if (v >= LIMIT && prefs.swipeRight !== 'none') onSwipe('right')
    }, 120)
  }
  const side = dx < 0 ? prefs.swipeLeft : prefs.swipeRight
  const armed = Math.abs(dx) >= LIMIT && side !== 'none'

  return (
    <div className={`swipe ${dx ? 'moving' : ''}`} onWheel={onWheel}>
      {dx !== 0 && (
        <div className={`swipe-under ${side} ${armed ? 'armed' : ''} ${dx < 0 ? 'left' : 'right'}`}>
          <Icon name={side === 'archive' ? 'archive' : side === 'trash' ? 'trash' : side === 'flag' ? 'star' : 'dot'} size={18} />
        </div>
      )}
      <div className={`msg ${on ? 'on' : ''} ${r.seen ? '' : 'unread'}`} style={dx ? { transform: `translateX(${dx}px)` } : undefined} onClick={onClick}>
        <div className="avatar" style={{ background: tint(r.fromEmail) }}>{initials(r.fromName || r.fromEmail)}</div>
        <div className="msg-body">
          <div className="row">
            {!r.seen && <i className="dot" />}
            <b className="grow ellipsis">{r.fromName || r.fromEmail}</b>
            {r.count > 1 && <span className="count-pill">{r.count}</span>}
            {r.hasAttachments && <Icon name="clip" size={13} />}
            {r.flagged && <span className="star"><Icon name="star" size={13} filled /></span>}
            <span className="muted small">{when(r.date)}</span>
          </div>
          <div className="ellipsis subj">{r.subject || t.noSubject}</div>
          <div className="snip muted">{r.snippet}</div>
        </div>
        {acc && <i className="acc-bar" style={{ background: acc.color }} />}
        <div className="quick" onClick={(e) => e.stopPropagation()}>
          <button title={r.seen ? t.markUnread : t.markRead} onClick={() => onAct(r.seen ? 'unseen' : 'seen')}><Icon name="dot" size={15} filled={!r.seen} /></button>
          <button title={r.flagged ? t.unflag : t.flag} onClick={() => onAct(r.flagged ? 'unflag' : 'flag')}><Icon name="star" size={15} filled={r.flagged} /></button>
          <button title={t.archiveIt} onClick={() => onAct('archive')}><Icon name="archive" size={15} /></button>
          <button title={t.trashIt} onClick={() => onAct('trash')}><Icon name="trash" size={15} /></button>
        </div>
      </div>
    </div>
  )
}

/** the lock: nothing of the mail is on screen (or reachable) until Touch ID */
function LockScreen() {
  const [busy, setBusy] = useState(false)
  const unlock = async () => { setBusy(true); await api.unlock(); setBusy(false) }
  useEffect(() => { unlock() }, [])
  return (
    <div className="lock-screen">
      <div className="drag" />
      <div className="brand big"><b>ROAR</b><i>MAIL</i></div>
      <Icon name="lock" size={28} />
      <p className="muted">{t.locked}</p>
      <button className="pill primary" disabled={busy} onClick={unlock}>{t.unlock}</button>
    </div>
  )
}
