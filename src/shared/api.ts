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
  /** off: kept on this computer but not synced, hidden from the lists (Settings > Accounts) */
  enabled: boolean
  /** a name for the account itself, shown above its folders ("Work", "Studio"); empty = the sender name */
  description: string
  /** other addresses this account sends as (the From picker) */
  aliases: Alias[]
  /** what is downloaded ahead: every message with its attachments, the newest ones, or attachments only when opened */
  attachments: 'all' | 'recent' | 'none'
  /** the folders RoarMail uses for each role, chosen in Settings > Accounts (path, or '' for the server's choice) */
  roles: Partial<Record<'drafts' | 'sent' | 'spam' | 'trash' | 'archive', string>>
  /** erase what sat in Trash / Junk longer than this many days (0 = never) */
  trashDays: number
  junkDays: number
  /** unread in this account's inbox (the number on its icon in the rail) */
  unread: number
  /** the account's picture (a small PNG data URL), shown in the rail; null = its initials */
  avatar: string | null
}

export interface Alias { id: string; email: string; name: string }

/** Settings > Accounts > Server: what can be changed after the account is added */
export interface AccountPatch {
  displayName?: string; color?: string; signatureId?: string | null
  enabled?: boolean; description?: string; attachments?: Account['attachments']
  roles?: Account['roles']; trashDays?: number; junkDays?: number
  /** null removes the picture */
  avatar?: null
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
export interface ListScope {
  accountId: string | 'all'; folderId?: string; role?: FolderRole
  /** the filter buttons above the list (Airmail's): only unread, starred, with attachments, or from today */
  filter?: ListFilter
  /** newest first (default) or oldest first; with another sort, reversed */
  oldest?: boolean
  /** Airmail's sort menu: by date (default), sender, subject, unread first, attachments first, account */
  sort?: ListSort
  /** the calendar button: only mail from this day (any time in it) */
  day?: number
  /** the person button: all mail from or to this address, in every folder but Trash and Junk */
  person?: string
}
export type ListFilter = 'unread' | 'flagged' | 'attachments' | 'today' | 'threads'
export type ListSort = 'date' | 'sender' | 'subject' | 'unread' | 'attachments' | 'account'

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
  /** an alias of the account to send as (identities); none = the account's own address */
  identityId?: string
  /** the ! next to the subject: sent as the X-Priority / Importance headers */
  priority?: 'high' | 'normal' | 'low'
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

  // Settings > General (Oct 2026, from Apple Mail's)
  /** minutes between checks of every folder; the inbox also listens live (IDLE). 0 = only when asked */
  checkEvery: number
  /** the sound for new mail: the system's notification sound, one of RoarMail's, or none */
  newMailSound: 'system' | 'none' | NewMailSound
  /** short sounds on send, archive and delete */
  actionSounds: boolean
  /** the number on the Dock / taskbar icon: unread in the inboxes, unread everywhere, or nothing */
  dockBadge: 'inbox' | 'all' | 'none'
  /** notifications for new mail: every inbox, only people you have written to, or none */
  notifyFor: 'inbox' | 'known' | 'none'
  /** where attachments are saved; '' = ask every time */
  downloadsFolder: string
  /** sending again later when the outgoing server cannot be reached */
  retrySending: boolean
  /** search also looks in Trash and Junk */
  searchTrash: boolean
  searchJunk: boolean

  // Settings > Fonts & colours: a FONTS key, or 'local:<family>' for a font installed on this computer
  listFont: string
  /** list text size in px */
  listSize: number
  /** the font of messages without their own (plain text and simple mail) */
  messageFont: string
  monoFont: string
  /** plain text messages in the fixed-width font */
  plainMono: boolean
  /** quoted text coloured by level, with these three colours */
  quoteColors: boolean
  quote1: string; quote2: string; quote3: string

  // Airmail's settings (Oct 2026): General
  /** the app's language: the system's, Greek or English (the window reloads) */
  language: 'auto' | 'el' | 'en'
  /** the "all inboxes" button in the rail */
  unifiedInbox: boolean
  /** links open in the browser without bringing it to the front (Mac) */
  linksInBackground: boolean
  /** Mac: in the Dock and the menu bar, only the Dock, or only the menu bar */
  dockMode: 'both' | 'dock' | 'menubar'
  /** a Reply field in new mail notifications (Mac) */
  notifyReply: boolean
  /** when a message counts as read: on opening, after a few seconds open, or only when marked */
  markRead: 'open' | 'delay' | 'never'
  // Appearance
  /** the account's colour on the list rows */
  accountColours: boolean
  /** unread count on each account in the rail */
  accountBadges: boolean
  /** the numbers next to the inbox and the other folders */
  inboxCounter: 'unread' | 'total' | 'none'
  folderCounter: 'unread' | 'total' | 'none'
  // Advanced
  /** everything at its most private: no remote images ever, trackers blocked, clean links */
  privacyMode: boolean
  /** search shows whole conversations, not single messages */
  searchConversations: boolean
  /** whole words only (otherwise "γυρ" finds "γύρισμα") */
  exactSearch: boolean
  /** search also asks the mail servers, for mail older than what is on this computer */
  onlineSearch: boolean
  /** links, email addresses and phone numbers in plain text become clickable */
  detectLinks: boolean
  /** Appearance > List: pictures of senders from the web (Gravatar, company icons); off in privacy mode */
  senderPictures: boolean
  /** Appearance > List: lines of the message shown under the subject (0 = name and subject only) */
  previewLines: number
  /** Appearance > List: the round picture or initials at the start of each row */
  listAvatars: boolean
  /** the unified folders shown under All accounts (roles, comma separated; the inbox always shows) */
  unifiedShown: string
  /** Settings > Updates: a downloaded update installs by itself when RoarMail is not in use */
  autoUpdate: boolean
}

