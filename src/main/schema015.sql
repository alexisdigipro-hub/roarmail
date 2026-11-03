-- Migration 015 (4 Nov 2026): Waiting for a reply. Mail you sent that nobody has answered shows in All accounts >
-- Waiting for a reply; "Not waiting" takes one off the list for good.
create table if not exists waiting_done (
  message_id text primary key,
  at integer
);
