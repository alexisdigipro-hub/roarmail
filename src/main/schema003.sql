-- Migration 003: snooze, send later, reminders when nobody answers.
-- Snoozed mail sits in a "Snoozed" folder on the server (so a phone sees it gone from the inbox too); the
-- wake-up time is kept here, keyed by the Message-ID header, because moving gives the message a new UID.
create table snoozed (
  id text primary key,
  account_id text not null references accounts(id) on delete cascade,
  header_id text not null,           -- Message-ID header
  subject text not null default '',
  from_name text not null default '',
  until_at integer,                  -- null = set aside, no wake-up
  origin_path text not null default 'INBOX',
  status text not null default 'waiting' check (status in ('waiting','woken')),
  created_at integer not null
);
create index snoozed_due on snoozed(status, until_at);

create table reminders (
  id text primary key,
  account_id text not null references accounts(id) on delete cascade,
  header_id text not null,           -- Message-ID of the sent message
  subject text not null default '',
  recipients text not null default '',
  remind_at integer not null,
  status text not null default 'waiting' check (status in ('waiting','done','answered')),
  created_at integer not null
);
create index reminders_due on reminders(status, remind_at);

alter table outbox add column remind_days integer;
alter table outbox add column scheduled integer not null default 0;
-- folders RoarMail itself looks after (the role column has a fixed list): 'snoozed'
alter table folders add column special text;
