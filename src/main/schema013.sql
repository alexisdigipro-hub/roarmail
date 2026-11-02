-- Migration 013 (2 Nov 2026): Block goes further (Alex: "the same name from another address, straight to Spam").
-- Besides the blocked addresses (contacts.blocked), a sender's name or a whole domain can be blocked. A name is kept
-- folded (lower case, no accents, single spaces) and never catches someone you wrote to or a VIP.
create table if not exists block_rules (
  kind text not null,  -- 'name' or 'domain'
  value text not null, -- folded name, or a domain such as deals-xyz.com
  label text,          -- the name as it was shown, for Settings > Privacy
  created integer,
  primary key (kind, value)
);
