-- Migration 004: the account settings from Apple Mail's (Oct 2026): a description, what is downloaded ahead,
-- the folder chosen for each role, and erasing old Trash and Junk.
alter table accounts add column description text not null default '';
alter table accounts add column attachments text not null default 'recent';
alter table accounts add column roles_json text not null default '{}';
alter table accounts add column trash_days integer not null default 0;
alter table accounts add column junk_days integer not null default 0;
