-- Migration 008: a colour for a folder (its right-click menu, 21 Oct 2026); null = the usual grey
alter table folders add column color text;
