import fs from 'node:fs'
import { adapter } from './adapters/index.mjs'

let database = null
let opening = null

export async function createDatabase({ env = process.env, dbPath = undefined } = {}) {
  if (dbPath || env.KIN_DB_PATH) throw new Error('SQLite paths are not accepted by the PostgreSQL adapter')
  const engine = env.KIN_DB_ENGINE || 'postgres'
  if (engine !== 'postgres') throw new Error('Database adapter is not installed: ' + engine)
  const db = new adapter.Database(adapter.config(env))
  try {
    await db.verify()
    await db.initializeBaseline(fs.readFileSync(new URL('./postgres-migrations/001_baseline.sql', import.meta.url), 'utf8'))
    return db
  } catch (error) {
    await db.close()
    throw error
  }
}

export async function openDatabase(options = {}) {
  if (database) return database
  if (!opening) opening = createDatabase(options).then(db => { database = db; return db }).finally(() => { opening = null })
  return await opening
}

export function getDb() {
  if (!database) throw new Error('PostgreSQL is not initialized; await openDatabase() first')
  return database
}

export function resolveStoreDb({ db } = {}) { return db || getDb() }
export function isDbOpen() { return database !== null }
export async function closeDatabase() {
  if (opening) await opening
  const db = database
  database = null
  if (db) await db.close()
}
