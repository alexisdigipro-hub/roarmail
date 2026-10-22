// The web demo (themadlions.com/roarmail): the same screens over a MailApi that lives in memory, filled with
// sample mail. Nothing connects anywhere and nothing is kept; it shows the app and how it feels.
import { GENERAL_DEFAULTS, LOOK_DEFAULTS } from './look'
import type {
  Account, Action, Address, Draft, Folder, FolderRole, ListScope, MailApi, MailEvent, MessageFull, MessageRow, OutboxItem,
  Settings, Signature, SnoozedItem,
} from '../shared/api'

interface DemoMsg {
  id: string; accountId: string; folderId: string; threadId: string
  fromName: string; fromEmail: string; to: Address[]; cc: Address[]
  subject: string; html: string; date: number; seen: boolean; flagged: boolean; answered: boolean
  attachments?: { filename: string; mime: string; size: number }[]
  listUnsubscribe?: string; oneClick?: boolean
  security?: MessageFull['security']
}

const H = 3600e3
const now = Date.now()
const uid = () => Math.random().toString(36).slice(2, 10)

const extra = { enabled: true, description: '', aliases: [], attachments: 'recent' as const, roles: {}, trashDays: 0, junkDays: 0, unread: 0, avatar: null }
const accounts: Account[] = [
  { id: 'a1', email: 'alex@themadlions.com', displayName: 'Alex', color: '#d40000', provider: 'imap', imapHost: 'linux207.papaki.gr', imapPort: 993, imapTls: 'tls', smtpHost: 'linux207.papaki.gr', smtpPort: 465, smtpTls: 'tls', username: 'alex@themadlions.com', signatureId: 's1', state: 'online', ...extra },
  { id: 'a2', email: 'roar.demo@gmail.com', displayName: 'Alex K.', color: '#2f9bff', provider: 'gmail', imapHost: 'imap.gmail.com', imapPort: 993, imapTls: 'tls', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpTls: 'tls', username: 'roar.demo@gmail.com', signatureId: null, state: 'online', ...extra },
]

const roles: [FolderRole, string][] = [['inbox', 'INBOX'], ['snoozed', 'Snoozed'], ['drafts', 'Drafts'], ['sent', 'Sent'], ['archive', 'Archive'], ['trash', 'Trash']]
const folders: Folder[] = accounts.flatMap((a) => [
  ...roles.map(([role, path]) => ({ id: `${a.id}-${role}`, accountId: a.id, path, name: path, role, unread: 0, total: 0, depth: 0 })),
  { id: `${a.id}-projects`, accountId: a.id, path: 'Projects', name: 'Projects', role: null, unread: 0, total: 0, depth: 0 },
])

const me: Address = { name: 'Alex', address: 'alex@themadlions.com' }
const p = (s: string) => `<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;color:#1a1a1a">${s}</div>`

