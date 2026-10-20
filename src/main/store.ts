// The local database: one SQLite file in the app's data folder. Mail is cached here so it reads offline
// and searches fast; nothing in it ever leaves the computer.
import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'
import schema001 from './schema.sql'
import schema002 from './schema002.sql'
import schema003 from './schema003.sql'

export type DB = Database.Database

const MIGRATIONS: string[] = [schema001, schema002, schema003]

export function openStore(): DB {
  const db = new Database(path.join(app.getPath('userData'), 'roarmail.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const version = db.pragma('user_version', { simple: true }) as number
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i])
      db.pragma(`user_version = ${i + 1}`)
    })()
  }
  return db
}

export const now = () => Date.now()
export const uuid = () => crypto.randomUUID()
