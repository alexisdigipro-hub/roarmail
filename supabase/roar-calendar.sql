-- The Roar Calendar (Alex, 3 Nov 2026: "one calendar for every Roar app, like Google Calendar, on my iPhone too").
-- In RoarMe's project, the Roar Account's home. Safe to run again.
--
-- roar_calendar_events: every event, made by hand on the account page or written by an app (source + source_id: one
--   row per thing, upserted again when it changes: a Roardino call sheet, a RoarList shoot day, a RoarWriter shooting day,
--   an invitation accepted in RoarMail). Only the owner and the people it is shared with see it.
-- roar_calendar_shares: who else sees an event (and may change it).
-- roar_calendar_feeds: the person's secret link for Apple / Google / Outlook Calendar (Edge Function roar-calendar-ics),
--   with whether their tasks with a due date go in it too. A new token makes the old link stop working.

create table if not exists public.roar_calendar_events (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (length(title) between 1 and 300),
  starts_at timestamptz not null,
  ends_at timestamptz,
  all_day boolean not null default false,
  tz text not null default 'Europe/Athens',
  location text, notes text, color text,
  source text not null default 'manual' check (source in ('manual', 'roarme', 'roarwriter', 'roarlist', 'roardino', 'roarmail')),
  source_id text, source_url text,
  remind_minutes integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists roar_calendar_events_source on public.roar_calendar_events (owner, source, source_id) where source_id is not null;
create index if not exists roar_calendar_events_when on public.roar_calendar_events (owner, starts_at);

create table if not exists public.roar_calendar_shares (
  event_id uuid not null references public.roar_calendar_events (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  can_edit boolean not null default false,
  primary key (event_id, user_id)
);

create table if not exists public.roar_calendar_feeds (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  token text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  include_tasks boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.roar_calendar_events enable row level security;
alter table public.roar_calendar_shares enable row level security;
alter table public.roar_calendar_feeds enable row level security;

-- shared-with check without recursion between the two tables' policies
create or replace function public.roar_calendar_can(p_event uuid, p_edit boolean)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from roar_calendar_shares s where s.event_id = p_event and s.user_id = auth.uid() and (not p_edit or s.can_edit))
$$;

drop policy if exists roar_cal_read on public.roar_calendar_events;
create policy roar_cal_read on public.roar_calendar_events for select to authenticated
  using (owner = auth.uid() or public.roar_calendar_can(id, false));
drop policy if exists roar_cal_add on public.roar_calendar_events;
create policy roar_cal_add on public.roar_calendar_events for insert to authenticated with check (owner = auth.uid());
drop policy if exists roar_cal_change on public.roar_calendar_events;
create policy roar_cal_change on public.roar_calendar_events for update to authenticated
  using (owner = auth.uid() or public.roar_calendar_can(id, true)) with check (owner = auth.uid() or public.roar_calendar_can(id, true));
drop policy if exists roar_cal_delete on public.roar_calendar_events;
create policy roar_cal_delete on public.roar_calendar_events for delete to authenticated using (owner = auth.uid());

drop policy if exists roar_cal_shares_read on public.roar_calendar_shares;
create policy roar_cal_shares_read on public.roar_calendar_shares for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from roar_calendar_events e where e.id = event_id and e.owner = auth.uid()));
drop policy if exists roar_cal_shares_owner on public.roar_calendar_shares;
create policy roar_cal_shares_owner on public.roar_calendar_shares for all to authenticated
  using (exists (select 1 from roar_calendar_events e where e.id = event_id and e.owner = auth.uid()))
  with check (exists (select 1 from roar_calendar_events e where e.id = event_id and e.owner = auth.uid()));

drop policy if exists roar_cal_feeds_own on public.roar_calendar_feeds;
create policy roar_cal_feeds_own on public.roar_calendar_feeds for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- a new secret link (the old one stops working)
create or replace function public.roar_calendar_new_token()
returns text language sql security definer set search_path = public as $$
  insert into roar_calendar_feeds (user_id) values (auth.uid())
    on conflict (user_id) do update set token = encode(extensions.gen_random_bytes(24), 'hex')
  returning token
$$;
revoke all on function public.roar_calendar_new_token() from public, anon;
grant execute on function public.roar_calendar_new_token() to authenticated;
revoke all on function public.roar_calendar_can(uuid, boolean) from public, anon;
grant execute on function public.roar_calendar_can(uuid, boolean) to authenticated;

-- touch updated_at
create or replace function public.roar_calendar_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists roar_calendar_touch on public.roar_calendar_events;
create trigger roar_calendar_touch before update on public.roar_calendar_events for each row execute function public.roar_calendar_touch();

-- like every Roar table: an account with two-step verification must have passed it
drop policy if exists roar_mfa on public.roar_calendar_events;
create policy roar_mfa on public.roar_calendar_events as restrictive for all to authenticated using (public.roar_aal_ok()) with check (public.roar_aal_ok());
drop policy if exists roar_mfa on public.roar_calendar_feeds;
create policy roar_mfa on public.roar_calendar_feeds as restrictive for all to authenticated using (public.roar_aal_ok()) with check (public.roar_aal_ok());
