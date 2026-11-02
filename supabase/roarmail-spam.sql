-- RoarMail's shared spam list (Alex, 2 Nov 2026: "what I block, the other RoarMail users should not get either").
-- Lives in RoarMe's Supabase project, next to RoarWriter's tables; never touches roar_*. Safe to run again.
--
-- What a copy of RoarMail sends: only SHA-256 fingerprints of what was blocked ('email:x@y.com', 'domain:y.com',
-- 'name:derilo'), with a fingerprint of its own random install id. No address, name, mail or account leaves the computer
-- in the clear. A fingerprint counts for everyone only when 3 different copies blocked it (a name: 5), so one person
-- cannot block a real sender for all; each copy then never applies it to people it has written to.

create table if not exists public.roarmail_spam_reports (
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('email', 'domain', 'name')),
  reporter text not null check (reporter ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (hash, reporter)
);
create index if not exists roarmail_spam_reports_reporter on public.roarmail_spam_reports (reporter, created_at);
alter table public.roarmail_spam_reports enable row level security;
-- no policies: nobody reads or writes the table directly, only through the two functions below
revoke all on public.roarmail_spam_reports from anon, authenticated;

-- report blocks (on = true) or take them back (on = false, Unblock); at most 50 at once and 300 a day per copy
create or replace function public.roarmail_spam_report(p_reporter text, p_items jsonb, p_on boolean default true)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0; it jsonb; today integer;
begin
  if p_reporter !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 50 then return 0; end if;
  if p_on then
    select count(*) into today from roarmail_spam_reports where reporter = p_reporter and created_at > now() - interval '1 day';
    if today >= 300 then return 0; end if;
  end if;
  for it in select * from jsonb_array_elements(p_items) loop
    if coalesce(it->>'hash', '') !~ '^[0-9a-f]{64}$' or coalesce(it->>'kind', '') not in ('email', 'domain', 'name') then continue; end if;
    if p_on then
      insert into roarmail_spam_reports (hash, kind, reporter) values (it->>'hash', it->>'kind', p_reporter) on conflict do nothing;
    else
      delete from roarmail_spam_reports where hash = it->>'hash' and reporter = p_reporter;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- the shared list: fingerprints blocked by enough different copies in the last year
create or replace function public.roarmail_spam_list()
returns table (hash text, kind text) language sql stable security definer set search_path = public as $$
  select r.hash, min(r.kind) from roarmail_spam_reports r
  where r.created_at > now() - interval '365 days'
  group by r.hash
  having count(distinct r.reporter) >= case when min(r.kind) = 'name' then 5 else 3 end
$$;

revoke all on function public.roarmail_spam_report(text, jsonb, boolean) from public;
revoke all on function public.roarmail_spam_list() from public;
grant execute on function public.roarmail_spam_report(text, jsonb, boolean) to anon, authenticated;
grant execute on function public.roarmail_spam_list() to anon, authenticated;
