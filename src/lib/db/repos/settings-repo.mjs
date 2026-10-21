import { getDb } from '../database.mjs'

/** JSON settings stored through the database-independent Knex query API. */
export class SettingsRepo {
  constructor(db = getDb()) { this.db = db }
  async get(key, fallback = null) {
    const row = await this.db.table('settings').select('value').where({key}).first()
    return row ? JSON.parse(row.value) : fallback
  }
  async set(key, value) {
    const row = {key,value:JSON.stringify(value),updated_at:new Date().toISOString()}
    await this.db.table('settings').insert(row).onConflict('key').merge(['value','updated_at'])
    return value
  }
  async has(key) { return !!(await this.db.table('settings').select('key').where({key}).first()) }
  async remove(key) { await this.db.table('settings').where({key}).delete() }
  async all() {
    const rows = await this.db.table('settings').select('key','value').orderBy('key')
    return Object.fromEntries(rows.map(row=>[row.key,JSON.parse(row.value)]))
  }
}
