-- Migration 005: search that really ignores Greek accents. FTS5's remove_diacritics only knows Latin letters,
-- so "γυρισμα" did not find "Γύρισμα". The index now holds text without accents (fold(), set in store.ts),
-- and search folds what is typed the same way.
drop trigger messages_ai;
drop trigger messages_ad;
drop trigger messages_au;
drop table messages_fts;

create virtual table messages_fts using fts5(
  subject, from_name, from_email, body_text, content='messages', content_rowid='rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

create trigger messages_ai after insert on messages begin
  insert into messages_fts(rowid, subject, from_name, from_email, body_text)
  values (new.rowid, fold(new.subject), fold(new.from_name), fold(new.from_email), fold(new.body_text));
end;
create trigger messages_ad after delete on messages begin
  insert into messages_fts(messages_fts, rowid, subject, from_name, from_email, body_text)
  values ('delete', old.rowid, fold(old.subject), fold(old.from_name), fold(old.from_email), fold(old.body_text));
end;
create trigger messages_au after update of subject, from_name, from_email, body_text on messages begin
  insert into messages_fts(messages_fts, rowid, subject, from_name, from_email, body_text)
  values ('delete', old.rowid, fold(old.subject), fold(old.from_name), fold(old.from_email), fold(old.body_text));
  insert into messages_fts(rowid, subject, from_name, from_email, body_text)
  values (new.rowid, fold(new.subject), fold(new.from_name), fold(new.from_email), fold(new.body_text));
end;

insert into messages_fts(rowid, subject, from_name, from_email, body_text)
  select rowid, fold(subject), fold(from_name), fold(from_email), fold(body_text) from messages;
