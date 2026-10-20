// RoarMail's window, laid out like Airmail: accounts rail, folders, message list, reader.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Account, Action, Folder, ListScope, MessageFull, MessageRow } from '../shared/api'
import { t, when, type Key } from './i18n'
import { Icon, folderIcon } from './components/Icon'
import { AddAccount } from './components/AddAccount'
import { Viewer, initials, tint, type ComposeKind } from './components/Viewer'
import { Composer, type ComposeSeed } from './components/Composer'

const api = window.roarmail

export default function App() {
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [scope, setScope] = useState<ListScope>({ accountId: 'all', role: 'inbox' })
  const [folders, setFolders] = useState<Folder[]>([])
  const [rows, setRows] = useState<MessageRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MessageRow[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [compose, setCompose] = useState<ComposeSeed | null>(null)
  const [toast, setToast] = useState('')
  const [syncing, setSyncing] = useState<Record<string, boolean>>({})
  const [update, setUpdate] = useState<{ status: string; version: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const scopeRef = useRef(scope); scopeRef.current = scope

  const loadAccounts = useCallback(() => api.accounts().then(setAccounts), [])
  const loadFolders = useCallback(() => {
    const s = scopeRef.current
    if (s.accountId === 'all') setFolders([])
    else api.folders(s.accountId).then(setFolders)
  }, [])
  const loadRows = useCallback(() => api.messages(scopeRef.current).then(setRows), [])

  useEffect(() => { loadAccounts() }, [])
  useEffect(() => { loadFolders(); loadRows(); setSelected(null) }, [scope])
  useEffect(() => api.on((e) => {
    if (e.type === 'accounts') loadAccounts()
    if (e.type === 'folders' && e.accountId === scopeRef.current.accountId) loadFolders()
    if (e.type === 'messages') { if (scopeRef.current.accountId === 'all' || scopeRef.current.accountId === e.accountId) loadRows() }
    if (e.type === 'sync') setSyncing((s) => ({ ...s, [e.accountId]: e.busy }))
    if (e.type === 'open') { setScope({ accountId: 'all', role: 'inbox' }); setTimeout(() => setSelected(e.messageId), 50) }
    if (e.type === 'compose') setCompose({ kind: 'new', to: e.to, subject: e.subject, body: e.body })
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
  const index = list.findIndex((r) => r.id === selected)
  const current = index >= 0 ? list[index] : null

  const flash = (s: string) => { setToast(s); setTimeout(() => setToast(''), 2600) }

  const act = useCallback(async (ids: string[], action: Action) => {
    if (!ids.length) return
    if (action === 'archive' || action === 'trash') {
      // move the selection to the next message, like Airmail
      const i = list.findIndex((r) => ids.includes(r.id))
      const next = list.filter((r) => !ids.includes(r.id))[Math.min(i, list.length - ids.length - 1)]
      setRows((rs) => rs.filter((r) => !ids.includes(r.id)))
      setResults((rs) => rs && rs.filter((r) => !ids.includes(r.id)))
      setSelected(next?.id || null)
    } else {
      const patch = action === 'seen' ? { seen: true } : action === 'unseen' ? { seen: false } : action === 'flag' ? { flagged: true } : { flagged: false }
      const upd = (rs: MessageRow[]) => rs.map((r) => (ids.includes(r.id) ? { ...r, ...patch } : r))
      setRows(upd); setResults((rs) => rs && upd(rs))
      if (action === 'unseen') setSelected(null)
    }
    try { await api.act(ids, action) } catch (e: any) { flash(String(e?.message || e).replace(/^.*Error:\s*/, '')); loadRows() }
  }, [list])

  const openCompose = useCallback(async (kind: ComposeKind, m?: MessageFull) => {
    const source = m || (current ? await api.message(current.id) : undefined)
    if (source) setCompose({ kind, source })
  }, [current])

  // keyboard: Airmail-style single keys, and arrows / j k to move
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (compose || adding || el.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(el.tagName)) {
        if (e.key === 'Escape' && el === searchRef.current) { setQuery(''); searchRef.current?.blur() }
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key
      const move = (d: number) => { const n = list[Math.max(0, Math.min(list.length - 1, index + d))]; if (n) setSelected(n.id) }
      if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); move(1) }
      else if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); move(-1) }
      else if (k === 'c' || k === 'n') { e.preventDefault(); setCompose({ kind: 'new', accountId: scope.accountId === 'all' ? undefined : scope.accountId }) }
      else if (k === '/') { e.preventDefault(); searchRef.current?.focus() }
      else if (!current) return
      else if (k === 'r') { e.preventDefault(); openCompose('reply') }
      else if (k === 'a') { e.preventDefault(); openCompose('replyAll') }
      else if (k === 'f') { e.preventDefault(); openCompose('forward') }
      else if (k === 'e') act([current.id], 'archive')
      else if (k === '#' || k === 'Delete' || k === 'Backspace') act([current.id], 'trash')
      else if (k === 's') act([current.id], current.flagged ? 'unflag' : 'flag')
      else if (k === 'u') act([current.id], current.seen ? 'unseen' : 'seen')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [list, index, current, compose, adding, scope, act, openCompose])

  const title = useMemo(() => {
    if (results) return t.searchResults
    if (scope.folderId) return folders.find((f) => f.id === scope.folderId)?.name || ''
    if (scope.accountId === 'all') return t.allInboxes
    return t.inbox
  }, [scope, folders, results])

  if (!accounts) return <div className="boot"><div className="spinner" /></div>
  if (!accounts.length) return <AddAccount first onDone={loadAccounts} onCancel={() => {}} />

  const busy = Object.values(syncing).some(Boolean)
  const accountOf = (id: string) => accounts.find((a) => a.id === id)

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
            onClick={() => setScope({ accountId: a.id, role: 'inbox' })}
            onContextMenu={(e) => { e.preventDefault(); if (confirm(`${t.removeQ}\n\n${a.email}`)) api.removeAccount(a.id).then(() => setScope({ accountId: 'all', role: 'inbox' })) }}>
            {initials(a.displayName || a.email)}
          </button>
        ))}
        <button className="acc add" title={t.addAccount} onClick={() => setAdding(true)}><Icon name="plus" size={18} /></button>
        <span className="grow" />
        <button className={`acc tool-btn ${busy ? 'spin' : ''}`} title={t.refresh} onClick={() => api.refresh()}><Icon name="refresh" size={18} /></button>
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
        </div>
        <div className="rows">
          {list.map((r) => {
            const acc = accountOf(r.accountId)
            return (
              <div key={r.id} className={`msg ${r.id === selected ? 'on' : ''} ${r.seen ? '' : 'unread'}`} onClick={() => setSelected(r.id)}>
                <div className="avatar" style={{ background: tint(r.fromEmail) }}>{initials(r.fromName || r.fromEmail)}</div>
                <div className="msg-body">
                  <div className="row">
                    {!r.seen && <i className="dot" />}
                    <b className="grow ellipsis">{r.fromName || r.fromEmail}</b>
                    {r.hasAttachments && <Icon name="clip" size={13} />}
                    {r.flagged && <span className="star"><Icon name="star" size={13} filled /></span>}
                    <span className="muted small">{when(r.date)}</span>
                  </div>
                  <div className="ellipsis subj">{r.subject || t.noSubject}</div>
                  <div className="snip muted">{r.snippet}</div>
                </div>
                {scope.accountId === 'all' && acc && <i className="acc-bar" style={{ background: acc.color }} />}
                <div className="quick" onClick={(e) => e.stopPropagation()}>
                  <button title={r.seen ? t.markUnread : t.markRead} onClick={() => act([r.id], r.seen ? 'unseen' : 'seen')}><Icon name="dot" size={15} filled={!r.seen} /></button>
                  <button title={r.flagged ? t.unflag : t.flag} onClick={() => act([r.id], r.flagged ? 'unflag' : 'flag')}><Icon name="star" size={15} filled={r.flagged} /></button>
                  <button title={t.archiveIt} onClick={() => act([r.id], 'archive')}><Icon name="archive" size={15} /></button>
                  <button title={t.trashIt} onClick={() => act([r.id], 'trash')}><Icon name="trash" size={15} /></button>
                </div>
              </div>
            )
          })}
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
          {accounts.every((a) => a.state === 'online') && <span>{t.shortcuts}</span>}
        </div>
      </section>

      <Viewer id={selected} accounts={accounts}
        onCompose={(kind, m) => openCompose(kind, m)}
        onAct={(a) => current && act([current.id], a)} />

      {update?.status === 'ready' && (
        <button className="update pill primary" onClick={() => api.update.install()}>{t.updateReady} {update.version} · {t.restart}</button>
      )}
      {adding && <AddAccount first={false} onDone={() => { setAdding(false); loadAccounts() }} onCancel={() => setAdding(false)} />}
      {compose && <Composer seed={compose} accounts={accounts} onClose={() => setCompose(null)} onSent={() => { setCompose(null); flash(t.sent_ok) }} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
