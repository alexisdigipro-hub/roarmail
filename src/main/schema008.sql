-- Migration 008: a colour for a folder (its right-click menu, 21 Oct 2026); null = the usual grey.
-- folders.color has been in the table since the first schema (schema.sql), so there is nothing to add: the
-- "alter table folders add column color" that 0.14.0 shipped here failed on every database ("duplicate column
-- name: color") and RoarMail stayed on its loading circle (22 Oct 2026). Kept as a step so the version count holds.
select 1;
