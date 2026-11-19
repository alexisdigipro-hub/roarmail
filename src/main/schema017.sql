-- 0.38.0 (Alex, 19 Nov 2026: "it is quite heavy"): lighter work on the window's thread.
-- Waiting for a reply asks "anything newer in this conversation?": a conversation's messages by date answer it at once
create index if not exists messages_thread_date on messages(thread_id, date);
-- a folder's messages without reading each link row: the list, the counts, the badge (10 to 30% faster on 50,000 messages)
create index if not exists message_folders_folder_msg on message_folders(folder_id, message_id);
-- which messages the shield and the brand / shared-list blocks already looked at in a folder, under which set of rules
-- (gen): Junk and the inboxes are judged once, not every 5 minutes again; a new rule (gen + 1) judges them all once more
create table if not exists shield_judged (
  message_id text not null,
  folder_id text not null,
  gen integer not null,
  primary key (message_id, folder_id)
) without rowid;
create trigger if not exists shield_judged_msg after delete on messages begin
  delete from shield_judged where message_id = old.id;
end;
create trigger if not exists shield_judged_link after delete on message_folders begin
  delete from shield_judged where message_id = old.message_id and folder_id = old.folder_id;
end;