const msgs: DemoMsg[] = [
  { id: 'm1', accountId: 'a1', folderId: 'a1-inbox', threadId: 't1', fromName: 'Μαρία Παπαδοπούλου', fromEmail: 'maria@studio-north.gr', to: [me], cc: [],
    subject: 'Γύρισμα Παρασκευής', date: now - 26 * H, seen: true, flagged: false, answered: true,
    html: p('<p>Γεια σου Alex,</p><p>Επιβεβαιώνω το γύρισμα την Παρασκευή στις 08:00 στο στούντιο. Χρειαζόμαστε και δεύτερη κάμερα;</p><p>Μαρία</p>') },
  { id: 'm2', accountId: 'a1', folderId: 'a1-sent', threadId: 't1', fromName: 'Alex', fromEmail: 'alex@themadlions.com', to: [{ name: 'Μαρία Παπαδοπούλου', address: 'maria@studio-north.gr' }], cc: [],
    subject: 'Re: Γύρισμα Παρασκευής', date: now - 20 * H, seen: true, flagged: false, answered: false,
    html: p('<p>Ναι, δεύτερη κάμερα σίγουρα. Θα στείλω το call sheet από το Roardino.</p><p>Alex</p>') },
  { id: 'm3', accountId: 'a1', folderId: 'a1-inbox', threadId: 't1', fromName: 'Μαρία Παπαδοπούλου', fromEmail: 'maria@studio-north.gr', to: [me], cc: [{ name: 'Νίκος', address: 'nikos@studio-north.gr' }],
    subject: 'Re: Γύρισμα Παρασκευής', date: now - 0.4 * H, seen: false, flagged: true, answered: false,
    html: p('<p>Τέλεια. Ο Νίκος φέρνει τη δεύτερη κάμερα και τα φώτα. Σου επισυνάπτω την κάτοψη του χώρου.</p><p>Μαρία</p>'),
    attachments: [{ filename: 'kato4i-studio.pdf', mime: 'application/pdf', size: 482000 }] },
  { id: 'm4', accountId: 'a1', folderId: 'a1-inbox', threadId: 't2', fromName: 'Νίκος Κ.', fromEmail: 'nikos@lighthouse-films.gr', to: [me], cc: [],
    subject: 'Τιμολόγιο Οκτωβρίου', date: now - 3 * H, seen: false, flagged: false, answered: false,
    html: p('<p>Καλησπέρα,</p><p>επισυνάπτω το τιμολόγιο για την παραγωγή του Οκτωβρίου. Ευχαριστώ!</p>'),
    attachments: [{ filename: 'timologio-10-2026.pdf', mime: 'application/pdf', size: 128000 }] },
  { id: 'm5', accountId: 'a1', folderId: 'a1-inbox', threadId: 't3', fromName: 'Film Gear Weekly', fromEmail: 'news@filmgear-weekly.com', to: [me], cc: [],
    subject: 'Οι 10 καλύτεροι φακοί του 2026', date: now - 7 * H, seen: true, flagged: false, answered: false,
    listUnsubscribe: '<https://filmgear-weekly.com/unsub?u=123>', oneClick: true,
    html: `<div style="font:15px/1.6 sans-serif;color:#1a1a1a;max-width:560px;margin:auto"><h2 style="margin:0 0 8px">Οι 10 καλύτεροι φακοί του 2026</h2>
      <p>Από τους cinema primes μέχρι τα νέα anamorphic, δες τι αξίζει φέτος.</p>
      <p><a href="https://filmgear-weekly.com/lenses-2026?utm_source=newsletter&utm_medium=email&utm_campaign=oct">Διάβασε το άρθρο</a></p>
      <img src="https://u123.ct.sendgrid.net/wf/open?upn=demo" width="1" height="1" alt=""></div>` },
  { id: 'm6', accountId: 'a1', folderId: 'a1-inbox', threadId: 't4', fromName: 'support@paypal.com', fromEmail: 'security@paypa1-alerts.net', to: [me], cc: [],
    subject: 'Ο λογαριασμός σας έχει περιοριστεί', date: now - 9 * H, seen: false, flagged: false, answered: false,
    security: { auth: 'fail', warnings: ['auth', 'nameSpoof'] },
    html: p('<p>Εντοπίσαμε ασυνήθιστη δραστηριότητα. Επιβεβαιώστε τα στοιχεία σας εντός 24 ωρών:</p><p><a href="https://paypa1-alerts.net/verify">www.paypal.com/verify</a></p>') },
  { id: 'm7', accountId: 'a2', folderId: 'a2-inbox', threadId: 't5', fromName: 'Ελένη Δ.', fromEmail: 'eleni.d@gmail.com', to: [{ address: 'roar.demo@gmail.com' }], cc: [],
    subject: 'Φωτογραφίες από το set', date: now - 1.5 * H, seen: false, flagged: false, answered: false,
    html: p('<p>Σου έστειλα τις φωτογραφίες από το set, πες μου ποιες κρατάμε για το social.</p>') },
  { id: 'm8', accountId: 'a2', folderId: 'a2-inbox', threadId: 't6', fromName: 'RoarMe', fromEmail: 'hello@roarme.app', to: [{ address: 'roar.demo@gmail.com' }], cc: [],
    subject: 'Καλώς ήρθες στο RoarMe', date: now - 50 * H, seen: true, flagged: false, answered: false,
    html: p('<p>Ο λογαριασμός σου είναι έτοιμος. Μίλα με την ομάδα σου, μοιράσου αρχεία και φτιάξε ordino με το Roardino.</p>') },
  { id: 'm9', accountId: 'a1', folderId: 'a1-archive', threadId: 't7', fromName: 'Γιώργος Σ.', fromEmail: 'giorgos@agency.gr', to: [me], cc: [],
    subject: 'Brief για το νέο spot', date: now - 120 * H, seen: true, flagged: false, answered: true,
    html: p('<p>Σου στέλνω το brief για το spot των 30 δευτερολέπτων. Τα λέμε τη Δευτέρα.</p>') },
]

