-- Migration 009 (29 Oct 2026): rules, templates and calendar invitations.
-- The rules and templates tables have been in the first schema (schema.sql) since 0.1; they are named here once more
-- with "if not exists", so this step is safe on every database. Every "add column" below is skipped by store.ts when
-- the column is already there (0.14.2 stayed on its loading circle because one was added twice).

create table if not exists rules (
  id text primary key, name text not null, enabled integer not null default 1,
  sort integer not null default 0,
  applies text not null default 'incoming' check (applies in ('incoming','outgoing')),
  match text not null default 'all' check (match in ('all','any')),
  conditions text not null default '[]', actions text not null default '[]'
);

create table if not exists templates (
  id text primary key, name text not null, subject text, html text not null default '',
  created_at integer not null, updated_at integer not null
);

-- the List-Id header, for rules on mailing lists (filled for mail synced from now on)
alter table messages add column list_id text;

-- how this computer answered an invitation (by its UID), so the invite card shows it
create table if not exists invite_answers (
  uid text primary key,
  answer text not null check (answer in ('accepted','tentative','declined')),
  answered_at integer not null
);
