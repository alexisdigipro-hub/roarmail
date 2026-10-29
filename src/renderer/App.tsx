// RoarMail's window, laid out like Airmail: accounts rail, folders, conversation list, reader.
import { GENERAL_DEFAULTS, LOOK_DEFAULTS, applyLook, useLens } from './look'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type WheelEvent } from 'react'
import type { Account, Action, Folder, ListFilter, ListScope, ListSort, MessageFull, MessageRow, OutboxItem, Rule, Settings, SwipeAction } from '../shared/api'
import { syncLanguage, t, when, type Key } from './i18n'
import { Icon, folderIcon } from './components/Icon'
import { AddAccount } from './components/AddAccount'
import { Viewer, initials, tint, type ComposeKind } from './components/Viewer'
import { Composer, type ComposeSeed } from './components/Composer'
import { MovePicker } from './components/MovePicker'
import { SettingsSheet, type Page } from './components/SettingsSheet'
import { blankRule } from './components/Rules'
import { TimePicker } from './components/TimePicker'
import { ShareSheet, TaskSheet, WorkPanel } from './components/RoarMe'
import { short } from './when'
import { Splitter, useWidths } from './components/Splitter'
import { StatsSheet } from './components/Stats'
import { actionSound, playNewMail, setActionSounds } from './sounds'
import { useSenderIcons } from './senders'

