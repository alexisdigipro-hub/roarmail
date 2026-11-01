-- Migration 012 (1 Nov 2026): RoarMail learns from what you ignore, on this computer only. Per sender: how often
-- their mail was deleted or archived unread (ignored; to Junk counts 3), how often it was opened, and "Not
-- promotions" (keep = 1, which always wins). A sender ignored 3 times and never opened is quiet: their mail goes
-- with the Promotions and never notifies. Forget what it learned (Settings > General) empties the table.
create table if not exists sender_learn (
  email text primary key,
  ignored integer not null default 0,
  opened integer not null default 0,
  keep integer not null default 0,
  updated integer
);
