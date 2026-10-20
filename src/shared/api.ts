// The one door between the RoarMail screens and the mail engine. The desktop app implements it over
// Electron IPC (src/preload). A later Hub version can implement the same interface over a server bridge,
// so the screens never change.

export type Tls = 'tls' | 'starttls' | 'none'
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive' | 'all' | 'flagged' | 'snoozed'

export interface ServerConfig {
  email: string
  displayName: string
  username: string
  imapHost: string; imapPort: number; imapTls: Tls
  smtpHost: string; smtpPort: number; smtpTls: Tls
  provider: 'imap' | 'gmail' | 'microsoft' | 'icloud' | 'yahoo'
  /** shown under the password field, e.g. "Gmail needs an app password" */
  hint?: string
}

export interface Account {
  id: string
  email: string
  displayName: string
  color: string
  provider: ServerConfig['provider']
  imapHost: string; imapPort: number; imapTls: Tls
  smtpHost: string; smtpPort: number; smtpTls: Tls
  username: string
  signatureId: string | null
  state: 'connecting' | 'online' | 'offline' | 'error'
  error?: string
}

export interface Folder {
  id: string
  accountId: string
  path: string
  name: string
  role: FolderRole | null
  unread: number
  total: number
  depth: number
}

export interface Address { name?: string; address: string }

/** a row of the list: a whole conversation (its newest message), or a single message in search */
export interface MessageRow {
  id: string
  accountId: string
  threadId: string | null
  fromName: string
  fromEmail: string
  subject: string
  snippet: string
  date: number
  seen: boolean
  flagged: boolean
  answered: boolean
  hasAttachments: boolean
  /** messages of the conversation in this view (what an action on the row applies to) */
  ids: string[]
  count: number
}

export interface Attachment { id: string; filename: string; mime: string; size: number; inline: boolean }

export interface MessageFull extends MessageRow {
  to: Address[]
  cc: Address[]
  replyTo?: string
  messageId?: string
  references?: string
  html?: string
  text?: string
  attachments: Attachment[]
  inlineImages: Record<string, string>
  imagesAllowed: boolean
  listUnsubscribe?: string
  /** the list offers RFC 8058 one-click unsubscribe */
  oneClickUnsubscribe?: boolean
  security: Security
  senderBlocked: boolean
}

/** what the reader warns about: failed sender checks, a display name posing as another address, replies going elsewhere */
export interface Security {
  auth: 'pass' | 'fail' | 'none'
  warnings: ('auth' | 'nameSpoof' | 'replyTo')[]
  replyTo?: string
}

/** what the list shows: one folder, or the unified inbox (accountId 'all') */
export interface ListScope { accountId: string | 'all'; folderId?: string; role?: FolderRole }

export interface Draft {
  /** local draft id, set once saved */
  id?: string
  accountId: string
  to: string
  cc?: string
  bcc?: string
  subject: string
  html: string
  text: string
  inReplyTo?: string
  references?: string
  replyToMessageId?: string
  /** the server draft (a message in Drafts) this one replaces */
  replacesMessageId?: string
  attachments?: string[] // local file paths
}

export interface OutboxItem { id: string; to: string; subject: string; sendAt: number; status: 'queued' | 'sending' | 'failed'; error?: string; scheduled: boolean }

export interface SnoozedItem { id: string; accountId: string; subject: string; fromName: string; until: number | null }

export interface Signature { id: string; name: string; html: string }

export interface Settings {
  undoSendSeconds: number; swipeLeft: SwipeAction; swipeRight: SwipeAction
  /** remove tracking pixels even when images are shown */
  blockTrackers: boolean
  /** take utm_ and similar tracking tags off links before opening them */
  stripTracking: boolean
  /** ask for Touch ID on start, after sleep and after lockAfter minutes away */
  lock: boolean
  lockAfter: number
  /** start with the computer (in the menu bar), so snoozes, scheduled sends and reminders happen on time */
  runAtLogin: boolean
  /** follow the system, or always dark / always light */
  appearance: 'system' | 'dark' | 'light'
  // the look, as in RoarMe's Settings > Appearance
  theme: 'simba' | 'pumba'
  /** a key of ACCENTS, or '' for the theme's own colour */
  accent: string
  font: 'system' | 'inter' | 'manrope' | 'dmsans' | 'grotesk' | 'serif' | 'mono'
  density: 'relaxed' | 'standard' | 'tight'
  /** corner radius in px, 4 to 16 */
  radius: number
  motion: boolean
  focusRings: boolean
  /** glass panels with blur, or solid */
  glass: boolean
  /** reading text size, 0 to 4 */
  textSize: number
  /** power saving: no blur, no animation */
  lite: boolean
}

export interface LockState { available: boolean; enabled: boolean; locked: boolean; method: 'touchid' | 'none' }
export type SwipeAction = 'archive' | 'trash' | 'flag' | 'seen' | 'snooze' | 'none'

