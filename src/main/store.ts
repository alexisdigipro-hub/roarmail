// The local database: one SQLite file in the app's data folder. Mail is cached here so it reads offline
// and searches fast; nothing in it ever leaves the computer.
import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'
import schema001 from './schema.sql'
import schema002 from './schema002.sql'
import schema003 from './schema003.sql'
import schema004 from './schema004.sql'
import schema005 from './schema005.sql'
import schema006 from './schema006.sql'
import schema007 from './schema007.sql'
import schema008 from './schema008.sql'
import schema009 from './schema009.sql'
import schema010 from './schema010.sql'

export type DB = Database.Database

const MIGRATIONS: string[] = [schema001, schema002, schema003, schema004, schema005, schema006, schema007, schema008, schema009, schema010]

export function openStore(): DB {
  const db = new Database(path.join(app.getPath('userData'), 'roarmail.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // the search index holds text without accents (Greek tonos and dialytika too): see schema005.sql
  db.function('fold', { deterministic: true }, (v: unknown) => (v == null ? null : fold(String(v))))
  const version = db.pragma('user_version', { simple: true }) as number
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(guarded(db, MIGRATIONS[i]))
      db.pragma(`user_version = ${i + 1}`)
    })()
  }
  return db
}

/**
 * a migration made safe to run on any database: an "alter table … add column" whose column is already there is
 * left out (0.14.2: migration 008 added folders.color, which the first schema already had, and RoarMail never
 * opened). Comments go first, so a statement quoted in one is not mistaken for a real one.
 */
export function guarded(db: DB, sql: string): string {
  const has = db.prepare('select 1 from pragma_table_info(?) where name = ?')
  return sql.replace(/--[^\n]*/g, '').replace(/alter\s+table\s+(\w+)\s+add\s+column\s+(\w+)[^;]*;/gi,
    (stmt, table: string, col: string) => (has.get(table, col) ? '' : stmt))
}

export const now = () => Date.now()
/** lower case without accents, final sigma as sigma: how search compares words */
export const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ς/g, 'σ')
export const uuid = () => crypto.randomUUID()
