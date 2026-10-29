-- Migration 010 (29 Oct 2026): Contacts. The contacts table has had every sender and recipient since 0.1 (for
-- the To field's suggestions); now it also keeps a card: phone, company, title, website, notes and groups. Fields
-- read from a signature fill only what is empty; a field the person typed is listed in "edited" and never replaced.
alter table contacts add column phone text;
alter table contacts add column company text;
alter table contacts add column title text;
alter table contacts add column website text;
alter table contacts add column notes text;
alter table contacts add column groups text not null default '';
alter table contacts add column edited text not null default '';
alter table contacts add column sig_checked integer not null default 0;

-- the card's counts and the list's order look up a sender's mail
create index if not exists messages_from on messages(from_email, date);
