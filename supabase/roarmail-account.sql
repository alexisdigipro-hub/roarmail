-- RoarMail and the Roar Account (Alex, 3 Nov 2026: one account for every Roar app, "like iCloud"). The Roar Account is
-- RoarMe's sign-in (auth.users of this project); these tables are RoarMail's part of it. Safe to run again.
--
-- roarmail_sync: one document per person, RoarMail's setup (settings, signatures, templates, rules, blocks, account
--   and folder settings, the contacts you marked). Never mail, never mail passwords. Only the person reads or writes it.
-- roarmail_devices: the computers that synced, so the account page can show them (and the person can remove one).
-- roarmail_ai_usage: how many RoarMail AI requests a person made each day (the free allowance); written only by the
--   Edge Function roarmail-ai.

create table if not exists public.roarmail_sync (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  device text,
  updated_at timestamptz not null default now()
);
alter table public.roarmail_sync enable row level security;
drop policy if exists roarmail_sync_own on public.roarmail_sync;
create policy roarmail_sync_own on public.roarmail_sync for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.roarmail_devices (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  install text not null check (install ~ '^[0-9a-f]{64}$'),
  name text, platform text, version text,
  last_seen timestamptz not null default now(),
  primary key (user_id, install)
);
alter table public.roarmail_devices enable row level security;
drop policy if exists roarmail_devices_own on public.roarmail_devices;
create policy roarmail_devices_own on public.roarmail_devices for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.roarmail_ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null default current_date,
  n integer not null default 0,
  primary key (user_id, day)
);
alter table public.roarmail_ai_usage enable row level security;
drop policy if exists roarmail_ai_usage_read on public.roarmail_ai_usage;
create policy roarmail_ai_usage_read on public.roarmail_ai_usage for select to authenticated using (user_id = auth.uid());

-- one more RoarMail AI request for this person today, if the allowance allows (the Edge Function's service role only)
create or replace function public.roarmail_ai_take(p_user uuid, p_limit integer)
returns integer language plpgsql security definer set search_path = public as $$
declare used integer;
begin
  insert into roarmail_ai_usage (user_id, day, n) values (p_user, current_date, 1)
    on conflict (user_id, day) do update set n = roarmail_ai_usage.n + 1
    where roarmail_ai_usage.n < p_limit
  returning n into used;
  return coalesce(used, -1);
end $$;
revoke all on function public.roarmail_ai_take(uuid, integer) from public, anon, authenticated;
grant execute on function public.roarmail_ai_take(uuid, integer) to service_role;
