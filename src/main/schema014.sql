-- Migration 014 (2 Nov 2026): the shared spam list (Settings > Privacy > Share blocks). Fingerprints (SHA-256) of
-- addresses, domains and names that at least 3 RoarMail users blocked (a name: 5), downloaded from RoarMe's project
-- every few hours; new mail whose sender matches goes to Junk, never from people you wrote to.
create table if not exists community_blocks (
  hash text primary key,
  kind text not null
);
