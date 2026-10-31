-- Migration 011 (31 Oct 2026): finding a message's reply without reading every message (threads while the whole mail downloads)
create index if not exists messages_reply on messages(account_id, in_reply_to) where in_reply_to is not null;