/** the updater (src/main/updater.js), as Settings > Updates shows it */
export interface UpdateState {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error'
  version: string; progress: number; error: string
  /** this RoarMail's version */
  current: string
  /** when GitHub last answered (0 = not yet) */
  checkedAt: number
}

export type NewMailSound = 'roar' | 'chime' | 'drop' | 'pop' | 'breeze'

export interface LockState { available: boolean; enabled: boolean; locked: boolean; method: 'touchid' | 'none' }
export type SwipeAction = 'archive' | 'trash' | 'flag' | 'seen' | 'snooze' | 'none'

// ---------- RoarMe (optional sign-in; see src/main/roarme.ts) ----------
export interface RoarPerson { id: string; name: string; username: string; avatar?: string }
export interface RoarMeStatus { signedIn: boolean; needsMfa: boolean; email?: string; me?: RoarPerson }
export interface RoarRoom { id: string; kind: string; title: string; avatar?: string; members: RoarPerson[]; unread: number }
export interface RoarTask { id: string; title: string; notes: string; due: string | null; priority: 'low' | 'normal' | 'high'; status: 'pending' | 'open' | 'doing' | 'done' | 'declined'; mine: boolean; from?: string; to?: string }
/** a big attachment sent as a RoarTransfer link instead of inside the email */
export interface RoarTransferLink { url: string; name: string; size: number; expires: string }
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
  | { type: 'open'; messageId: string; subject?: string }
  | { type: 'compose'; to: string; subject?: string; body?: string }
  | { type: 'outbox' }
  | { type: 'opFailed'; error: string }
  | { type: 'lock'; locked: boolean }
  | { type: 'roarme' }
  | { type: 'transfer'; file: string; progress: number }
  | { type: 'sound'; sound: NewMailSound }

export interface MailApi {
  platform: string
  autodetect(email: string): Promise<ServerConfig>
  testAccount(cfg: ServerConfig, password: string): Promise<{ ok: true; cfg: ServerConfig } | { ok: false; error: string }>
  addAccount(cfg: ServerConfig, password: string): Promise<Account>
  updateAccount(id: string, patch: AccountPatch): Promise<void>
  /** every account, the switched-off ones too (Settings > Accounts); accounts() lists only the ones on */
  allAccounts(): Promise<Account[]>
  /** Settings > Accounts > Server: tests the new servers (and password, when given) before keeping them */
  updateServer(id: string, cfg: ServerConfig, password?: string): Promise<{ ok: true } | { ok: false; error: string }>
  addAlias(accountId: string, email: string, name: string): Promise<void>
  removeAlias(id: string): Promise<void>
  /** every folder of an account, for the role pickers (hidden ones too) */
  serverFolders(accountId: string): Promise<{ path: string; name: string }[]>
  /** asks for an image, makes it a round-ready square and keeps it as the account's picture; false = cancelled */
  pickAvatar(accountId: string): Promise<boolean>
  /** pictures for these senders (Gravatar for people, the company's icon for its domain), kept on this computer; null = none */
  senderIcons(emails: string[]): Promise<Record<string, string | null>>
  /** the system's emoji picker, typing into the focused field (Mac and Windows) */
  emojiPanel(): Promise<void>
  /** the unified folders (All Inboxes, All Sent, All Trash…): every switched-on account's folder of that role together */
  unifiedFolders(): Promise<Folder[]>
  /** RoarMail as the computer's mail app (mailto: links) */
  isDefaultMail(): Promise<boolean>
  makeDefaultMail(): Promise<boolean>
  pickFolder(): Promise<string | null>
  removeAccount(id: string): Promise<void>
  accounts(): Promise<Account[]>
  folders(accountId: string): Promise<Folder[]>
  messages(scope: ListScope, before?: number): Promise<MessageRow[]>
  /** the messages of a conversation, oldest first; key is a thread id or a message id */
  thread(key: string): Promise<MessageRow[]>
  message(id: string): Promise<MessageFull>
  search(query: string, accountId?: string): Promise<MessageRow[]>
  /** asks the servers too and keeps what they find here; then the same as search */
  searchOnline(query: string, accountId?: string): Promise<MessageRow[]>
  /** Settings > Advanced */
  resetSettings(): Promise<void>
  /** removes the downloaded copies of messages (they come back from the server when opened); bytes freed */
  clearCache(): Promise<number>
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
  /** RoarMe's app (roarme://) when installed, else the RoarMe site; a chat, a message in it, or the hub */
  roarmeOpen(where: { roomId?: string; messageId?: string; hub?: 'tasks' | 'calendar' }): Promise<void>
  /** sends a local file up to RoarTransfer (progress comes as 'transfer' events) and returns its 3-day link */
  roarmeTransfer(file: string): Promise<RoarTransferLink>
  roarmeCancelTransfer(file: string): Promise<void>
  /** the size in bytes of local files (attachments in the composer); -1 when missing */
  fileSizes(files: string[]): Promise<number[]>
  pickFiles(): Promise<string[]>
  openAttachment(id: string): Promise<void>
  /** into Settings' downloads folder (returns where it went), or asks where; null = cancelled */
  saveAttachment(id: string): Promise<string | null>
  openExternal(url: string): Promise<void>
  refresh(accountId?: string): Promise<void>
  on(cb: (e: MailEvent) => void): () => void
}
