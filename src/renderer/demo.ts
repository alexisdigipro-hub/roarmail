// The web demo (themadlions.com/roarmail): the same screens over a MailApi that lives in memory, filled with
// sample mail. Nothing connects anywhere and nothing is kept; it shows the app and how it feels.
import type {
  Account, Action, Address, Draft, Folder, FolderRole, ListScope, MailApi, MailEvent, MessageFull, MessageRow, OutboxItem,
  Settings, Signature,
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

const accounts: Account[] = [
  { id: 'a1', email: 'alex@themadlions.com', displayName: 'Alex', color: '#d40000', provider: 'imap', imapHost: 'linux207.papaki.gr', imapPort: 993, imapTls: 'tls', smtpHost: 'linux207.papaki.gr', smtpPort: 465, smtpTls: 'tls', username: 'alex@themadlions.com', signatureId: 's1', state: 'online' },
  { id: 'a2', email: 'roar.demo@gmail.com', displayName: 'Alex K.', color: '#2f9bff', provider: 'gmail', imapHost: 'imap.gmail.com', imapPort: 993, imapTls: 'tls', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpTls: 'tls', username: 'roar.demo@gmail.com', signatureId: null, state: 'online' },
]

const roles: [FolderRole, string][] = [['inbox', 'INBOX'], ['drafts', 'Drafts'], ['sent', 'Sent'], ['archive', 'Archive'], ['trash', 'Trash']]
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
let settings: Settings = { undoSendSeconds: 5, swipeLeft: 'trash', swipeRight: 'archive', blockTrackers: true, stripTracking: true, lock: false, lockAfter: 15, appearance: 'system' }
const outbox: (OutboxItem & { draft: Draft })[] = []
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
  const inScope = msgs.filter((m) => !pendingHas(m.id) && (scope.folderId ? m.folderId === scope.folderId
    : role(m.folderId) === (scope.role || 'inbox') && (scope.accountId === 'all' || m.accountId === scope.accountId)))
  const groups = new Map<string, DemoMsg[]>()
  for (const m of inScope) groups.set(m.threadId, [...(groups.get(m.threadId) || []), m])
  return [...groups.values()].map((g) => { g.sort((a, b) => b.date - a.date); return row(g[0], g) }).sort((a, b) => b.date - a.date)
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

export function createDemo(): MailApi & { update: any } {
  recount()
  const api: MailApi & { update: any } = {
    platform: 'web',
    autodetect: async (email) => ({ email, displayName: '', username: email, provider: 'imap', imapHost: `mail.${email.split('@')[1] || 'example.com'}`, imapPort: 993, imapTls: 'tls', smtpHost: `mail.${email.split('@')[1] || 'example.com'}`, smtpPort: 465, smtpTls: 'tls' }),
    testAccount: async () => ({ ok: false, error: 'Στο demo δεν συνδέονται λογαριασμοί. Κατέβασε την εφαρμογή για Mac ή Windows. / The demo cannot connect accounts; download the app.' }),
    addAccount: async () => { throw new Error('demo') },
    updateAccount: async (id, patch) => { const a = accounts.find((x) => x.id === id); if (a) Object.assign(a, patch.displayName != null ? { displayName: patch.displayName } : {}, patch.color ? { color: patch.color } : {}, patch.signatureId !== undefined ? { signatureId: patch.signatureId } : {}); emit({ type: 'accounts' }) },
    removeAccount: async () => {},
    accounts: async () => accounts.map((a) => ({ ...a })),
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
    undo: async (token) => { const p = pending.get(token); if (!p) return false; clearTimeout(p.timer); pending.delete(token); recount(); changed(); return true },
    allowImages: async () => {},
    unsubscribe: async () => 'done',
    blockSender: async () => {},
    blockedSenders: async () => [],
    lockState: async () => ({ available: false, enabled: false, locked: false, method: 'none' }),
    unlock: async () => true,
    lockNow: async () => {},
    send: async (draft) => {
      const id = uid()
      const item = { id, to: draft.to, subject: draft.subject, sendAt: Date.now() + settings.undoSendSeconds * 1000, status: 'queued' as const, draft }
      outbox.push(item)
      setTimeout(() => deliver(item), settings.undoSendSeconds * 1000)
      emit({ type: 'outbox' })
      return id
    },
    cancelSend: async (id) => { const i = outbox.findIndex((o) => o.id === id); if (i < 0) return null; const [o] = outbox.splice(i, 1); emit({ type: 'outbox' }); return o.draft },
    retrySend: async () => {},
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
    pickFiles: async () => [],
    openAttachment: async () => { alert('Demo: τα συνημμένα ανοίγουν στην εφαρμογή. / Attachments open in the app.') },
    saveAttachment: async () => { alert('Demo: τα συνημμένα αποθηκεύονται στην εφαρμογή. / Attachments are saved in the app.') },
    openExternal: async (url) => { window.open(url, '_blank', 'noopener') },
    refresh: async () => {},
    on: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    update: { state: async () => ({ status: 'idle', version: '', progress: 0 }), install: async () => false, on: () => () => {} },
  }
  return api
}