const sigs: Signature[] = [{ id: 's1', name: 'THEMADLIONS', html: '<b>Alex Konstantinidis</b><br>THEMADLIONS · themadlions.com' }]
let settings: Settings = { ...LOOK_DEFAULTS, ...GENERAL_DEFAULTS, undoSendSeconds: 5, swipeLeft: 'trash', swipeRight: 'archive', blockTrackers: true, stripTracking: true, lock: false, lockAfter: 15, appearance: 'system', runAtLogin: false }
const outbox: (OutboxItem & { draft: Draft })[] = []
const snoozes: (SnoozedItem & { msgId: string; origin: string; timer?: ReturnType<typeof setTimeout> })[] = []
const pending = new Map<string, { ids: string[]; from: Map<string, string>; timer: ReturnType<typeof setTimeout> }>()
const listeners = new Set<(e: MailEvent) => void>()
const emit = (e: MailEvent) => listeners.forEach((l) => l(e))
const changed = (accountId = 'a1') => { emit({ type: 'messages', accountId }); emit({ type: 'folders', accountId }); emit({ type: 'messages', accountId: accountId === 'a1' ? 'a2' : 'a1' }) }

const role = (folderId: string) => folders.find((f) => f.id === folderId)?.role
const snippet = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
const row = (m: DemoMsg, group?: DemoMsg[]): MessageRow => ({
  id: m.id, accountId: m.accountId, threadId: m.threadId, fromName: m.fromName, fromEmail: m.fromEmail, subject: m.subject,
  snippet: snippet(m.html), date: m.date, seen: group ? group.every((x) => x.seen) : m.seen, flagged: group ? group.some((x) => x.flagged) : m.flagged,
  answered: m.answered, hasAttachments: (group || [m]).some((x) => x.attachments?.length), ids: (group || [m]).map((x) => x.id), count: (group || [m]).length,
})

function recount() {
  for (const f of folders) {
    const inF = msgs.filter((m) => m.folderId === f.id && !pendingHas(m.id))
    f.total = inF.length; f.unread = inF.filter((m) => !m.seen).length
  }
}
const pendingHas = (id: string) => [...pending.values()].some((p) => p.ids.includes(id))

