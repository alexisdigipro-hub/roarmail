-- Migration 002: conversations, the action queue (undo and offline), outbox, drafts kept on the server.
alter table messages add column gm_thrid text;
alter table messages add column pending_op text;     -- hidden while an archive / trash / move waits (undo window)
alter table operations add column run_at integer not null default 0;
alter table drafts add column replaces_message_id text; -- the server draft this one replaces
alter table drafts add column push integer not null default 0; -- 1 = put it in the server's Drafts folder

create index messages_thread_null on messages(account_id) where thread_id is null;
create index messages_gm_thrid on messages(account_id, gm_thrid);
create index messages_pending on messages(pending_op) where pending_op is not null;
create index operations_due on operations(status, run_at);

insert or ignore into settings (key, value) values
  ('undoSendSeconds', '5'),
  ('swipeLeft', 'trash'),
  ('swipeRight', 'archive');
