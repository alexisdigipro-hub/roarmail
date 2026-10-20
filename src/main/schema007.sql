-- Migration 007: pictures of the people and companies who write (21 Oct 2026). One row per Gravatar address
-- ('g:<email>') or company domain ('d:<domain>'); data null = there is none (asked again after a week).
create table sender_icons (
  key text primary key,
  data text,
  fetched_at integer not null
);