function list(scope: ListScope): MessageRow[] {
  const who = scope.person?.toLowerCase()
  const dayFrom = scope.day ? new Date(scope.day).setHours(0, 0, 0, 0) : 0
  const inScope = msgs.filter((m) => !pendingHas(m.id) && (who
    ? (m.fromEmail === who || [...m.to, ...m.cc].some((a) => a.address.toLowerCase() === who)) && (scope.accountId === 'all' || m.accountId === scope.accountId) && role(m.folderId) !== 'trash'
    : scope.folderId ? m.folderId === scope.folderId
    : role(m.folderId) === (scope.role || 'inbox') && (scope.accountId === 'all' || m.accountId === scope.accountId))
    && (!dayFrom || (m.date >= dayFrom && m.date < dayFrom + 864e5)))
  const groups = new Map<string, DemoMsg[]>()
  for (const m of inScope) groups.set(m.threadId, [...(groups.get(m.threadId) || []), m])
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const keep = (r: MessageRow) => scope.filter === 'unread' ? !r.seen : scope.filter === 'flagged' ? r.flagged
    : scope.filter === 'attachments' ? r.hasAttachments : scope.filter === 'today' ? r.date >= today.getTime() : scope.filter === 'threads' ? r.count > 1 : true
  const by = (a: MessageRow, b: MessageRow) => scope.sort === 'sender' ? (a.fromName || a.fromEmail).localeCompare(b.fromName || b.fromEmail)
    : scope.sort === 'subject' ? a.subject.localeCompare(b.subject) : scope.sort === 'unread' ? Number(a.seen) - Number(b.seen)
    : scope.sort === 'attachments' ? Number(b.hasAttachments) - Number(a.hasAttachments) : scope.sort === 'account' ? a.accountId.localeCompare(b.accountId) : b.date - a.date
  return [...groups.values()].map((g) => { g.sort((a, b) => b.date - a.date); return row(g[0], g) }).filter(keep)
    .sort((a, b) => (scope.oldest ? -by(a, b) : by(a, b)))
}

function full(m: DemoMsg): MessageFull {
  return {
    ...row(m), to: m.to, cc: m.cc, messageId: `<${m.id}@demo>`, html: m.html,
    attachments: (m.attachments || []).map((a, i) => ({ id: `${m.id}:${i}`, filename: a.filename, mime: a.mime, size: a.size, inline: false })),
    inlineImages: {}, imagesAllowed: false, listUnsubscribe: m.listUnsubscribe, oneClickUnsubscribe: m.oneClick,
    security: m.security || { auth: 'pass', warnings: [] }, senderBlocked: false,
  }
}

function deliver(item: OutboxItem & { draft: Draft }) {
  const i = outbox.indexOf(item)
  if (i < 0) return
  outbox.splice(i, 1)
  const d = item.draft
  const acc = accounts.find((a) => a.id === d.accountId) || accounts[0]
  const reply = msgs.find((m) => m.id === d.replyToMessageId)
  msgs.push({
    id: uid(), accountId: acc.id, folderId: `${acc.id}-sent`, threadId: reply?.threadId || uid(), fromName: acc.displayName, fromEmail: acc.email,
    to: d.to.split(',').map((x) => x.trim()).filter(Boolean).map((address) => ({ address })), cc: [], subject: d.subject || '', html: d.html,
    date: Date.now(), seen: true, flagged: false, answered: false,
  })
  if (reply) reply.answered = true
  emit({ type: 'outbox' }); changed(acc.id)
}

const demoPeople = [{ id: 'u2', name: 'Μαρία Παπαδοπούλου', username: 'maria' }, { id: 'u3', name: 'Νίκος Κ.', username: 'nikos' }, { id: 'u4', name: 'Ελένη Δ.', username: 'eleni' }]
const demoSizes: Record<string, number> = { 'Demo/Elysium_trailer_ProRes.mov': 1.84e9 }
const demoRooms = [
  { id: 'r1', kind: 'direct', title: 'Μαρία Παπαδοπούλου', members: [demoPeople[0]], unread: 2 },
  { id: 'r2', kind: 'group', title: 'Dream of Elysium · crew', members: demoPeople, unread: 5 },
  { id: 'r3', kind: 'direct', title: 'Νίκος Κ.', members: [demoPeople[1]], unread: 0 },
]
const demoTasks: import('../shared/api').RoarTask[] = [
  { id: 't1', title: 'Call sheet Παρασκευής', notes: '', due: new Date(Date.now() + 24 * H).toISOString().slice(0, 10), priority: 'high', status: 'open', mine: true },
  { id: 't2', title: 'Κάτοψη στούντιο στο συνεργείο', notes: '', due: null, priority: 'normal', status: 'pending', mine: true, from: 'Μαρία Παπαδοπούλου' },
]

