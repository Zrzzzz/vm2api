/**
 * Permanent ban of an inbound client device_id after a refusal-guard hit.
 * Empty ids are never stored. This is not the slot's outbound device.
 */
import { getDb } from '../../../database.mjs'

function rowToRec(row) {
  if (!row) return null
  return {
    device_id: row.device_id,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    hit_count: Number(row.hit_count) || 0,
    source_request_id: row.source_request_id,
    fingerprint: row.fingerprint,
    reason: row.reason,
  }
}

export class RefusalDeviceBlocksRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = "SELECT * FROM refusal_device_blocks WHERE device_id = $1"
    this._insert = "\n      INSERT INTO refusal_device_blocks (\n        device_id, first_seen_at, last_seen_at, hit_count,\n        source_request_id, fingerprint, reason\n      ) VALUES ($1, $2, $3, 0, $4, $5, $6)\n      ON CONFLICT(device_id) DO UPDATE SET\n        last_seen_at = excluded.last_seen_at,\n        source_request_id = COALESCE(refusal_device_blocks.source_request_id, excluded.source_request_id),\n        fingerprint = COALESCE(refusal_device_blocks.fingerprint, excluded.fingerprint),\n        reason = COALESCE(refusal_device_blocks.reason, excluded.reason)\n    "
    this._hit = "\n      UPDATE refusal_device_blocks SET hit_count = hit_count + 1, last_seen_at = $1\n      WHERE device_id = $2\n    "
    this._list = "SELECT * FROM refusal_device_blocks ORDER BY last_seen_at DESC, device_id LIMIT $1"
    this._count = "SELECT COUNT(*) AS n FROM refusal_device_blocks"
    this._remove = "DELETE FROM refusal_device_blocks WHERE device_id = $1"
    this._clear = "DELETE FROM refusal_device_blocks"
  }

  async get(deviceId) {
    const id = String(deviceId || '').trim()
    if (!id) return null
    return rowToRec((await this.db.query(this._get, [id])).rows[0])
  }

  async block({ deviceId = null, requestId = null, fingerprint = null, reason = 'refusal_guard' } = {}) {
    const id = String(deviceId || '').trim()
    if (!id) return null
    const now = new Date().toISOString()
    ;(await this.db.query(this._insert, [id, now, now, requestId, fingerprint, reason ? String(reason).slice(0, 80) : null]))
    return (await this.get(id))
  }

  async hit(deviceId) {
    const id = String(deviceId || '').trim()
    if (!id) return null
    ;(await this.db.query(this._hit, [new Date().toISOString(), id]))
    return (await this.get(id))
  }

  async list(limit = 200) {
    const n = Math.min(500, Math.max(1, Number(limit) || 200))
    return (await this.db.query(this._list, [n])).rows.map(rowToRec)
  }

  async count() {
    return Number((await this.db.query(this._count, [])).rows[0]?.n) || 0
  }

  async remove(deviceId) {
    const id = String(deviceId || '').trim()
    if (!id) return false
    return (await this.db.query(this._remove, [id])).rowCount > 0
  }

  async clear() {
    return (await this.db.query(this._clear, [])).rowCount
  }
}
