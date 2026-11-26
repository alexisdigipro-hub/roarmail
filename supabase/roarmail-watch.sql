-- New-mail notifications in RoarMe (Alex, 26 Nov 2026: "notifications as Spark's"). RoarMail Live's container keeps an
-- IMAP IDLE on each Inbox of whoever has this on, and tells roar-push the moment a mail arrives. Safe to run again.
-- roarmail_watch: the person's own switch (enabled) and the accounts they keep quiet (muted). Without a row they are not
-- watched; the app makes the row, enabled, the first time ROARMAIL is used.
create table if not exists public.roarmail_watch (
  user_id uuid primary key references auth.users (id) on delete cascade,
  enabled boolean not null default true,
  muted text[] not null default '{}',
  updated_at timestamptz not null default now()
);
alter table public.roarmail_watch enable row level security;
drop policy if exists roarmail_watch_own on public.roarmail_watch;
create policy roarmail_watch_own on public.roarmail_watch for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.roarmail_watch to authenticated;

-- the newest mail already told about, per account, so a container that wakes again neither repeats nor misses mail;
-- only the service role (roarmail-creds) reads and writes it
create table if not exists public.roarmail_watch_seen (
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id text not null,
  validity bigint not null default 0,
  last_uid bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, account_id)
);
alter table public.roarmail_watch_seen enable row level security;
revoke all on public.roarmail_watch_seen from anon, authenticated;
