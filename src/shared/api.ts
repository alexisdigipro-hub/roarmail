// The one door between the RoarMail screens and the mail engine. The desktop app implements it over
// Electron IPC (src/preload). A later Hub version can implement the same interface over a server bridge,
// so the screens never change.

export type Tls = 'tls' | 'starttls' | 'none'
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive' | 'all' | 'flagged'

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

export interface MessageRow {
  id: string
  accountId: string
  fromName: string
  fromEmail: string
  subject: string
  snippet: string
  date: number
  seen: boolean
  flagged: boolean
  answered: boolean
  hasAttachments: boolean
}

export interface Attachment { id: string; filename: string; mime: string; size: number; inline: boolean }

export interface MessageFull extends MessageRow {
  to: Address[]
  cc: Address[]
  replyTo?: string
  messageId?: string
  html?: string
  text?: string
  attachments: Attachment[]
  /** cid -> data: url, for inline images */
  inlineImages: Record<string, string>
  imagesAllowed: boolean
  listUnsubscribe?: string
}

/** what the list shows: one folder, or the unified inbox (accountId 'all') */
export interface ListScope { accountId: string | 'all'; folderId?: string; role?: FolderRole }

export interface Draft {
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
  attachments?: string[] // local file paths
}

export type Action = 'seen' | 'unseen' | 'flag' | 'unflag' | 'archive' | 'trash'

export type MailEvent =
  | { type: 'accounts' }
  | { type: 'folders'; accountId: string }
  | { type: 'messages'; accountId: string }
  | { type: 'newMail'; accountId: string; messageId: string }
  | { type: 'sync'; accountId: string; busy: boolean }
  | { type: 'open'; messageId: string }
  | { type: 'compose'; to: string; subject?: string; body?: string }

export interface MailApi {
  platform: string
  autodetect(email: string): Promise<ServerConfig>
  testAccount(cfg: ServerConfig, password: string): Promise<{ ok: true; cfg: ServerConfig } | { ok: false; error: string }>
  addAccount(cfg: ServerConfig, password: string): Promise<Account>
  removeAccount(id: string): Promise<void>
  accounts(): Promise<Account[]>
  folders(accountId: string): Promise<Folder[]>
  messages(scope: ListScope, before?: number): Promise<MessageRow[]>
  message(id: string): Promise<MessageFull>
  search(query: string, accountId?: string): Promise<MessageRow[]>
  contacts(query: string): Promise<Address[]>
  act(ids: string[], action: Action): Promise<void>
  allowImages(sender: string): Promise<void>
  send(draft: Draft): Promise<void>
  pickFiles(): Promise<string[]>
  openAttachment(id: string): Promise<void>
  saveAttachment(id: string): Promise<void>
  openExternal(url: string): Promise<void>
  refresh(accountId?: string): Promise<void>
  on(cb: (e: MailEvent) => void): () => void
}