function wake(s: (typeof snoozes)[number]) {
  const i = snoozes.indexOf(s)
  if (i < 0) return
  snoozes.splice(i, 1)
  if (s.timer) clearTimeout(s.timer)
  const m = msgs.find((x) => x.id === s.msgId)
  if (m) { m.folderId = s.origin; m.seen = false }
  recount(); changed(s.accountId)
}

export function createDemo(): MailApi & { update: any } {
  recount()
  const api: MailApi & { update: any } = {
    platform: 'web',
    autodetect: async (email) => ({ email, displayName: '', username: email, provider: 'imap', imapHost: `mail.${email.split('@')[1] || 'example.com'}`, imapPort: 993, imapTls: 'tls', smtpHost: `mail.${email.split('@')[1] || 'example.com'}`, smtpPort: 465, smtpTls: 'tls' }),
    testAccount: async () => ({ ok: false, error: 'Στο demo δεν συνδέονται λογαριασμοί. Κατέβασε την εφαρμογή για Mac ή Windows. / The demo cannot connect accounts; download the app.' }),
    addAccount: async () => { throw new Error('demo') },
    updateAccount: async (id, patch) => { const a = accounts.find((x) => x.id === id); if (a) Object.assign(a, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))); emit({ type: 'accounts' }) },
    allAccounts: async () => { recount(); return accounts.map((a) => ({ ...a, unread: folders.find((f) => f.accountId === a.id && f.role === 'inbox')?.unread || 0 })) },
    updateServer: async () => ({ ok: false, error: 'Στο demo δεν αλλάζουν οι servers. / The demo cannot change servers.' }),
    addAlias: async (id, email, name) => { const a = accounts.find((x) => x.id === id); if (a) a.aliases = [...a.aliases, { id: uid(), email, name }]; emit({ type: 'accounts' }) },
    removeAlias: async (aid) => { for (const a of accounts) a.aliases = a.aliases.filter((x) => x.id !== aid); emit({ type: 'accounts' }) },
    serverFolders: async (id) => folders.filter((f) => f.accountId === id && f.role !== 'inbox' && f.role !== 'snoozed').map((f) => ({ path: f.path, name: f.name })),
    searchOnline: async (q, a) => api.search(q, a),
    pickAvatar: async () => false,
    emojiPanel: async () => {},
    folderMenu: async () => null,
    createFolder: async (accountId, parentId, name) => { const p = folders.find((f) => f.id === parentId); folders.push({ id: uid(), accountId, path: p ? `${p.path}/${name}` : name, name, role: null, unread: 0, total: 0, depth: p ? p.depth + 1 : 0 }); emit({ type: 'folders', accountId }) },
    renameFolder: async (id, name) => { const f = folders.find((x) => x.id === id); if (f) { f.name = name; emit({ type: 'folders', accountId: f.accountId }) } },
    deleteFolder: async (id) => { const i = folders.findIndex((x) => x.id === id); if (i >= 0) { const a = folders[i].accountId; folders.splice(i, 1); emit({ type: 'folders', accountId: a }) } },
    setFolderColor: async (id, color) => { const f = folders.find((x) => x.id === id); if (f) { f.color = color; emit({ type: 'folders', accountId: f.accountId }) } },
    hideFolder: async () => {},
    hiddenFolders: async () => [],
    markFolderRead: async (id) => { for (const m of msgs) if (m.folderId === id) m.seen = true; recount(); const f = folders.find((x) => x.id === id); if (f) changed(f.accountId) },
    syncFolderAll: async () => 0,
    // the demo shows company icons straight from Google's icon service (the app keeps them on the computer)
    senderIcons: async (emails) => Object.fromEntries(emails.map((e) => { const d = e.split('@')[1] || ''; return [e, /gmail|outlook|icloud|yahoo/.test(d) || !d ? null : `https://www.google.com/s2/favicons?domain=${d}&sz=128`] })),
    unifiedFolders: async () => {
      recount()
      const order: FolderRole[] = ['inbox', 'snoozed', 'drafts', 'sent', 'archive', 'trash']
      return order.map((role) => {
        const fs = folders.filter((f) => f.role === role)
        return { id: `all:${role}`, accountId: 'all', path: role, name: role, role, unread: fs.reduce((n, f) => n + f.unread, 0), total: fs.reduce((n, f) => n + f.total, 0), depth: 0 }
      })
    },
    resetSettings: async () => { settings = { ...LOOK_DEFAULTS, ...GENERAL_DEFAULTS, undoSendSeconds: 5, swipeLeft: 'trash', swipeRight: 'archive', blockTrackers: true, stripTracking: true, lock: false, lockAfter: 15, appearance: 'system', runAtLogin: false } },
    clearCache: async () => 0,
    isDefaultMail: async () => false,
    makeDefaultMail: async () => false,
    pickFolder: async () => null,
    removeAccount: async () => {},
    accounts: async () => (await api.allAccounts()).filter((a) => a.enabled),
    folders: async (accountId) => { recount(); return folders.filter((f) => f.accountId === accountId).map((f) => ({ ...f })) },
    messages: async (scope) => list(scope),
    thread: async (key) => msgs.filter((m) => (m.threadId === key || m.id === key) && !pendingHas(m.id)).sort((a, b) => a.date - b.date).map((m) => row(m)),
    message: async (id) => { const m = msgs.find((x) => x.id === id); if (!m) throw new Error('not found'); if (!m.seen) { m.seen = true; recount(); setTimeout(() => changed(m.accountId), 0) } return full(m) },
    search: async (q, accountId) => {
      const t = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      const n = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      return msgs.filter((m) => (!accountId || m.accountId === accountId) && !pendingHas(m.id) && t.split(/\s+/).every((w) => n(`${m.subject} ${m.fromName} ${m.fromEmail} ${snippet(m.html)}`).includes(w)))
        .sort((a, b) => b.date - a.date).map((m) => ({ ...row(m), threadId: null }))
    },
    contacts: async (q) => {
      const all = new Map<string, Address>()
      for (const m of msgs) all.set(m.fromEmail, { name: m.fromName, address: m.fromEmail })
      return [...all.values()].filter((a) => `${a.name} ${a.address}`.toLowerCase().includes(q.toLowerCase())).slice(0, 6)
    },
    act: async (ids: string[], action: Action, target?: string) => {
      const sel = msgs.filter((m) => ids.includes(m.id))
      if (action === 'seen' || action === 'unseen') sel.forEach((m) => { m.seen = action === 'seen' })
      else if (action === 'flag' || action === 'unflag') sel.forEach((m) => { m.flagged = action === 'flag' })
      else {
        const token = uid()
        const from = new Map(sel.map((m) => [m.id, m.folderId]))
        const timer = setTimeout(() => {
          for (const m of sel) {
            const dest = action === 'move' ? target! : `${m.accountId}-${action === 'archive' ? 'archive' : 'trash'}`
            if (role(m.folderId) === 'trash' && action === 'trash') msgs.splice(msgs.indexOf(m), 1)
            else m.folderId = dest
          }
          pending.delete(token); recount(); changed(sel[0]?.accountId)
        }, 5000)
        pending.set(token, { ids, from, timer })
        recount(); changed(sel[0]?.accountId)
        return token
      }
      recount(); changed(sel[0]?.accountId)
      return null
    },
    snooze: async (ids, until) => {
      const sel = msgs.filter((m) => ids.includes(m.id))
      for (const m of sel) {
        const s: (typeof snoozes)[number] = { id: uid(), accountId: m.accountId, subject: m.subject, fromName: m.fromName, until, msgId: m.id, origin: m.folderId }
        m.folderId = `${m.accountId}-snoozed`
        // in the demo a snooze comes back after a minute at most, to show it
        if (until) s.timer = setTimeout(() => wake(s), Math.min(until - Date.now(), 60e3))
        snoozes.push(s)
      }
      recount(); changed(sel[0]?.accountId)
      return null
    },
    snoozed: async () => snoozes.map(({ msgId, origin, timer, ...s }) => s),
    unsnooze: async (id) => { const s = snoozes.find((x) => x.id === id); if (s) wake(s) },
    undo: async (token) => { const p = pending.get(token); if (!p) return false; clearTimeout(p.timer); pending.delete(token); recount(); changed(); return true },
    allowImages: async () => {},
    unsubscribe: async () => 'done',
    blockSender: async () => {},
    blockedSenders: async () => [],
    lockState: async () => ({ available: false, enabled: false, locked: false, method: 'none' }),
    unlock: async () => true,
    lockNow: async () => {},
    send: async (draft, opts) => {
      const id = uid()
      const scheduled = !!opts?.at && opts.at > Date.now() + 30e3
      const at = scheduled ? opts!.at! : Date.now() + settings.undoSendSeconds * 1000
      const item = { id, to: draft.to, subject: draft.subject, sendAt: at, status: 'queued' as const, scheduled, draft }
      outbox.push(item)
      setTimeout(() => deliver(item), Math.min(at - Date.now(), 2 ** 31 - 1))
      emit({ type: 'outbox' })
      return id
    },
    cancelSend: async (id) => { const i = outbox.findIndex((o) => o.id === id); if (i < 0) return null; const [o] = outbox.splice(i, 1); emit({ type: 'outbox' }); return o.draft },
    retrySend: async (id) => { const o = outbox.find((x) => x.id === id); if (o) deliver(o) },
    outbox: async () => outbox.map(({ draft, ...o }) => o),
    saveDraft: async (d, toServer) => {
      const id = d.id || uid()
      if (toServer) {
        const acc = accounts.find((a) => a.id === d.accountId) || accounts[0]
        const old = msgs.findIndex((m) => m.id === d.replacesMessageId)
        if (old >= 0) msgs.splice(old, 1)
        msgs.push({ id, accountId: acc.id, folderId: `${acc.id}-drafts`, threadId: uid(), fromName: acc.displayName, fromEmail: acc.email,
          to: d.to.split(',').filter(Boolean).map((address) => ({ address: address.trim() })), cc: [], subject: d.subject, html: d.html, date: Date.now(), seen: true, flagged: false, answered: false })
        recount(); changed(acc.id)
      }
      return id
    },
    discardDraft: async () => {},
    draftFromMessage: async (id) => { const m = msgs.find((x) => x.id === id)!; return { accountId: m.accountId, to: m.to.map((a) => a.address).join(', '), subject: m.subject, html: m.html, text: snippet(m.html), replacesMessageId: id } },
    signatures: async () => sigs.map((s) => ({ ...s })),
    saveSignature: async (s) => { const id = s.id || uid(); const i = sigs.findIndex((x) => x.id === id); const v = { ...s, id }; if (i >= 0) sigs[i] = v; else sigs.push(v); return v },
    deleteSignature: async (id) => { const i = sigs.findIndex((x) => x.id === id); if (i >= 0) sigs.splice(i, 1) },
    settings: async () => ({ ...settings }),
    setSetting: async (k, v) => { settings = { ...settings, [k]: v } },
    // RoarMe, signed in as a sample person with sample chats and tasks
    roarmeStatus: async () => ({ signedIn: true, needsMfa: false, email: 'alex@themadlions.com', me: { id: 'u1', name: 'Alex', username: 'alex' } }),
    roarmeSignIn: async () => ({ signedIn: true, needsMfa: false, email: 'alex@themadlions.com', me: { id: 'u1', name: 'Alex', username: 'alex' } }),
    roarmeVerify: async () => ({ signedIn: true, needsMfa: false, email: 'alex@themadlions.com', me: { id: 'u1', name: 'Alex', username: 'alex' } }),
    roarmeSignOut: async () => {},
    roarmeRooms: async () => demoRooms,
    roarmeContacts: async () => demoPeople,
    roarmeShare: async () => ({ skipped: 0 }),
    roarmeTask: async (x) => { demoTasks.unshift({ id: uid(), title: x.title, notes: x.notes, due: x.due || null, priority: x.priority || 'normal', status: x.assignee ? 'pending' : 'open', mine: !x.assignee, to: demoPeople.find((p) => p.id === x.assignee)?.name }) },
    roarmeTaskStatus: async (id, status) => { const i = demoTasks.findIndex((x) => x.id === id); if (i >= 0) { if (status === 'done') demoTasks.splice(i, 1); else demoTasks[i].status = status } },
    roarmeWork: async () => ({ tasks: demoTasks.map((x) => ({ ...x })), events: [{ id: 'e1', roomId: 'r2', title: 'Production call', start: new Date(Date.now() + 26 * H).toISOString(), video: true }],
      hub: { linked: true, tasks: [{ id: 'h1', title: 'Color grading v2', due: new Date(Date.now() + 3 * 24 * H).toISOString().slice(0, 10), project: 'Dream of Elysium' }],
        events: [{ id: 'he1', title: 'Shoot day', date: new Date(Date.now() + 4 * 24 * H).toISOString().slice(0, 10), start: '08:00', project: 'Dream of Elysium', color: '#ff9f0a' }] } }),
    roarmeOpen: async () => { window.open('https://alexisdigipro-hub.github.io/roarme/', '_blank', 'noopener') },
    // RoarTransfer in the demo: a sample big film file, "uploaded" in three seconds
    roarmeTransfer: async (file) => {
      for (let i = 1; i <= 10; i++) { await new Promise((ok) => setTimeout(ok, 300)); emit({ type: 'transfer', file, progress: i / 10 }) }
      return { token: uid(), name: file.split('/').pop() || file, size: demoSizes[file] || 0, type: '', expires: new Date(Date.now() + 3 * 24 * H).toISOString() }
    },
    roarmeTransferBundle: async (files, opts) => ({ url: 'https://roartransfer.com/', name: files.length === 1 ? files[0].name : `${files.length} files`, size: files.reduce((a, f) => a + f.size, 0), expires: files[0].expires, files, locked: !!opts.password }),
    roarmeCancelTransfer: async () => {},
    fileSizes: async (files) => files.map((f) => demoSizes[f] ?? 240e3),
    pickFiles: async () => ['Demo/Elysium_trailer_ProRes.mov'],
    openAttachment: async () => { alert('Demo: τα συνημμένα ανοίγουν στην εφαρμογή. / Attachments open in the app.') },
    saveAttachment: async () => { alert('Demo: τα συνημμένα αποθηκεύονται στην εφαρμογή. / Attachments are saved in the app.'); return null },
    openExternal: async (url) => {
      const m = url.match(/^roarmail:\/\/message\/([^?]+)/)
      if (m) { const x = msgs.find((y) => y.id === decodeURIComponent(m[1])); if (x) emit({ type: 'open', messageId: x.threadId || x.id, subject: x.subject }); return }
      window.open(url, '_blank', 'noopener')
    },
    refresh: async () => {},
    on: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    update: { state: async () => ({ status: 'idle', version: '', progress: 0 }), install: async () => false, on: () => () => {} },
  }
  return api
}
