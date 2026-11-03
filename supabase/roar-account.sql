-- The Roar Account grows (Alex, 3 Nov 2026: "1, 2, 3, 4, 5 yes, do them"). In RoarMe's project. Safe to run again.
--
-- 1. One sign-in for every app: roar_connect holds a short code an app shows while the person allows it on the account
--    page (Edge Function roar-connect). Only the function touches it.
-- 2. The calendar fills itself: triggers on roardino_ordinos (call and wrap time), roarlist_projects (the shoot day) and
--    roarwriter_scripts (the shooting schedule's days) write roar_calendar_events (source + source_id). A trigger never
--    stops an app from saving: any error inside is swallowed.
-- 3. Projects across apps: roar_projects, roar_project_members, roar_project_items (a script, a shot list, an ordino, a
--    sender for RoarMail...); calendar events and tasks can belong to one.
-- 4. Notifications in one place: roar_notifications, written by triggers (a task given to you or answered, an event or a
--    project shared with you, a script shared with you, files sent to your RoarTransfer inbox).
-- 5. Devices: roar_my_sessions() (RoarMe's) lists where the account is signed in; roar_end_session() / roar_end_other_sessions()
--    sign a device out (its refresh token dies at once; an open app stops within the hour at most).

-- ---------- 1. connect codes ----------
create table if not exists public.roar_connect (
  code text primary key,
  secret_hash text not null,
  app text not null,
  created_at timestamptz not null default now(),
  user_id uuid references auth.users (id) on delete cascade,
  token_hash text,
  allowed_at timestamptz
);
alter table public.roar_connect enable row level security;  -- no policies: only the Edge Function (service role)

-- ---------- 3. projects (before the calendar, which points at them) ----------
create table if not exists public.roar_projects (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  color text,
  notes text,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.roar_project_members (
  project_id uuid not null references public.roar_projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'edit' check (role in ('edit', 'view')),
  added_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create table if not exists public.roar_project_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.roar_projects (id) on delete cascade,
  app text not null check (app in ('roarwriter', 'roarlist', 'roardino', 'roarmail', 'roartransfer', 'roarme', 'link')),
  kind text not null default 'item',          -- 'item', or for RoarMail 'sender' (an address or @domain whose mail belongs here)
  item_id text not null,
  title text,
  url text,
  added_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (project_id, app, kind, item_id)
);
alter table public.roar_projects enable row level security;
alter table public.roar_project_members enable row level security;
alter table public.roar_project_items enable row level security;

-- 'owner' / 'edit' / 'view' / null for the person asking
create or replace function public.roar_project_role(p uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select 'owner' from roar_projects where id = p and owner = auth.uid()),
                  (select role from roar_project_members where project_id = p and user_id = auth.uid()))
$$;
revoke all on function public.roar_project_role(uuid) from public, anon;
grant execute on function public.roar_project_role(uuid) to authenticated;

drop policy if exists roar_proj_read on public.roar_projects;
create policy roar_proj_read on public.roar_projects for select to authenticated using (public.roar_project_role(id) is not null);
drop policy if exists roar_proj_add on public.roar_projects;
create policy roar_proj_add on public.roar_projects for insert to authenticated with check (owner = auth.uid());
drop policy if exists roar_proj_change on public.roar_projects;
create policy roar_proj_change on public.roar_projects for update to authenticated
  using (public.roar_project_role(id) in ('owner', 'edit')) with check (public.roar_project_role(id) in ('owner', 'edit'));
drop policy if exists roar_proj_delete on public.roar_projects;
create policy roar_proj_delete on public.roar_projects for delete to authenticated using (owner = auth.uid());

drop policy if exists roar_projm_read on public.roar_project_members;
create policy roar_projm_read on public.roar_project_members for select to authenticated using (public.roar_project_role(project_id) is not null);
drop policy if exists roar_projm_owner on public.roar_project_members;
create policy roar_projm_owner on public.roar_project_members for all to authenticated
  using (public.roar_project_role(project_id) = 'owner' or user_id = auth.uid())   -- the owner manages; anyone may leave
  with check (public.roar_project_role(project_id) = 'owner');

drop policy if exists roar_proji_read on public.roar_project_items;
create policy roar_proji_read on public.roar_project_items for select to authenticated using (public.roar_project_role(project_id) is not null);
drop policy if exists roar_proji_write on public.roar_project_items;
create policy roar_proji_write on public.roar_project_items for all to authenticated
  using (public.roar_project_role(project_id) in ('owner', 'edit')) with check (public.roar_project_role(project_id) in ('owner', 'edit'));

alter table public.roar_calendar_events add column if not exists project_id uuid references public.roar_projects (id) on delete set null;
alter table public.roar_tasks add column if not exists project_id uuid references public.roar_projects (id) on delete set null;
-- a project's members see its calendar events
drop policy if exists roar_cal_project on public.roar_calendar_events;
create policy roar_cal_project on public.roar_calendar_events for select to authenticated
  using (project_id is not null and public.roar_project_role(project_id) is not null);

-- add a member by @username or email (the owner only)
create or replace function public.roar_project_add_member(p uuid, who text, r text default 'edit')
returns uuid language plpgsql security definer set search_path = public as $$
declare u uuid; w text := lower(trim(who));
begin
  if public.roar_project_role(p) is distinct from 'owner' then raise exception 'only the owner adds people'; end if;
  if w like '@%' then w := substr(w, 2); end if;
  select id into u from roar_profiles where username = w;
  if u is null then select id into u from auth.users where lower(email) = w; end if;
  if u is null then raise exception 'nobody with that username or email has a Roar Account'; end if;
  insert into roar_project_members (project_id, user_id, role, added_by) values (p, u, case when r = 'view' then 'view' else 'edit' end, auth.uid())
    on conflict (project_id, user_id) do update set role = excluded.role;
  return u;
end $$;
revoke all on function public.roar_project_add_member(uuid, text, text) from public, anon;
grant execute on function public.roar_project_add_member(uuid, text, text) to authenticated;

drop trigger if exists roar_projects_touch on public.roar_projects;
create trigger roar_projects_touch before update on public.roar_projects for each row execute function public.roar_calendar_touch();

-- ---------- 4. notifications ----------
create table if not exists public.roar_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  app text not null default 'account',
  kind text not null,
  title text not null,
  body text,
  url text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists roar_notifications_user on public.roar_notifications (user_id, created_at desc);
alter table public.roar_notifications enable row level security;
drop policy if exists roar_notif_own on public.roar_notifications;
create policy roar_notif_own on public.roar_notifications for select to authenticated using (user_id = auth.uid());
drop policy if exists roar_notif_read on public.roar_notifications;
create policy roar_notif_read on public.roar_notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists roar_notif_delete on public.roar_notifications;
create policy roar_notif_delete on public.roar_notifications for delete to authenticated using (user_id = auth.uid());

create or replace function public.roar_who(u uuid) returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(p.display_name, ''), '@' || p.username, (select split_part(email, '@', 1) from auth.users where id = u), 'Someone')
  from (select 1) x left join roar_profiles p on p.id = u
$$;

create or replace function public.roar_notify(u uuid, a text, k text, t text, b text default null, l text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if u is null then return; end if;
  insert into roar_notifications (user_id, app, kind, title, body, url) values (u, a, k, left(t, 300), left(b, 1000), l);
  -- keep the last 300 a person has
  delete from roar_notifications where user_id = u and id in (select id from roar_notifications where user_id = u order by created_at desc offset 300);
exception when others then null;
end $$;
revoke all on function public.roar_notify(uuid, text, text, text, text, text) from public, anon, authenticated;

create or replace function public.roar_notify_tasks() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.assignee is not null and new.assignee <> new.created_by then
    perform roar_notify(new.assignee, 'account', 'task', roar_who(new.created_by) || ' gave you a task', new.title, 'https://themadlions.com/account/#tasks');
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status and new.created_by <> new.assignee and new.status in ('done', 'declined', 'doing') then
    perform roar_notify(new.created_by, 'account', 'task', roar_who(new.assignee) || case new.status when 'done' then ' finished a task' when 'declined' then ' declined a task' else ' started a task' end,
      new.title || coalesce(' · ' || nullif(new.decline_note, ''), ''), 'https://themadlions.com/account/#tasks');
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists roar_notify_tasks on public.roar_tasks;
create trigger roar_notify_tasks after insert or update on public.roar_tasks for each row execute function public.roar_notify_tasks();

create or replace function public.roar_notify_cal_share() returns trigger language plpgsql security definer set search_path = public as $$
declare e record;
begin
  select title, owner, starts_at into e from roar_calendar_events where id = new.event_id;
  if e.owner is not null and e.owner <> new.user_id then
    perform roar_notify(new.user_id, 'account', 'event', roar_who(e.owner) || ' shared an event with you',
      e.title || ' · ' || to_char(e.starts_at at time zone 'Europe/Athens', 'DD Mon HH24:MI'), 'https://themadlions.com/account/#calendar');
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists roar_notify_cal_share on public.roar_calendar_shares;
create trigger roar_notify_cal_share after insert on public.roar_calendar_shares for each row execute function public.roar_notify_cal_share();

create or replace function public.roar_notify_project_member() returns trigger language plpgsql security definer set search_path = public as $$
declare p record;
begin
  select name, owner into p from roar_projects where id = new.project_id;
  if new.user_id <> coalesce(new.added_by, p.owner) then
    perform roar_notify(new.user_id, 'account', 'project', roar_who(coalesce(new.added_by, p.owner)) || ' added you to a project', p.name, 'https://themadlions.com/account/#projects');
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists roar_notify_project_member on public.roar_project_members;
create trigger roar_notify_project_member after insert on public.roar_project_members for each row execute function public.roar_notify_project_member();

create or replace function public.roar_notify_writer_share() returns trigger language plpgsql security definer set search_path = public as $$
declare u uuid; t text;
begin
  select id into u from auth.users where lower(email) = lower(new.email);
  select coalesce(nullif(title, ''), 'Untitled') into t from roarwriter_scripts where id = new.script_id;
  if u is not null and u <> new.added_by then
    perform roar_notify(u, 'roarwriter', 'share', roar_who(new.added_by) || ' shared a script with you',
      t || case when new.role = 'view' then ' · to read' else ' · to write together' end, 'https://alexisdigipro-hub.github.io/roarwriter/');
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists roar_notify_writer_share on public.roarwriter_shares;
create trigger roar_notify_writer_share after insert on public.roarwriter_shares for each row execute function public.roar_notify_writer_share();

create or replace function public.roar_notify_transfer() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform roar_notify(new.owner, 'roartransfer', 'files', coalesce(nullif(new.sender_name, ''), new.sender_email, 'Someone') || ' sent you files',
    new.files || case when new.files = 1 then ' file' else ' files' end || coalesce(' · ' || nullif(left(new.message, 200), ''), ''), 'https://roartransfer.com/');
  return new;
exception when others then return new;
end $$;
drop trigger if exists roar_notify_transfer on public.roar_transfer_inbox;
create trigger roar_notify_transfer after insert on public.roar_transfer_inbox for each row execute function public.roar_notify_transfer();

-- ---------- 2. the calendar fills itself ----------
create or replace function public.roar_cal_put(o uuid, src text, sid text, t text, s timestamptz, e timestamptz, ad boolean, loc text, u text, n text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into roar_calendar_events (owner, title, starts_at, ends_at, all_day, location, source, source_id, source_url, notes)
    values (o, left(coalesce(nullif(t, ''), 'Shoot'), 300), s, e, ad, nullif(loc, ''), src, sid, u, n)
  on conflict (owner, source, source_id) where source_id is not null do update
    set title = excluded.title, starts_at = excluded.starts_at, ends_at = excluded.ends_at, all_day = excluded.all_day,
        location = excluded.location, source_url = excluded.source_url, notes = excluded.notes, deleted_at = null;
end $$;
revoke all on function public.roar_cal_put(uuid, text, text, text, timestamptz, timestamptz, boolean, text, text, text) from public, anon, authenticated;

create or replace function public.roar_day(d text) returns date language plpgsql immutable as $$
begin
  if d ~ '^\d{4}-\d{2}-\d{2}' then return left(d, 10)::date; end if;
  return null;
exception when others then return null;
end $$;

create or replace function public.roar_at(d date, hm text) returns timestamptz language plpgsql immutable as $$
begin
  if d is null or coalesce(hm, '') !~ '^\d{1,2}[:.]\d{2}$' then return null; end if;
  return (d::text || ' ' || replace(hm, '.', ':'))::timestamp at time zone 'Europe/Athens';
exception when others then return null;
end $$;

-- Roardino: the ordino's day, from the call time to the wrap
create or replace function public.roar_cal_roardino() returns trigger language plpgsql security definer set search_path = public as $$
declare d date; s timestamptz; e timestamptz; t text; l text; pj jsonb; lc jsonb;
begin
  if tg_op = 'DELETE' then
    delete from roar_calendar_events where owner = old.owner and source = 'roardino' and source_id = old.id::text;
    return old;
  end if;
  d := roar_day(new.data #>> '{day,date}');
  if d is null then
    delete from roar_calendar_events where owner = new.owner and source = 'roardino' and source_id = new.id::text;
    return new;
  end if;
  pj := case jsonb_typeof(new.data -> 'project') when 'object' then new.data -> 'project' when 'string' then (new.data ->> 'project')::jsonb else '{}' end;
  lc := case jsonb_typeof(new.data -> 'loc') when 'object' then new.data -> 'loc' when 'string' then (new.data ->> 'loc')::jsonb else '{}' end;
  s := roar_at(d, new.data #>> '{day,callTime}');
  e := roar_at(d, new.data #>> '{day,wrapTime}');
  if e is not null and s is not null and e <= s then e := e + interval '1 day'; end if;
  t := 'Shoot: ' || coalesce(nullif(pj ->> 'title', ''), nullif(new.data #>> '{day,label}', ''), 'Ordino');
  l := concat_ws(', ', nullif(lc ->> 'name', ''), nullif(lc ->> 'address', ''));
  perform roar_cal_put(new.owner, 'roardino', new.id::text, t, coalesce(s, d::timestamp at time zone 'Europe/Athens'), e, s is null, l,
    case when new.token is not null then 'https://go.themadlions.com/?dino/' || new.token else 'https://themadlions.com/roardino/' end,
    case when s is not null then 'Call ' || (new.data #>> '{day,callTime}') || coalesce(' · wrap ' || nullif(new.data #>> '{day,wrapTime}', ''), '') end);
  return new;
exception when others then return coalesce(new, old);
end $$;
drop trigger if exists roar_cal_roardino on public.roardino_ordinos;
create trigger roar_cal_roardino after insert or update or delete on public.roardino_ordinos for each row execute function public.roar_cal_roardino();

-- RoarList: the shot list's shoot day
create or replace function public.roar_cal_roarlist() returns trigger language plpgsql security definer set search_path = public as $$
declare d date;
begin
  if tg_op = 'DELETE' then
    delete from roar_calendar_events where owner = old.owner and source = 'roarlist' and source_id = old.id::text;
    return old;
  end if;
  d := roar_day(new.data ->> 'date');
  if d is null then
    delete from roar_calendar_events where owner = new.owner and source = 'roarlist' and source_id = new.id::text;
  else
    perform roar_cal_put(new.owner, 'roarlist', new.id::text, 'Shoot day: ' || coalesce(nullif(new.data ->> 'title', ''), 'Shot list'),
      d::timestamp at time zone 'Europe/Athens', null, true, null, 'https://themadlions.com/roarlist/',
      nullif(concat_ws(' · ', nullif(new.data ->> 'client', ''), nullif('Director ' || (new.data ->> 'director'), 'Director ')), ''));
  end if;
  return new;
exception when others then return coalesce(new, old);
end $$;
drop trigger if exists roar_cal_roarlist on public.roarlist_projects;
create trigger roar_cal_roarlist after insert or update or delete on public.roarlist_projects for each row execute function public.roar_cal_roarlist();

-- RoarWriter: every day of the shooting schedule (its own date, or the first day + its place)
create or replace function public.roar_cal_writer_sync(o uuid, script uuid, title text, data jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare st date; dy jsonb; k int := 0; d date; keep text[] := '{}'; sid text; t text;
begin
  st := roar_day(data #>> '{schedule,start}');
  t := coalesce(nullif(title, ''), nullif(data ->> 'title', ''), 'Untitled');
  for dy in select value from jsonb_array_elements(case when jsonb_typeof(data #> '{schedule,days}') = 'array' then data #> '{schedule,days}' else '[]' end) loop
    d := coalesce(roar_day(dy ->> 'date'), st + k);
    k := k + 1;
    if d is null then continue; end if;
    sid := script::text || ':' || coalesce(dy ->> 'id', k::text);
    keep := keep || sid;
    perform roar_cal_put(o, 'roarwriter', sid, t || ' · Day ' || k, d::timestamp at time zone 'Europe/Athens', null, true, null,
      'https://alexisdigipro-hub.github.io/roarwriter/',
      coalesce(jsonb_array_length(case when jsonb_typeof(dy -> 'scenes') = 'array' then dy -> 'scenes' else '[]' end), 0) || ' scenes');
  end loop;
  delete from roar_calendar_events e where e.owner = o and e.source = 'roarwriter' and e.source_id like script::text || ':%' and not (e.source_id = any (keep));
end $$;
revoke all on function public.roar_cal_writer_sync(uuid, uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.roar_cal_roarwriter() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    delete from roar_calendar_events where owner = old.owner and source = 'roarwriter' and source_id like old.id::text || ':%';
    return old;
  end if;
  if tg_op = 'UPDATE' and new.data -> 'schedule' is not distinct from old.data -> 'schedule' and new.title is not distinct from old.title then return new; end if;
  perform roar_cal_writer_sync(new.owner, new.id, new.title, new.data);
  return new;
exception when others then return coalesce(new, old);
end $$;
drop trigger if exists roar_cal_roarwriter on public.roarwriter_scripts;
create trigger roar_cal_roarwriter after insert or update or delete on public.roarwriter_scripts for each row execute function public.roar_cal_roarwriter();

-- fill it once from what is already there
update public.roardino_ordinos set data = data where roar_day(data #>> '{day,date}') is not null;
update public.roarlist_projects set data = data where roar_day(data ->> 'date') is not null;
select public.roar_cal_writer_sync(owner, id, title, data) from public.roarwriter_scripts where jsonb_typeof(data #> '{schedule,days}') = 'array';

-- ---------- 5. devices ----------
-- roar_my_sessions() and roar_end_session(sid) come from RoarMe (its Devices); the account page uses them too.
create or replace function public.roar_end_other_sessions()
returns integer language plpgsql security definer set search_path = public, auth as $$
declare n integer;
begin
  if not public.roar_aal_ok() then raise exception 'two-step verification needed'; end if;
  delete from auth.sessions where user_id = auth.uid() and id::text <> coalesce(auth.jwt() ->> 'session_id', '');
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.roar_end_other_sessions() from public, anon;
grant execute on function public.roar_end_other_sessions() to authenticated;

-- like every Roar table: an account with two-step verification must have passed it
do $$ declare t text; begin
  foreach t in array array['roar_projects', 'roar_project_members', 'roar_project_items', 'roar_notifications'] loop
    execute format('drop policy if exists roar_mfa on public.%I', t);
    execute format('create policy roar_mfa on public.%I as restrictive for all to authenticated using (public.roar_aal_ok()) with check (public.roar_aal_ok())', t);
  end loop;
end $$;
