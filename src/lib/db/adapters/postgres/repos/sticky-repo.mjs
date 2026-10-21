/**
 * sticky_sessions repository — conversation key → account/VM bindings.
 */

import { getDb } from '../../../database.mjs'

function rowToEntry(row) {
  if (!row) return null
  return {
    account_id: row.account_id,
    vm_id: row.vm_id,
    session_id: row.session_id,
    device_id: row.device_id || null,
    bound_at: row.bound_at,
    expires_at: row.expires_at,
    hits: row.hits || 0,
    generation: Number(row.generation) || 0,
    slot_index: row.slot_index == null ? null : Number(row.slot_index),
  }
}

export class StickyRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = "SELECT * FROM sticky_sessions WHERE key = $1"
    this._upsert = "\n      INSERT INTO sticky_sessions (key, account_id, vm_id, session_id, device_id, bound_at, expires_at, hits, generation, slot_index)\n      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)\n      ON CONFLICT(key) DO UPDATE SET\n        account_id = excluded.account_id,\n        vm_id = excluded.vm_id,\n        session_id = excluded.session_id,\n        device_id = COALESCE(excluded.device_id, sticky_sessions.device_id),\n        bound_at = excluded.bound_at,\n        expires_at = excluded.expires_at,\n        hits = excluded.hits,\n        generation = excluded.generation,\n        slot_index = excluded.slot_index\n    "
    this._delete = "DELETE FROM sticky_sessions WHERE key = $1"
    this._deleteByAccount = "DELETE FROM sticky_sessions WHERE account_id = $1 OR vm_id = $2"
    this._purge = "DELETE FROM sticky_sessions WHERE expires_at < $1"
    this._dropAlias = "\n      DELETE FROM sticky_sessions\n      WHERE key = 'envelope'\n        OR key LIKE 'ch:%'\n        OR key LIKE 'dev:%'\n        OR key LIKE '%:envelope'\n        OR key LIKE '%:ch:%'\n        OR key LIKE '%:dev:%'\n    "
    this._all = "SELECT * FROM sticky_sessions"
    this._count = "SELECT COUNT(*) c FROM sticky_sessions"
  }

  async get(key) {
    return rowToEntry((await this.db.query(this._get, [key])).rows[0])
  }

  async upsert(key, ent) {
    ;(await this.db.query(this._upsert, [key, ent.account_id ?? null, ent.vm_id ?? null, ent.session_id ?? null, ent.device_id ?? null, ent.bound_at ?? Date.now(), ent.expires_at ?? null, ent.hits ?? 0, Number(ent.generation) || 0, ent.slot_index == null ? null : Number(ent.slot_index)]))
  }

  async remove(key) {
    ;(await this.db.query(this._delete, [key]))
  }

  async removeByAccount({ accountId = null, vmId = null } = {}) {
    if (!accountId && !vmId) return 0
    return (await this.db.query(this._deleteByAccount, [accountId || '', vmId || ''])).rowCount
  }

  async purgeExpired(now = Date.now()) {
    return (await this.db.query(this._purge, [now])).rowCount
  }

  /** Content fingerprints and device aliases are not conversation slots. */
  async dropAliasKeys() {
    return (await this.db.query(this._dropAlias, [])).rowCount
  }

  async all() {
    const out = {}
    for (const row of (await this.db.query(this._all, [])).rows) out[row.key] = rowToEntry(row)
    return out
  }

  async count() {
    return (await this.db.query(this._count, [])).rows[0].c
  }
}