// ---------- RoarMe (optional sign-in; see src/main/roarme.ts) ----------
export interface RoarPerson { id: string; name: string; username: string; avatar?: string }
export interface RoarMeStatus { signedIn: boolean; needsMfa: boolean; email?: string; me?: RoarPerson }
export interface RoarRoom { id: string; kind: string; title: string; avatar?: string; members: RoarPerson[]; unread: number }
export interface RoarTask { id: string; title: string; notes: string; due: string | null; priority: 'low' | 'normal' | 'high'; status: 'pending' | 'open' | 'doing' | 'done' | 'declined'; mine: boolean; from?: string; to?: string }
export interface RoarTaskInput { title: string; notes: string; due?: string; priority?: 'low' | 'normal' | 'high'; assignee?: string }
export interface RoarWork {
  tasks: RoarTask[]
  events: { id: string; roomId: string; title: string; start: string; video: boolean }[]
  hub: { linked: boolean; tasks: { id: string; title: string; due?: string; status?: string; project?: string; projectId?: string }[]; events: { id: string; title?: string; typeLabel?: string; date: string; endDate?: string; start?: string; project?: string; location?: string; color?: string }[] }
}

export type Action = 'seen' | 'unseen' | 'flag' | 'unflag' | 'archive' | 'trash' | 'move'

export type MailEvent =
  | { type: 'accounts' }
  | { type: 'folders'; accountId: string }
  | { type: 'messages'; accountId: string }
  | { type: 'newMail'; accountId: string; messageId: string }
  | { type: 'sync'; accountId: string; busy: boolean }
  | { type: 'open'; messageId: string }
  | { type: 'compose'; to: string; subject?: string; body?: string }
  | { type: 'outbox' }
  | { type: 'opFailed'; error: string }
  | { type: 'lock'; locked: boolean }
  | { type: 'roarme' }

export interface MailApi {
  platform: string
  autodetect(email: string): Promise<ServerConfig>
  testAccount(cfg: ServerConfig, password: string): Promise<{ ok: true; cfg: ServerConfig } | { ok: false; error: string }>
  addAccount(cfg: ServerConfig, password: string): Promise<Account>
  updateAccount(id: string, patch: { displayName?: string; color?: string; signatureId?: string | null }): Promise<void>
  removeAccount(id: string): Promise<void>
  accounts(): Promise<Account[]>
  folders(accountId: string): Promise<Folder[]>
  messages(scope: ListScope, before?: number): Promise<MessageRow[]>
  /** the messages of a conversation, oldest first; key is a thread id or a message id */
  thread(key: string): Promise<MessageRow[]>
  message(id: string): Promise<MessageFull>
  search(query: string, accountId?: string): Promise<MessageRow[]>
  contacts(query: string): Promise<Address[]>
  /** archive / trash / move wait a few seconds before reaching the server; the token undoes them */
  act(ids: string[], action: Action, targetFolderId?: string): Promise<string | null>
  undo(token: string): Promise<boolean>
  /** until null = set aside (no wake-up) */
  snooze(ids: string[], until: number | null): Promise<string | null>
  snoozed(): Promise<SnoozedItem[]>
  unsnooze(id: string): Promise<void>
  allowImages(sender: string): Promise<void>
  /** one-click (RFC 8058) when offered, else a mail to the list's address, else the web page */
  unsubscribe(messageId: string): Promise<'done' | 'sent' | 'opened' | 'none'>
  blockSender(email: string, blocked: boolean): Promise<void>
  blockedSenders(): Promise<string[]>
  lockState(): Promise<LockState>
  unlock(): Promise<boolean>
  lockNow(): Promise<void>
  /** at: send later (ms); remindDays: remind me if nobody answers within that many days */
  send(draft: Draft, opts?: { at?: number; remindDays?: number }): Promise<string>
  cancelSend(outboxId: string): Promise<Draft | null>
  retrySend(outboxId: string): Promise<void>
  outbox(): Promise<OutboxItem[]>
  saveDraft(draft: Draft, toServer: boolean): Promise<string>
  discardDraft(id: string): Promise<void>
  draftFromMessage(id: string): Promise<Draft>
  signatures(): Promise<Signature[]>
  saveSignature(sig: Signature): Promise<Signature>
  deleteSignature(id: string): Promise<void>
  settings(): Promise<Settings>
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>
  roarmeStatus(): Promise<RoarMeStatus>
  roarmeSignIn(email: string, password: string): Promise<RoarMeStatus>
  roarmeVerify(code: string): Promise<RoarMeStatus>
  roarmeSignOut(): Promise<void>
  roarmeRooms(): Promise<RoarRoom[]>
  roarmeContacts(): Promise<RoarPerson[]>
  /** an email into a RoarMe chat, with a note and (optionally) its attachments */
  roarmeShare(roomId: string, messageId: string, note: string, withFiles: boolean): Promise<{ skipped: number }>
  roarmeTask(task: RoarTaskInput): Promise<void>
  roarmeTaskStatus(id: string, status: RoarTask['status']): Promise<void>
  roarmeWork(): Promise<RoarWork>
  roarmeOpen(where: { roomId?: string; hub?: 'tasks' | 'calendar' }): Promise<void>
  pickFiles(): Promise<string[]>
  openAttachment(id: string): Promise<void>
  saveAttachment(id: string): Promise<void>
  openExternal(url: string): Promise<void>
  refresh(accountId?: string): Promise<void>
  on(cb: (e: MailEvent) => void): () => void
}
