-- Migration 006: a picture for each account (Settings > Accounts), a small PNG as a data URL
alter table accounts add column avatar text;