const api = window.roarmail
const keyOf = (r: MessageRow) => r.threadId || r.id
// the filter buttons above the list, like Airmail's
const FILTERS: [ListFilter, string, Key][] = [['unread', 'unread', 'fl_unread'], ['flagged', 'star', 'fl_flagged'], ['attachments', 'clip', 'fl_attachments'], ['threads', 'chat', 'fl_threads']]
// Airmail's sort menu
const SORTS: [ListSort, Key][] = [['date', 'so_date'], ['sender', 'so_sender'], ['subject', 'so_subject'], ['unread', 'so_unread'], ['attachments', 'so_attachments'], ['account', 'so_account']]
const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
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
  const [searching, setSearching] = useState(false)
  // the calendar and sort pop-overs of the filter bar
  const [pop, setPop] = useState<'day' | 'sort' | null>(null)
  const [dayPick, setDayPick] = useState('')
  const [adding, setAdding] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Settings opened at a page (Make a Rule from This Sender: Rules, with the rule started)
  const [settingsAt, setSettingsAt] = useState<{ page: Page; rule?: Rule } | null>(null)
  const [compose, setCompose] = useState<ComposeSeed | null>(null)
  const [moving, setMoving] = useState<{ accountId: string; ids: string[]; exclude?: string } | null>(null)
  const [snoozing, setSnoozing] = useState<string[] | null>(null)
  const [showScheduled, setShowScheduled] = useState(false)
  const [roar, setRoar] = useState<{ kind: 'share' | 'task'; m: MessageFull } | null>(null)
  const [workOpen, setWorkOpen] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  const [accDrag, setAccDrag] = useState('')
  const [accDrop, setAccDrop] = useState('')
  // the folders shown or hidden, ticked in place (Alex, 29 Oct: "the folders I want, and hide the rest")
  const [editFolders, setEditFolders] = useState(false)
  const [hiddenList, setHiddenList] = useState<Folder[]>([])
  useEffect(() => { setEditFolders(false) }, [scope.accountId])
  const [railWide, setRailWide] = useState(() => { try { return localStorage.getItem('roarmail.railwide') === '1' } catch { return false } })
  const toggleRail = () => setRailWide((v) => { try { localStorage.setItem('roarmail.railwide', v ? '0' : '1') } catch { /* this run only */ } return !v })
  const [toast, setToast] = useState<Toast | null>(null)
  const [outbox, setOutbox] = useState<OutboxItem[]>([])
  const [prefs, setPrefs] = useState<Settings>({ ...LOOK_DEFAULTS, ...GENERAL_DEFAULTS, undoSendSeconds: 5, swipeLeft: 'trash', swipeRight: 'archive', blockTrackers: true, stripTracking: true, lock: false, lockAfter: 15, appearance: 'system', runAtLogin: false })
  const [locked, setLocked] = useState(false)
  const [syncing, setSyncing] = useState<Record<string, boolean>>({})
  const [update, setUpdate] = useState<{ status: string; version: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // search is a magnifier in the filter capsule; it opens into a field (the button, or /)
  const [searchOpen, setSearchOpen] = useState(false)
  const openSearch = () => { setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 0) }
  const closeSearch = () => { setQuery(''); setSearchOpen(false) }
  const scopeRef = useRef(scope); scopeRef.current = scope
  const [intro, setIntro] = useState(true)
  const [widths, setWidth] = useWidths()
  const folderLens = useLens<HTMLDivElement>(`${scope.accountId}|${scope.folderId || ''}|${scope.role || ''}|${folders.length}`)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const loadAccounts = useCallback(() => api.accounts().then(setAccounts), [])
  const loadFolders = useCallback(() => {
    const s = scopeRef.current
    if (s.accountId === 'all') api.unifiedFolders().then(setFolders)
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
  // RoarMe's opening: the side from the left, the rows in turn, the reader rising (once)
  useEffect(() => { const h = setTimeout(() => setIntro(false), 1600); return () => clearTimeout(h) }, [])
  useEffect(() => api.on((e) => {
    if (e.type === 'accounts') loadAccounts()
    if (e.type === 'folders' && e.accountId === scopeRef.current.accountId) loadFolders()
    if (e.type === 'folders') loadAccounts()
    if (e.type === 'messages') { if (scopeRef.current.accountId === 'all' || scopeRef.current.accountId === e.accountId) loadRows() }
    if (e.type === 'sync') setSyncing((s) => ({ ...s, [e.accountId]: e.busy }))
    if (e.type === 'open' && e.subject != null) { setScope({ accountId: 'all', role: 'inbox' }); setQuery(e.subject); setTimeout(() => setSelected([e.messageId]), 600) }
    else if (e.type === 'open') { setScope({ accountId: 'all', role: 'inbox' }); setTimeout(() => setSelected([e.messageId]), 80) }
    if (e.type === 'compose') setCompose({ kind: 'new', to: e.to, subject: e.subject, body: e.body })
    if (e.type === 'outbox') loadOutbox()
    if (e.type === 'opFailed') flash({ text: `${t.opFailed} (${e.error})` })
    if (e.type === 'sound') playNewMail(e.sound)
    if (e.type === 'lock') { setLocked(e.locked); if (!e.locked) { loadAccounts(); loadOutbox(); loadFolders(); loadRows(); api.settings().then(setPrefs) } }
  }), [])
  useEffect(() => setActionSounds(!!prefs.actionSounds), [prefs.actionSounds])
  // Settings > General > Language: kept where i18n reads it before anything is drawn; a change reloads the window
  useEffect(() => { api.settings().then((x) => { if (syncLanguage(x.language)) location.reload() }).catch(() => {}) }, [prefs.language])
  // without the unified inbox the first account opens instead
  useEffect(() => {
    if (!prefs.unifiedInbox && scope.accountId === 'all' && accounts?.length) setScope({ accountId: accounts[0].id, role: 'inbox' })
  }, [prefs.unifiedInbox, accounts, scope.accountId])
  // a short note from anywhere in the window (an attachment saved to the downloads folder)
  useEffect(() => {
    const h = (e: Event) => flash({ text: String((e as CustomEvent).detail || ''), ms: 3500 })
    window.addEventListener('roarmail-toast', h)
    return () => window.removeEventListener('roarmail-toast', h)
  }, [])
  useEffect(() => {
    api.update?.state().then(setUpdate).catch(() => {})
    return api.update?.on(setUpdate)
  }, [])

  // search as you type, across the open account (or all)
  useEffect(() => {
    if (!query.trim()) { setResults(null); return }
    let live = true
    const acc = scope.accountId === 'all' ? undefined : scope.accountId
    const h = setTimeout(() => {
      api.search(query, acc).then((r) => { if (live) setResults(r) })
      // Settings > Advanced > Online search: the servers too, a moment later (older mail than this computer has)
      if (prefs.onlineSearch && query.trim().length > 2) {
        setSearching(true)
        api.searchOnline(query, acc).then((r) => { if (live) setResults(r) }).catch(() => {}).finally(() => { if (live) setSearching(false) })
      }
    }, prefs.onlineSearch ? 450 : 160)
    return () => { live = false; clearTimeout(h); setSearching(false) }
  }, [query, scope.accountId, prefs.onlineSearch])

  const list = results ?? rows
  const senderPic = useSenderIcons(list.slice(0, 150).map((r) => r.fromEmail), prefs.senderPictures && prefs.listAvatars)
  const [editUnified, setEditUnified] = useState(false)
  // a folder's right-click menu asks here for a name or a colour
  const [folderAsk, setFolderAsk] = useState<{ kind: 'new' | 'sub' | 'rename' | 'custom'; folder: Folder } | null>(null)
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
        actionSound(action === 'archive' ? 'archive' : action === 'trash' ? 'trash' : 'archive')
        const word = action === 'archive' ? t.archived : action === 'move' ? t.moved : folderRole === 'trash' ? t.deleted : t.trashed
        flash({ text: targets.length > 1 ? `${word} · ${targets.length}` : word, undo: () => { api.undo(token).then((ok) => { if (ok) { loadRows(); setSelected(keys) } }) } })
      }
    } catch (e) { flash({ text: clean(e) }); loadRows() }
  }, [list, folderRole])

  const openSnooze = useCallback((targets: MessageRow[]) => { if (targets.length) setSnoozing(targets.map(keyOf)) }, [])

  const swipe = useCallback((r: MessageRow, a: SwipeAction) => {
    if (a === 'archive' || a === 'trash') act([r], a)
    else if (a === 'flag') act([r], r.flagged ? 'unflag' : 'flag')
    else if (a === 'seen') act([r], r.seen ? 'unseen' : 'seen')
    else if (a === 'snooze') openSnooze([r])
  }, [act, openSnooze])

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

  // drag mail onto a folder (Alex, 21 Oct 2026): the selection if the row is in it, else that row
  const dragging = useRef<MessageRow[] | null>(null)
  const [dropOn, setDropOn] = useState('')
  const startDrag = (r: MessageRow, e: DragEvent) => {
    const targets = selected.includes(keyOf(r)) ? chosen : [r]
    dragging.current = targets
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', targets.map((x) => x.subject).join('\n'))
    const ghost = document.createElement('div')
    ghost.className = 'drag-ghost'
    ghost.textContent = targets.length > 1 ? `${targets.length} ${t.messages}` : (r.subject || t.noSubject)
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 14, 14)
    setTimeout(() => ghost.remove(), 0)
  }
  /** what a folder does with dropped mail: archive / trash by role, else a move into that very folder */
  const dropTo = (f: Folder) => {
    const run = () => {
      const targets = dragging.current
      dragging.current = null; setDropOn('')
      if (!targets?.length) return
      if (f.role === 'archive') act(targets, 'archive')
      else if (f.role === 'trash') act(targets, 'trash')
      else if (f.accountId !== 'all') act(targets.filter((x) => x.accountId === f.accountId), 'move', f.id)
    }
    const ok = f.role === 'archive' || f.role === 'trash' || (f.accountId !== 'all' && f.id !== scope.folderId && !(f.role === 'inbox' && !scope.folderId))
    return ok ? {
      onDragOver: (e: DragEvent) => { if (dragging.current) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropOn !== f.id) setDropOn(f.id) } },
      onDragLeave: () => setDropOn((d) => (d === f.id ? '' : d)),
      onDrop: (e: DragEvent) => { e.preventDefault(); run() },
    } : {}
  }

  /** a folder's right-click menu (the Mac's own, from the engine) and what each choice does */
  // Sync all messages of the whole mail: every folder of the account shown, or of every account (29 Oct 2026)
  const syncEverything = async (accountId: string) => {
    flash({ text: t.fm_syncingEverything, ms: 3000 })
    try { const n = await api.syncEverything(accountId); flash({ text: `${t.fm_synced} ${n}`, ms: 3500 }) } catch (err) { flash({ text: clean(err) }) }
  }

  // Empty Trash / Empty Junk, from a folder's menu or the button over the list (29 Oct 2026)
  const emptyBin = async (target: { folderId?: string; role?: 'trash' | 'spam' }) => {
    if (!confirm(t.fm_emptyQ)) return
    try { await api.emptyFolder(target); flash({ text: t.fm_emptied }) } catch (err) { flash({ text: clean(err) }) }
  }

  const folderMenu = async (f: Folder, e: MouseEvent) => {
    e.preventDefault()
    const labels = { new: t.fm_new, sub: t.fm_sub, rename: t.fm_rename, red: t.qc_red, orange: t.qc_orange, yellow: t.fc_yellow, green: t.qc_green,
      blue: t.qc_blue, purple: t.qc_purple, custom: t.fc_custom, nocolor: t.fc_none, hide: t.fm_hide, read: t.fm_read, sync: t.fm_sync, rules: t.fm_rules, delete: t.fm_delete,
      empty: f.role === 'spam' ? t.fm_emptyJunk : t.fm_emptyTrash }
    const pick = await api.folderMenu(f.id, labels)
    if (!pick) return
    try {
      if (pick === 'new' || pick === 'sub' || pick === 'rename' || pick === 'custom') setFolderAsk({ kind: pick, folder: f })
      else if (pick.startsWith('c:')) await api.setFolderColor(f.id, pick.slice(2))
      else if (pick === 'nocolor') await api.setFolderColor(f.id, null)
      else if (pick === 'hide') { await api.hideFolder(f.id, true); flash({ text: `${t.fm_hidden}`, ms: 3500 }) }
      else if (pick === 'read') await api.markFolderRead(f.id)
      else if (pick === 'empty') await emptyBin({ folderId: f.id })
      else if (pick === 'rules') { const n = await api.runRules(f.id); flash({ text: `${t.fm_rulesDone} ${n}`, ms: 3500 }) }
      else if (pick === 'sync') { flash({ text: t.fm_syncing, ms: 2500 }); const n = await api.syncFolderAll(f.id); flash({ text: `${t.fm_synced} ${n}`, ms: 3500 }) }
      else if (pick === 'delete' && confirm(`${t.fm_deleteQ}\n\n${f.name}`)) {
        await api.deleteFolder(f.id)
        if (scope.folderId === f.id) setScope({ accountId: f.accountId, role: 'inbox' })
      }
    } catch (err) { flash({ text: clean(err) }) }
  }

  // a message's right-click menu (Alex, 29 Oct: "right click on the mail and Block sender"): on the selection when
  // the row is in it, else on that row; the sender's choices (block, a rule) are always the clicked row's
  const rowMenu = async (r: MessageRow, e: MouseEvent) => {
    e.preventDefault()
    const targets = selected.includes(keyOf(r)) ? chosen : [r]
    const blocked = (await api.blockedSenders().catch(() => [] as string[])).includes(r.fromEmail.toLowerCase())
    const allSeen = targets.every((x) => x.seen), allFlag = targets.every((x) => x.flagged)
    const pick = await api.popMenu([
      { id: 'seen', label: allSeen ? t.markUnread : t.markRead },
      { id: 'flag', label: allFlag ? t.unflag : t.flag },
      null,
      { id: 'archive', label: t.archiveIt },
      { id: 'move', label: t.moveTo },
      { id: 'snooze', label: t.snoozeIt },
      { id: 'trash', label: t.trashIt },
      null,
      { id: 'block', label: blocked ? t.unblockSender : t.blockSender, enabled: !!r.fromEmail },
      { id: 'rule', label: t.ru_fromSender, enabled: !!r.fromEmail },
    ])
    if (!pick) return
    try {
      if (pick === 'seen') act(targets, allSeen ? 'unseen' : 'seen')
      else if (pick === 'flag') act(targets, allFlag ? 'unflag' : 'flag')
      else if (pick === 'archive' || pick === 'trash') act(targets, pick)
      else if (pick === 'move') openMove(targets)
      else if (pick === 'snooze') openSnooze(targets)
      else if (pick === 'block') { await api.blockSender(r.fromEmail, !blocked); flash({ text: blocked ? `${t.unblock}: ${r.fromEmail}` : t.blockedNote, ms: 3500 }) }
      else if (pick === 'rule') {
        setSettingsAt({ page: 'rules', rule: blankRule({ name: r.fromName || r.fromEmail, conditions: [{ field: 'from', value: r.fromEmail }] }) })
        setSettingsOpen(true)
      }
    } catch (err) { flash({ text: clean(err) }) }
  }

  // an account's right-click menu in the rail: check it now, its inbox read, its settings
  const accountMenu = async (a: Account, e: MouseEvent) => {
    e.preventDefault()
    const inbox = folders.find((f) => f.accountId === a.id && f.role === 'inbox')
    const pick = await api.popMenu([
      { id: 'check', label: t.refresh },
      { id: 'read', label: t.fm_read, enabled: !!inbox && inbox.unread > 0 },
      null,
      { id: 'settings', label: t.pg_accounts },
    ])
    try {
      if (pick === 'check') await api.refresh(a.id)
      else if (pick === 'read' && inbox) await api.markFolderRead(inbox.id)
      else if (pick === 'settings') { setSettingsAt({ page: 'accounts' }); setSettingsOpen(true) }
    } catch (err) { flash({ text: clean(err) }) }
  }

  const openMove = useCallback((targets: MessageRow[]) => {
    if (!targets.length) return
    const accountId = targets[0].accountId
    setMoving({ accountId, ids: targets.filter((r) => r.accountId === accountId).map(keyOf), exclude: scope.folderId })
  }, [scope.folderId])

  const doSnooze = async (keys: string[], until: number | null) => {
    const targets = list.filter((r) => keys.includes(keyOf(r)))
    const ids = targets.flatMap((r) => r.ids)
    const first = list.findIndex((r) => keys.includes(keyOf(r)))
    const rest = list.filter((r) => !keys.includes(keyOf(r)))
    setRows((rs) => rs.filter((r) => !keys.includes(keyOf(r))))
    setSelected(rest[Math.min(first, rest.length - 1)] ? [keyOf(rest[Math.min(first, rest.length - 1)])] : [])
    try {
      const token = await api.snooze(ids, until)
      flash({ text: until ? `${t.snoozedToast} ${short(until)}` : t.setAside, undo: token ? () => { api.undo(token).then(() => loadRows()) } : undefined })
    } catch (e) { flash({ text: clean(e) }); loadRows() }
  }

  const sent = (outboxId: string, at?: number) => {
    setCompose(null)
    if (!at) actionSound('send')
    loadOutbox()
    if (at) flash({ text: `${t.scheduledFor} ${short(at)}`, ms: 4000 })
    else if (prefs.undoSendSeconds > 0) {
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
      if (compose || adding || moving || snoozing || roar || settingsOpen || el.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(el.tagName)) {
        if (e.key === 'Escape' && el === searchRef.current) { closeSearch(); searchRef.current?.blur() }
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && !el.closest?.('.read')) { e.preventDefault(); setSelected(list.map(keyOf)); return }
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
      else if (k === '/') { e.preventDefault(); openSearch() }
      else if (k === 'z' && toast?.undo) { toast.undo(); setToast(null) }
      else if (k === 'Escape') setSelected([])
      else if (!chosen.length) return
      else if (k === 'e') act(chosen, 'archive')
      else if (k === '#' || k === 'Delete' || k === 'Backspace') act(chosen, 'trash')
      else if (k === 'm') { e.preventDefault(); openMove(chosen) }
      else if (k === 'b' || k === 'h') { e.preventDefault(); openSnooze(chosen) }
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
  }, [list, index, current, chosen, compose, adding, moving, snoozing, roar, settingsOpen, scope, act, openCompose, openMove, openSnooze, toast, inDrafts, openRow])

  const title = useMemo(() => {
    if (results) return t.searchResults
    if (scope.person) return list[0] ? (list.find((r) => r.fromEmail === scope.person)?.fromName || scope.person) : scope.person
    if (scope.folderId) { const f = folders.find((x) => x.id === scope.folderId); return f ? (f.role ? t[f.role as Key] : f.name) : '' }
    if (scope.accountId === 'all') return t[`all_${scope.role || 'inbox'}` as Key] || t.allInboxes
    return t.inbox
  }, [scope, folders, results, list])

  const busy = Object.values(syncing).some(Boolean)
  // pull down to refresh (Alex, 29 Oct: "swipe down on the messages and it loads"): at the top of the list, two fingers
  // pulling the list down on a trackpad (or a finger on a touch screen) draws the circle; far enough, and mail is
  // fetched from every account, as the refresh button does
  const PULL_AT = 72
  const [pull, setPull] = useState(0)
  const [pulled, setPulled] = useState(false) // a pull asked for mail: the circle spins until it has come
  const pullRef = useRef({ v: 0, idle: 0 as unknown as ReturnType<typeof setTimeout>, y0: -1, fired: false })
  const listRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = listRef.current
    if (!el) return undefined
    const p = pullRef.current
    const rowsAtTop = (t: EventTarget | null) => { const rows = (t as HTMLElement | null)?.closest?.('.rows') as HTMLElement | null; return !!rows && rows.scrollTop <= 0 }
    const show = (v: number) => { p.v = Math.max(0, Math.min(110, v)); setPull(p.v) }
    const end = () => { if (p.v >= PULL_AT && !p.fired) { p.fired = true; setPulled(true); api.refresh() } show(0); setTimeout(() => { p.fired = false }, 600) }
    const wheel = (e: globalThis.WheelEvent) => {
      if (!rowsAtTop(e.target) || e.ctrlKey) return
      if (e.deltaY < 0) { show(p.v - e.deltaY * 0.45); clearTimeout(p.idle); p.idle = setTimeout(end, 140) }
      else if (p.v) { show(p.v - e.deltaY); clearTimeout(p.idle); p.idle = setTimeout(end, 140) }
    }
    const down = (e: TouchEvent) => { p.y0 = rowsAtTop(e.target) ? e.touches[0].clientY : -1 }
    const move = (e: TouchEvent) => { if (p.y0 >= 0) { const d = e.touches[0].clientY - p.y0; if (d > 0) show(d * 0.55) } }
    const up = () => { if (p.y0 >= 0) { p.y0 = -1; end() } }
    el.addEventListener('wheel', wheel, { passive: true })
    el.addEventListener('touchstart', down, { passive: true })
    el.addEventListener('touchmove', move, { passive: true })
    el.addEventListener('touchend', up)
    return () => { el.removeEventListener('wheel', wheel); el.removeEventListener('touchstart', down); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', up); clearTimeout(p.idle) }
  }, [!!accounts?.length])
  useEffect(() => {
    if (!pulled) return undefined
    const id = setTimeout(() => setPulled(false), busy ? 30000 : 900)
    return () => clearTimeout(id)
  }, [pulled, busy])
  // every hook above this line: React needs the same hooks on every render (0.18.2-0.18.7 opened blank)
  if (locked) return <LockScreen />
  if (!accounts) return <div className="boot"><div className="empty-mark boot-mark"><b>ROAR</b><i>MAIL</i></div></div>
  if (!accounts.length) return <AddAccount first onDone={loadAccounts} onCancel={() => {}} />

  // Settings > Appearance: unread, all messages or nothing next to the inbox and the other folders
  const counter = (f: Folder) => {
    const mode = f.role === 'inbox' ? prefs.inboxCounter : prefs.folderCounter
    if (mode === 'none') return 0
    if (mode === 'total') return f.role === 'trash' || f.role === 'spam' ? 0 : f.total
    return f.role === 'sent' || f.role === 'trash' || f.role === 'drafts' ? 0 : f.unread
  }
  const accountOf = (id: string) => accounts.find((a) => a.id === id)
  // the rail in the order dragged by hand (Settings accountOrder); accounts not in it keep their place after
  const railOrder = (prefs.accountOrder || '').split(',').filter(Boolean)
  const railAt = (id: string) => { const i = railOrder.indexOf(id); return i < 0 ? railOrder.length + accounts.findIndex((a) => a.id === id) : i }
  const railAccounts = [...accounts].sort((a, b) => railAt(a.id) - railAt(b.id))
  const moveAccount = (from: string, to: string) => {
    setAccDrag(''); setAccDrop('')
    if (from === to) return
    const ids = railAccounts.map((a) => a.id).filter((id) => id !== from)
    ids.splice(ids.indexOf(to) + (railAccounts.findIndex((a) => a.id === from) < railAccounts.findIndex((a) => a.id === to) ? 1 : 0), 0, from)
    const v = ids.join(',')
    api.setSetting('accountOrder', v); setPrefs((p) => ({ ...p, accountOrder: v }))
  }
  const viewRole = scope.folderId ? folders.find((f) => f.id === scope.folderId)?.role : scope.accountId === 'all' ? scope.role : undefined
  const binRole = viewRole === 'trash' || viewRole === 'spam' ? viewRole : null
  const failed = outbox.filter((o) => o.status === 'failed')
  const waiting = outbox.filter((o) => o.status !== 'failed' && !o.scheduled && o.sendAt < Date.now() - 1000)
  const later = outbox.filter((o) => o.status !== 'failed' && o.scheduled)

  return (
    <div className={`app ${intro ? 'intro' : ''}`} style={{ ['--w-folders' as any]: `${widths.folders}px`, ['--w-list' as any]: `${widths.list}px` }}>
      {/* the rail opens wide to show each account's name and address next to its picture (29 Oct 2026) */}
      <nav className={`rail ${railWide ? 'wide' : ''}`}>
        <div className="drag" />
        {prefs.unifiedInbox && (
          <button className="acc-line" title={t.allInboxes} onClick={() => setScope({ accountId: 'all', role: 'inbox' })}>
            <span className={`acc all ${scope.accountId === 'all' ? 'on' : ''}`}><Icon name="inbox" size={20} /></span>
            <span className="acc-label"><b>{t.allInboxes}</b></span>
          </button>
        )}
        {railAccounts.map((a) => (
          <button key={a.id} className={`acc-line ${scope.accountId === a.id ? 'on' : ''} ${accDrop === a.id ? 'acc-drop' : ''} ${accDrag === a.id ? 'acc-dragging' : ''}`}
            draggable onDragStart={(e) => { setAccDrag(a.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-roarmail-account', a.id) }}
            onDragOver={(e) => { if (accDrag) { e.preventDefault(); setAccDrop(a.id) } }} onDragLeave={() => setAccDrop((x) => (x === a.id ? '' : x))}
            onDrop={(e) => { if (accDrag) { e.preventDefault(); moveAccount(accDrag, a.id) } }} onDragEnd={() => { setAccDrag(''); setAccDrop('') }}
            title={`${a.email}${a.state !== 'online' ? ` · ${t[a.state as Key] || a.state}` : ''}`}
            onClick={() => setScope({ accountId: a.id, role: 'inbox' })} onContextMenu={(e) => accountMenu(a, e)}>
            <span className={`acc ${scope.accountId === a.id ? 'on' : ''} ${a.state}`} style={{ ['--c' as any]: a.color }}>
              {a.avatar ? <img className="acc-img" src={a.avatar} alt="" /> : initials(a.description || a.displayName || a.email)}
              {prefs.accountBadges && a.unread > 0 && <span className="acc-badge">{a.unread > 99 ? '99+' : a.unread}</span>}
            </span>
            <span className="acc-label">
              <b>{a.description || a.displayName || a.email.split('@')[0]}</b>
              <small>{a.email}</small>
            </span>
          </button>
        ))}
        {/* Add account lives in Settings > Accounts (Alex, 29 Oct: "take it out of here") */}
        <span className="grow" />
        <div className="rail-tools">
          <button className={`acc tool-btn ${busy ? 'spin' : ''}`} title={t.refresh} onClick={() => api.refresh()}><Icon name="refresh" size={18} /></button>
          <button className={`acc tool-btn ${workOpen ? 'on-tool' : ''}`} title={`${t.roarme} · ${t.rm_work}`} onClick={() => setWorkOpen((v) => !v)}><Icon name="tasks" size={18} /></button>
          <button className={`acc tool-btn ${statsOpen ? 'on-tool' : ''}`} title={t.st_title} onClick={() => setStatsOpen(true)}><Icon name="chart" size={18} /></button>
          <button className="acc tool-btn" title={t.settings} onClick={() => setSettingsOpen(true)}><Icon name="gear" size={18} /></button>
          <button className={`acc tool-btn ${railWide ? 'on-tool' : ''}`} title={railWide ? t.railIcons : t.railNames} onClick={toggleRail}><Icon name="sidebar" size={18} /></button>
        </div>
      </nav>

      {scope.accountId === 'all' && (
        <aside className="folders">
          <div className="drag" />
          <div className="acct-name row-name">
            <span className="grow name-col"><b className="plain-case">{t.allAccounts}</b>
              <small className="muted block">{accounts.length} {t.accounts.toLowerCase()}</small></span>
            <button className="tool small" title={t.fm_syncEverything} onClick={() => syncEverything('all')}><Icon name="download" size={15} /></button>
            <button className={`link small ${editUnified ? 'on' : ''}`} onClick={() => setEditUnified((v) => !v)}>{editUnified ? t.done : t.edit}</button>
          </div>
          <div className="folder-list list-lens lens" ref={folderLens}>
          {folders.filter((f) => editUnified || f.role === 'inbox' || prefs.unifiedShown.split(',').includes(f.role!)).map((f) => editUnified ? (
            <label key={f.id} className={`folder pick ${f.role === 'inbox' ? 'fixed' : ''}`}>
              <input type="checkbox" disabled={f.role === 'inbox'} checked={f.role === 'inbox' || prefs.unifiedShown.split(',').includes(f.role!)}
                onChange={(e) => {
                  const now = new Set(prefs.unifiedShown.split(',').filter(Boolean))
                  if (e.target.checked) now.add(f.role!); else now.delete(f.role!)
                  const v = [...now].join(',')
                  api.setSetting('unifiedShown', v); setPrefs((p) => ({ ...p, unifiedShown: v }))
                  if (!e.target.checked && scope.role === f.role) setScope({ accountId: 'all', role: 'inbox' })
                }} />
              <Icon name={folderIcon(f.role)} size={16} />
              <span className="grow ellipsis">{t[`all_${f.role}` as Key] || t[f.role as Key]}</span>
            </label>
          ) : (
            <button key={f.id} className={`folder ${scope.role === f.role ? 'on' : ''} ${dropOn === f.id ? 'drop' : ''}`} style={{ paddingLeft: 14 }}
              onClick={() => setScope({ accountId: 'all', role: f.role! })} {...dropTo(f)}>
              <Icon name={folderIcon(f.role)} size={16} />
              <span className="grow ellipsis">{t[`all_${f.role}` as Key] || t[f.role as Key]}</span>
              {counter(f) > 0 && <span className={`count ${(f.role === 'inbox' ? prefs.inboxCounter : prefs.folderCounter) === 'total' ? 'total' : ''}`}>{counter(f)}</span>}
            </button>
          ))}
          </div>
        </aside>
      )}
      {scope.accountId !== 'all' && (
        <aside className="folders">
          <div className="drag" />
          <div className="acct-name row-name">
            <span className="grow name-col"><b>{accountOf(scope.accountId)?.description || accountOf(scope.accountId)?.displayName || accountOf(scope.accountId)?.email.split('@')[0]}</b>
              <small className="muted block">{accountOf(scope.accountId)?.email}</small></span>
            {/* a new folder without hunting for the right-click (Alex, 29 Oct: "I can't even make folders") */}
            <button className="tool small" title={t.fm_new} disabled={!folders.some((f) => f.accountId === scope.accountId)}
              onClick={() => { const f = folders.find((x) => x.accountId === scope.accountId && x.role === 'inbox') || folders.find((x) => x.accountId === scope.accountId); if (f) setFolderAsk({ kind: 'new', folder: f }) }}><Icon name="plus" size={15} /></button>
            <button className="tool small" title={t.fm_syncEverything} onClick={() => syncEverything(scope.accountId)}><Icon name="download" size={15} /></button>
            <button className={`link small ${editFolders ? 'on' : ''}`} onClick={() => { if (!editFolders) api.hiddenFolders(scope.accountId).then(setHiddenList); setEditFolders((v) => !v) }}>{editFolders ? t.done : t.edit}</button>
          </div>
          <div className="folder-list list-lens lens" ref={folderLens}>
          {editFolders && [...folders, ...hiddenList.filter((h) => !folders.some((f) => f.id === h.id))].map((f) => {
            const shown = !hiddenList.some((h) => h.id === f.id)
            return (
              <label key={f.id} className={`folder pick ${f.role === 'inbox' ? 'fixed' : ''}`} style={{ paddingLeft: 14 + Math.min(f.depth, 4) * 14 }}>
                <input type="checkbox" disabled={f.role === 'inbox'} checked={shown}
                  onChange={async (e) => { await api.hideFolder(f.id, !e.target.checked); setHiddenList(await api.hiddenFolders(scope.accountId)) }} />
                <span className="folder-ic" style={f.color ? { color: f.color } : undefined}><Icon name={folderIcon(f.role)} size={16} filled={!!f.color && !f.role} /></span>
                <span className="grow ellipsis">{f.role ? t[f.role as Key] : f.name}</span>
              </label>
            )
          })}
          {!editFolders && folders.map((f) => {
            const on = scope.folderId ? scope.folderId === f.id : f.role === 'inbox'
            return (
              <button key={f.id} className={`folder ${on ? 'on' : ''} ${dropOn === f.id ? 'drop' : ''}`} style={{ paddingLeft: 14 + Math.min(f.depth, 4) * 14 }}
                onClick={() => setScope(f.role === 'inbox' ? { accountId: f.accountId, role: 'inbox' } : { accountId: f.accountId, folderId: f.id })} {...dropTo(f)}
                onContextMenu={(e) => folderMenu(f, e)}>
                <span className="folder-ic" style={f.color ? { color: f.color } : undefined}><Icon name={folderIcon(f.role)} size={16} filled={!!f.color && !f.role} /></span>
                <span className="grow ellipsis">{f.role ? t[f.role as Key] : f.name}</span>
                {counter(f) > 0 && <span className={`count ${(f.role === 'inbox' ? prefs.inboxCounter : prefs.folderCounter) === 'total' ? 'total' : ''}`}>{counter(f)}</span>}
              </button>
            )
          })}
          </div>
        </aside>
      )}
      {<Splitter col="folders" width={widths.folders} onChange={setWidth} title={t.resizeCol} />}

      <section className="list" ref={listRef}>
        <div className="list-head">
          <div className="drag" />
          <div className="row">
            <h3 className="grow ellipsis" key={title}>{title}</h3>
            {binRole && !results && list.length > 0 && (
              <button className="pill small ghost" onClick={() => emptyBin(scope.folderId ? { folderId: scope.folderId } : { role: binRole })}>
                {binRole === 'spam' ? t.fm_emptyJunk : t.fm_emptyTrash}
              </button>
            )}
            <button className="tool" title={`${t.compose} (C)`} onClick={() => setCompose({ kind: 'new', accountId: scope.accountId === 'all' ? undefined : scope.accountId })}><Icon name="compose" /></button>
          </div>
          {(searchOpen || query) && (
            <label className="search search-cap">
              <Icon name="search" size={15} />
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.search}
                onBlur={() => { if (!query.trim()) setSearchOpen(false) }} />
              <button title={t.cancel} onMouseDown={(e) => e.preventDefault()} onClick={closeSearch}><Icon name="close" size={13} /></button>
            </label>
          )}
          {!results && !searchOpen && (<>
            <div className="filters">
              <div className="pill-group">
              <button className="tool small" title={`${t.search} (/)`} onClick={openSearch}><Icon name="search" size={15} /></button>
              <span className="sep" />
              {FILTERS.map(([f, icon, label]) => (
                <button key={f} className={`tool small ${scope.filter === f ? 'on-filter' : ''}`} title={t[label]}
                  onClick={() => setScope((s) => ({ ...s, filter: s.filter === f ? undefined : f }))}><Icon name={icon} size={15} filled={f === 'flagged' && scope.filter === f} /></button>
              ))}
              <button className={`tool small ${scope.day ? 'on-filter' : ''}`} title={t.fl_day}
                onClick={() => { setDayPick(dayKey(scope.day || Date.now())); setPop(pop === 'day' ? null : 'day') }}><Icon name="calendar" size={15} /></button>
              <button className={`tool small ${scope.sort && scope.sort !== 'date' || scope.oldest ? 'on-filter' : ''}`} title={t.fl_sort}
                onClick={() => setPop(pop === 'sort' ? null : 'sort')}><Icon name="sort" size={15} /></button>
              <button className={`tool small ${scope.person ? 'on-filter' : ''}`} disabled={!scope.person && !current}
                title={scope.person ? `${t.fl_personOff}` : current ? `${t.fl_person} ${current.fromName || current.fromEmail}` : t.fl_personHint}
                onClick={() => setScope((s) => ({ ...s, person: s.person ? undefined : current?.fromEmail }))}><Icon name="target" size={15} /></button>
              {/* several picked (Alex, 29 Oct): Delete right in the bar */}
              {chosen.length > 1 && (<>
                <span className="sep" />
                <button className="tool small danger-tool" title={`${t.trashIt} (${chosen.length})`} onClick={() => act(chosen, 'trash')}><Icon name="trash" size={15} /></button>
              </>)}
              </div>
              <span className="grow" />
              {searching && <span className="muted small">{t.searchingServers}</span>}
              {pop === 'day' && (
                <div className="pop day-pop" onKeyDown={(e) => { if (e.key === 'Escape') setPop(null) }}>
                  <input type="date" value={dayPick} autoFocus onChange={(e) => setDayPick(e.target.value)} />
                  <div className="row end">
                    <button className="pill small ghost" onClick={() => { setScope((s) => ({ ...s, day: undefined })); setPop(null) }}>{t.fl_none}</button>
                    <button className="pill small primary" disabled={!dayPick} onClick={() => {
                      const [y, mo, d] = dayPick.split('-').map(Number)
                      setScope((s) => ({ ...s, day: new Date(y, mo - 1, d).getTime() })); setPop(null)
                    }}>{t.fl_apply}</button>
                  </div>
                </div>
              )}
              {pop === 'sort' && (
                <div className="pop sort-pop">
                  {SORTS.map(([k, label]) => (
                    <button key={k} className={(scope.sort || 'date') === k ? 'on' : ''} onClick={() => { setScope((s) => ({ ...s, sort: k === 'date' ? undefined : k })); setPop(null) }}>
                      <span className="check">{(scope.sort || 'date') === k ? '✓' : ''}</span>{t[label]}</button>
                  ))}
                  <hr />
                  <button className={!scope.oldest ? 'on' : ''} onClick={() => { setScope((s) => ({ ...s, oldest: undefined })); setPop(null) }}><span className="check">{!scope.oldest ? '✓' : ''}</span>{t.so_desc}</button>
                  <button className={scope.oldest ? 'on' : ''} onClick={() => { setScope((s) => ({ ...s, oldest: true })); setPop(null) }}><span className="check">{scope.oldest ? '✓' : ''}</span>{t.so_asc}</button>
                </div>
              )}
            </div>
            {(scope.person || scope.day) && (
              <div className="filter-chips">
                {scope.person && <button className="chip on-chip" onClick={() => setScope((s) => ({ ...s, person: undefined }))}><Icon name="target" size={12} /> {scope.person} <Icon name="close" size={11} /></button>}
                {scope.day && <button className="chip on-chip" onClick={() => setScope((s) => ({ ...s, day: undefined }))}><Icon name="calendar" size={12} /> {new Date(scope.day).toLocaleDateString()} <Icon name="close" size={11} /></button>}
              </div>
            )}
         </>)}
          {failed.map((o) => (
            <div key={o.id} className="outbox-bar failed">
              <span className="grow ellipsis"><b>{t.sendFailed}:</b> {o.subject || t.noSubject} ({o.error})</span>
              <button className="pill small" onClick={() => api.retrySend(o.id)}>{t.retry}</button>
              <button className="pill small ghost" onClick={async () => { const d = await api.cancelSend(o.id); if (d) setCompose({ kind: 'draft', draft: d }) }}>{t.edit}</button>
            </div>
          ))}
          {waiting.length > 0 && <div className="outbox-bar"><Icon name="sent" size={14} /> <span>{waiting.length} {t.outboxWaiting}</span></div>}
          {later.length > 0 && (
            <button className="outbox-bar as-button" onClick={() => setShowScheduled((v) => !v)}>
              <Icon name="clock" size={14} /> <span className="grow">{later.length} {t.scheduled}</span><Icon name="chevron" size={13} />
            </button>
          )}
          {showScheduled && later.map((o) => (
            <div key={o.id} className="outbox-bar">
              <span className="grow ellipsis"><b className="plain">{short(o.sendAt)}</b> · {o.subject || t.noSubject}</span>
              <button className="pill small" onClick={() => api.retrySend(o.id)}>{t.sendNow}</button>
              <button className="pill small ghost" onClick={async () => { const d = await api.cancelSend(o.id); if (d) setCompose({ kind: 'draft', draft: d }) }}>{t.edit}</button>
            </div>
          ))}
        </div>
        {/* pull down to refresh: the circle fills as the list is pulled, spins while mail is being fetched */}
        <div className={`pull-refresh${pull >= PULL_AT ? ' ready' : ''}${pulled && !pull ? ' busy' : ''}`} style={{ height: pull ? Math.min(pull, 80) : pulled ? 44 : 0 }} aria-hidden="true">
          <span style={{ transform: `rotate(${pull * 3}deg)`, opacity: pulled && !pull ? 1 : Math.min(1, pull / PULL_AT) }}><Icon name="refresh" size={18} /></span>
        </div>
        {/* a new folder, account or filter brings its rows in again, one after another (RoarMe's stagger) */}
        <div className="rows" key={`${scope.accountId}|${scope.role || ''}|${scope.folderId || ''}|${scope.filter || ''}|${scope.person || ''}|${results ? 'found' : ''}`}>
          {list.map((r) => (
            <Row key={keyOf(r)} r={r} pic={accounts.find((a) => a.email.toLowerCase() === r.fromEmail)?.avatar || senderPic(r.fromEmail)} on={selected.includes(keyOf(r))} acc={scope.accountId === 'all' && prefs.accountColours ? accountOf(r.accountId) : undefined}
              prefs={prefs} onClick={(e) => click(r, e)} onMenu={(e) => rowMenu(r, e)} onAct={(a) => act([r], a)} onSnooze={() => openSnooze([r])} onMove={() => openMove([r])} multi={selected.length > 1}
              onPick={() => { const k = keyOf(r); setSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k])); setAnchor(k) }}
              onDrag={(e) => startDrag(r, e)} onDragEnd={() => { dragging.current = null; setDropOn('') }}
              onSwipe={(side) => swipe(r, side === 'left' ? prefs.swipeLeft : prefs.swipeRight)} />
          ))}
          {!list.length && (
            <div className="list-empty">
              {results ? t.noResults : (scope.role === 'inbox' && !scope.folderId) ? <><b className="zero">ROAR</b><span>{t.inboxZero}</span></> : t.empty}
            </div>
          )}
        </div>
        {/* only when an account has trouble (the shortcuts line is gone: Alex, 21 Oct 2026; they are in Settings > Shortcuts) */}
        {accounts.some((a) => a.state === 'offline' || a.state === 'error') && (
          <div className="list-foot muted small">
            {accounts.filter((a) => a.state === 'offline' || a.state === 'error').map((a) => (
              <span key={a.id} className={`state ${a.state}`}>{a.email}: {t[a.state as Key] || a.state}</span>
            ))}
          </div>
        )}
      </section>
      <Splitter col="list" width={widths.list} onChange={setWidth} title={t.resizeCol} />

      {chosen.length > 1 ? (
        <section className="viewer empty multi">
          <div className="stack-count">{chosen.length}</div>
          <p className="muted">{t.messages} {t.selected}</p>
          <div className="row">
            <button className="pill" onClick={() => act(chosen, 'archive')}><Icon name="archive" size={15} /> {t.archiveIt}</button>
            <button className="pill" onClick={() => act(chosen, 'trash')}><Icon name="trash" size={15} /> {t.trashIt}</button>
            <button className="pill" onClick={() => openMove(chosen)}><Icon name="folder" size={15} /> {t.moveTo}</button>
            <button className="pill" onClick={() => openSnooze(chosen)}><Icon name="clock" size={15} /> {t.snoozeIt}</button>
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
          onRoar={(kind, m) => setRoar({ kind, m })}
          onRule={(m) => {
            setSettingsAt({ page: 'rules', rule: blankRule({ name: m.fromName || m.fromEmail, conditions: [{ field: 'from', value: m.fromEmail }] }) })
            setSettingsOpen(true)
          }}
          onAct={(a) => { if (!current) return; if (a === 'move') openMove([current]); else if (a === 'snooze') openSnooze([current]); else act([current], a) }} />
      )}

      {workOpen && <WorkPanel onClose={() => setWorkOpen(false)} />}
      {roar?.kind === 'share' && <ShareSheet message={roar.m} onClose={() => setRoar(null)} onDone={(text) => { setRoar(null); flash({ text, ms: 3000 }) }} />}
      {roar?.kind === 'task' && <TaskSheet message={roar.m} onClose={() => setRoar(null)} onDone={(text) => { setRoar(null); flash({ text, ms: 3000 }) }} />}
      {update?.status === 'ready' && (
        <button className="update pill primary" onClick={() => api.update.install()}>{t.updateReady} {update.version} · {t.restart}</button>
      )}
      {folderAsk && <FolderSheet ask={folderAsk} onClose={() => setFolderAsk(null)} onDone={(text) => { setFolderAsk(null); if (text) flash({ text, ms: 3000 }) }} />}
      {adding && <AddAccount first={false} onDone={() => { setAdding(false); loadAccounts() }} onCancel={() => setAdding(false)} />}
      {statsOpen && <StatsSheet accounts={accounts} onClose={() => setStatsOpen(false)}
        onOpen={(accountId, sender) => { setStatsOpen(false); setScope({ accountId, role: 'inbox', person: sender }) }} />}
      {settingsOpen && <SettingsSheet accounts={accounts} start={settingsAt} onAddAccount={() => setAdding(true)} onLook={setPrefs} onClose={() => { setSettingsOpen(false); setSettingsAt(null); api.settings().then((s) => { setPrefs(s); applyLook(s) }) }} />}
      {moving && (
        <MovePicker accountId={moving.accountId} exclude={moving.exclude} onClose={() => setMoving(null)}
          onPick={(fid) => { const targets = list.filter((r) => moving.ids.includes(keyOf(r))); setMoving(null); act(targets, 'move', fid) }} />
      )}
      {snoozing && <TimePicker title={t.snoozeUntil} aside onClose={() => setSnoozing(null)} onPick={(at) => { const keys = snoozing; setSnoozing(null); doSnooze(keys, at) }} />}
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
function Row({ r, pic, on, multi, acc, prefs, onClick, onMenu, onAct, onSnooze, onMove, onPick, onDrag, onDragEnd, onSwipe }: {
  r: MessageRow; pic: string | null; on: boolean; multi: boolean; acc?: Account; prefs: Settings
  onClick: (e: MouseEvent) => void; onMenu: (e: MouseEvent) => void; onAct: (a: Action) => void; onSnooze: () => void; onMove: () => void; onPick: () => void
  onDrag: (e: DragEvent) => void; onDragEnd: () => void; onSwipe: (side: 'left' | 'right') => void
}) {
  const [dx, setDx] = useState(0)
  // a picture that does not load falls back to the initials
  const [badPic, setBadPic] = useState(false)
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
    <div className={`swipe ${dx ? 'moving' : ''}`} onWheel={onWheel} draggable onDragStart={onDrag} onDragEnd={onDragEnd}>
      {dx !== 0 && (
        <div className={`swipe-under ${side} ${armed ? 'armed' : ''} ${dx < 0 ? 'left' : 'right'}`}>
          <Icon name={side === 'archive' ? 'archive' : side === 'trash' ? 'trash' : side === 'flag' ? 'star' : 'dot'} size={18} />
        </div>
      )}
      <div className={`msg ${on ? 'on' : ''} ${r.seen ? '' : 'unread'}`} style={dx ? { transform: `translateX(${dx}px)` } : undefined} onClick={onClick} onContextMenu={onMenu}>
        {/* the picture is also the row's checkbox: a click there adds it to the selection (or takes it out) */}
        <div className={`pick-wrap ${on && multi ? 'picked' : ''} ${prefs.listAvatars ? '' : 'bare'}`} title={t.pickRow}
          onClick={(e) => { e.stopPropagation(); onPick() }}>
          {prefs.listAvatars && (pic && !badPic
            ? <div className="avatar pic" style={{ background: '#fff' }}><img src={pic} alt="" onError={() => setBadPic(true)} /></div>
            : <div className="avatar" style={{ background: tint(r.fromEmail) }}>{initials(r.fromName || r.fromEmail)}</div>)}
          <span className="pick-mark"><Icon name="check" size={14} /></span>
        </div>
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
          {prefs.previewLines > 0 && <div className="snip muted" style={{ WebkitLineClamp: prefs.previewLines }}>{r.snippet}</div>}
        </div>
        {acc && <i className="acc-bar" style={{ background: acc.color }} />}
        <div className="quick" onClick={(e) => e.stopPropagation()}>
          <button title={r.seen ? t.markUnread : t.markRead} onClick={() => onAct(r.seen ? 'unseen' : 'seen')}><Icon name="dot" size={15} filled={!r.seen} /></button>
          <button title={r.flagged ? t.unflag : t.flag} onClick={() => onAct(r.flagged ? 'unflag' : 'flag')}><Icon name="star" size={15} filled={r.flagged} /></button>
          <button title={t.snoozeIt} onClick={() => onSnooze()}><Icon name="clock" size={15} /></button>
          <button title={t.moveTo} onClick={() => onMove()}><Icon name="folder" size={15} /></button>
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

/** the questions a folder's right-click menu asks: a name (new, inside, rename) or a colour of your own */
function FolderSheet({ ask, onClose, onDone }: { ask: { kind: 'new' | 'sub' | 'rename' | 'custom'; folder: Folder }; onClose: () => void; onDone: (text?: string) => void }) {
  const f = ask.folder
  const [name, setName] = useState(ask.kind === 'rename' ? f.name : '')
  const [color, setColor] = useState(f.color || '#d40000')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const title = ask.kind === 'new' ? t.fm_new : ask.kind === 'sub' ? `${t.fm_sub} · ${f.name}` : ask.kind === 'rename' ? t.fm_rename : t.fc_custom
  const go = async () => {
    setBusy(true); setError('')
    try {
      if (ask.kind === 'custom') await api.setFolderColor(f.id, color)
      else if (ask.kind === 'rename') await api.renameFolder(f.id, name)
      else await api.createFolder(f.accountId, ask.kind === 'sub' ? f.id : null, name)
      onDone(ask.kind === 'custom' ? undefined : t.fm_done)
    } catch (e) { setError(clean(e)); setBusy(false) }
  }
  return (
    <div className="sheet-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div className="sheet folder-sheet">
        <h3>{title}</h3>
        {ask.kind === 'custom'
          ? <label className="row">{t.fc_pick}<input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
          : <label>{t.fm_name}<input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) go() }} /></label>}
        {error && <p className="error small">{error}</p>}
        <div className="row end">
          <button className="pill ghost" onClick={onClose}>{t.cancel}</button>
          <button className="pill primary" disabled={busy || (ask.kind !== 'custom' && !name.trim())} onClick={go}>{ask.kind === 'rename' ? t.fm_rename : ask.kind === 'custom' ? t.save : t.fm_create}</button>
        </div>
      </div>
    </div>
  )
}
