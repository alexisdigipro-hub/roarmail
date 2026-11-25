-- RoarMail's mail in the cloud, for RoarMe (Alex, 24 Nov 2026: "pass the mail through the cloud too, so it pulls them
-- and starts working"). In RoarMail on the computer, Send to RoarMe hands one account's password (or, for Sign in with
-- Microsoft, its refresh token) to the Edge Function roarmail-cloud, which checks it against the server and keeps it
-- in Supabase Vault (encrypted). The function then reads that account's mail over IMAP for RoarMe on any device.
-- Only the person's own rows; nobody reads a password back, not even its owner (only the function's service role).
-- Mail itself is never stored here: it is read from the mail server each time. Safe to run again.

create table if not exists public.roarmail_cloud (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  account_id text not null check (length(account_id) between 1 and 80),
  email text not null,
  cfg jsonb not null,            -- imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, username, kind
  secret_id uuid,                -- vault.secrets id: the password or the Microsoft refresh token
  status text not null default 'ok',
  error text,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (user_id, account_id)
);
alter table public.roarmail_cloud enable row level security;
drop policy if exists roarmail_cloud_read on public.roarmail_cloud;
create policy roarmail_cloud_read on public.roarmail_cloud for select to authenticated using (user_id = auth.uid());
revoke all on public.roarmail_cloud from anon, authenticated;
grant select (user_id, account_id, email, cfg, status, error, checked_at, created_at) on public.roarmail_cloud to authenticated;

-- keep (or replace) an account's secret in Vault: the function's service role only
create or replace function public.roarmail_cloud_put(p_user uuid, p_account text, p_email text, p_cfg jsonb, p_secret text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare sid uuid;
begin
  select secret_id into sid from roarmail_cloud where user_id = p_user and account_id = p_account;
  if sid is not null and exists (select 1 from vault.secrets where id = sid) then
    perform vault.update_secret(sid, p_secret);
  else
    sid := vault.create_secret(p_secret, 'roarmail-cloud:' || p_user || ':' || p_account || ':' || gen_random_uuid(), 'RoarMail account for RoarMe');
  end if;
  insert into roarmail_cloud (user_id, account_id, email, cfg, secret_id, status, error, checked_at)
    values (p_user, p_account, p_email, p_cfg, sid, 'ok', null, now())
  on conflict (user_id, account_id) do update set email = excluded.email, cfg = excluded.cfg, secret_id = sid,
    status = 'ok', error = null, checked_at = now();
end $$;

create or replace function public.roarmail_cloud_secret(p_user uuid, p_account text)
returns text language sql security definer set search_path = public, vault as $$
  select d.decrypted_secret from roarmail_cloud c join vault.decrypted_secrets d on d.id = c.secret_id
  where c.user_id = p_user and c.account_id = p_account
$$;

create or replace function public.roarmail_cloud_drop(p_user uuid, p_account text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare sid uuid;
begin
  delete from roarmail_cloud where user_id = p_user and account_id = p_account returning secret_id into sid;
  if sid is not null then delete from vault.secrets where id = sid; end if;
end $$;

-- the account's state after the function used it (a password changed on the server, say)
create or replace function public.roarmail_cloud_mark(p_user uuid, p_account text, p_status text, p_error text)
returns void language sql security definer set search_path = public as $$
  update roarmail_cloud set status = p_status, error = p_error, checked_at = now() where user_id = p_user and account_id = p_account
$$;

-- a deleted Roar Account takes its secrets with it
create or replace function public.roarmail_cloud_gone() returns trigger language plpgsql security definer set search_path = public, vault as $$
begin
  if old.secret_id is not null then delete from vault.secrets where id = old.secret_id; end if;
  return old;
end $$;
drop trigger if exists roarmail_cloud_gone on public.roarmail_cloud;
create trigger roarmail_cloud_gone after delete on public.roarmail_cloud for each row execute function public.roarmail_cloud_gone();

revoke all on function public.roarmail_cloud_put(uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.roarmail_cloud_secret(uuid, text) from public, anon, authenticated;
revoke all on function public.roarmail_cloud_drop(uuid, text) from public, anon, authenticated;
revoke all on function public.roarmail_cloud_mark(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.roarmail_cloud_gone() from public, anon, authenticated;
grant execute on function public.roarmail_cloud_put(uuid, text, text, jsonb, text) to service_role;
grant execute on function public.roarmail_cloud_secret(uuid, text) to service_role;
grant execute on function public.roarmail_cloud_drop(uuid, text) to service_role;
grant execute on function public.roarmail_cloud_mark(uuid, text, text, text) to service_role;

-- Import from RoarMail (Alex, 25 Nov 2026): RoarMe on the phone asks RoarMail on the computer to send some of its
-- accounts. The ask waits here; RoarMail (checking every minute) shows Allow / Don't Allow and, on Allow, sends each
-- account with roarmail-cloud connect. Only the owner reads or writes their own asks. Safe to run again.
create table if not exists public.roarmail_cloud_asks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  accounts text[] not null check (cardinality(accounts) between 1 and 30),
  state text not null default 'waiting' check (state in ('waiting', 'allowed', 'declined', 'done')),
  error text,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
create index if not exists roarmail_cloud_asks_user on public.roarmail_cloud_asks (user_id, created_at desc);
alter table public.roarmail_cloud_asks enable row level security;
drop policy if exists roarmail_cloud_asks_own on public.roarmail_cloud_asks;
create policy roarmail_cloud_asks_own on public.roarmail_cloud_asks for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.roarmail_cloud_asks to authenticated;
