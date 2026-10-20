-- RoarMail local database (SQLite, better-sqlite3). Migration 001.
-- Times are INTEGER unix ms, UTC. Ids are TEXT uuids unless noted.



create table accounts (
  id text primary key,
  email text not null,
  display_name text not null default '',
  color text not null default '#d40000',
  sort integer not null default 0,
  provider text not null default 'imap' check (provider in ('imap','gmail','microsoft','icloud','yahoo')),
  auth text not null default 'password' check (auth in ('password','oauth')),
  imap_host text not null, imap_port integer not null default 993,
  imap_tls text not null default 'tls' check (imap_tls in ('tls','starttls','none')),
  smtp_host text not null, smtp_port integer not null default 465,
  smtp_tls text not null default 'tls' check (smtp_tls in ('tls','starttls','none')),
  username text not null,
  secret blob,                      -- safeStorage-encrypted password or OAuth token json
  sync_days integer not null default 90,
  enabled integer not null default 1,
  created_at integer not null, updated_at integer not null
);

create table identities (           -- aliases, From picker
  id text primary key,
  account_id text not null references accounts(id) on delete cascade,
  email text not null, name text not null default '',
  signature_id text references signatures(id) on delete set null,
  is_default integer not null default 0
);
create index identities_account on identities(account_id);

create table folders (
  id text primary key,
  account_id text not null references accounts(id) on delete cascade,
  path text not null, name text not null, delimiter text,
  role text check (role in ('inbox','sent','drafts','trash','spam','archive','all','flagged')),
  uidvalidity integer, uidnext integer, highestmodseq integer,
  color text, hidden integer not null default 0,
  unread integer not null default 0, total integer not null default 0,
  unique (account_id, path)
);

create table threads (
  id text primary key,
  account_id text not null references accounts(id) on delete cascade,
  gm_thrid text,                    -- Gmail thread id when present
  subject text not null default '',
  last_date integer not null default 0,
  unread integer not null default 0,
  flagged integer not null default 0
);
create index threads_account_date on threads(account_id, last_date desc);

create table messages (
  id text primary key,
  account_id text not null references accounts(id) on delete cascade,
  thread_id text references threads(id) on delete set null,
  message_id text, in_reply_to text, refs text,
  gm_msgid text,
  from_name text, from_email text,
  to_json text not null default '[]', cc_json text not null default '[]', bcc_json text not null default '[]',
  reply_to text,
  subject text not null default '', snippet text not null default '',
  date integer not null,
  seen integer not null default 0, flagged integer not null default 0, answered integer not null default 0,
  has_attachments integer not null default 0,
  size integer,
  body_text text, body_html text,   -- null until fetched
  list_unsubscribe text,
  created_at integer not null
);
create index messages_thread on messages(thread_id);
create index messages_account_date on messages(account_id, date desc);
create index messages_msgid on messages(account_id, message_id);

create table message_folders (      -- a message can live in several folders (Gmail labels)
  message_id text not null references messages(id) on delete cascade,
  folder_id text not null references folders(id) on delete cascade,
  uid integer not null,
  primary key (folder_id, uid)
);
create index message_folders_msg on message_folders(message_id);

create table attachments (
  id text primary key,
  message_id text not null references messages(id) on delete cascade,
  filename text, mime text, size integer, content_id text, part text not null,
  inline integer not null default 0,
  cache_path text                   -- set once downloaded
);
create index attachments_msg on attachments(message_id);

create table contacts (
  email text primary key,
  name text, last_used integer, use_count integer not null default 0,
  vip integer not null default 0, blocked integer not null default 0,
  images_allowed integer not null default 0
);

create table signatures (
  id text primary key, name text not null, html text not null default '',
  created_at integer not null, updated_at integer not null
);

create table templates (
  id text primary key, name text not null, subject text, html text not null default '',
  created_at integer not null, updated_at integer not null
);

create table drafts (
  id text primary key,
  account_id text not null references accounts(id) on delete cascade,
  identity_id text references identities(id) on delete set null,
  reply_to_message text references messages(id) on delete set null,
  mode text not null default 'new' check (mode in ('new','reply','reply_all','forward')),
  to_json text not null default '[]', cc_json text not null default '[]', bcc_json text not null default '[]',
  subject text not null default '', html text not null default '', plain integer not null default 0,
  attachments_json text not null default '[]',
  server_uid integer,               -- copy in the IMAP Drafts folder
  updated_at integer not null
);

create table outbox (
  id text primary key,
  draft_id text not null references drafts(id) on delete cascade,
  send_at integer not null,         -- now + undo delay, or scheduled time
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','cancelled')),
  attempts integer not null default 0, last_error text,
  remind_if_no_reply_at integer
);
create index outbox_due on outbox(status, send_at);

create table operations (           -- offline queue and undo
  id text primary key,
  account_id text not null references accounts(id) on delete cascade,
  kind text not null check (kind in ('seen','unseen','flag','unflag','move','archive','trash','label','unlabel','delete')),
  payload text not null,            -- json: message ids, source/target folder
  status text not null default 'queued' check (status in ('queued','running','done','failed','reverted')),
  attempts integer not null default 0, last_error text,
  created_at integer not null
);
create index operations_status on operations(status, created_at);

create table snoozes (
  message_id text primary key references messages(id) on delete cascade,
  until_at integer,                 -- null = Set Aside
  origin_folder_id text references folders(id) on delete set null,
  created_at integer not null
);

create table rules (
  id text primary key, name text not null, enabled integer not null default 1,
  sort integer not null default 0,
  applies text not null default 'incoming' check (applies in ('incoming','outgoing')),
  match text not null default 'all' check (match in ('all','any')),
  conditions text not null default '[]', actions text not null default '[]'
);

create table smart_folders (
  id text primary key, name text not null, query text not null, sort integer not null default 0
);

create table settings (key text primary key, value text not null);

create virtual table messages_fts using fts5(
  subject, from_name, from_email, body_text, content='messages', content_rowid='rowid',
  tokenize = 'unicode61 remove_diacritics 2'   -- Greek tonos-insensitive search
);

-- keep the search index in step with messages
create trigger messages_ai after insert on messages begin
  insert into messages_fts(rowid, subject, from_name, from_email, body_text)
  values (new.rowid, new.subject, new.from_name, new.from_email, new.body_text);
end;
create trigger messages_ad after delete on messages begin
  insert into messages_fts(messages_fts, rowid, subject, from_name, from_email, body_text)
  values ('delete', old.rowid, old.subject, old.from_name, old.from_email, old.body_text);
end;
create trigger messages_au after update of subject, from_name, from_email, body_text on messages begin
  insert into messages_fts(messages_fts, rowid, subject, from_name, from_email, body_text)
  values ('delete', old.rowid, old.subject, old.from_name, old.from_email, old.body_text);
  insert into messages_fts(rowid, subject, from_name, from_email, body_text)
  values (new.rowid, new.subject, new.from_name, new.from_email, new.body_text);
end;
