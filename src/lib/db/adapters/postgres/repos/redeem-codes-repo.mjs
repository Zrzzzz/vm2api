/**
 * redeem_codes repository — balance top-up codes (sub2api baseline shape).
 * Redeem is transactional: code flips unused→used and the user's balance is
 * credited in the same transaction (sub2api RedeemService counterpart).
 */

import crypto from 'node:crypto'
import { getDb } from '../../../database.mjs'
import { UsersRepo } from './users-repo.mts'

function rowToRec(row) {
  if (!row) return null
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    value: Number(row.value) || 0,
    status: row.status,
    used_by: row.used_by,
    used_at: row.used_at,
    notes: row.notes,
    expires_at: row.expires_at,
    created_at: row.created_at,
  }
}

export function generateRedeemCode() {
  return 'kin-' + crypto.randomBytes(12).toString('hex')
}

export class RedeemCodesRepo {
  constructor(db = getDb()) {
    this.db = db
    this.users = new UsersRepo(db)
    this._list = "SELECT * FROM redeem_codes ORDER BY id DESC"
    this._get = "SELECT * FROM redeem_codes WHERE id = $1"
    this._getByCode = "SELECT * FROM redeem_codes WHERE code = $1"
    this._insert = "\n      INSERT INTO redeem_codes (code, type, value, status, notes, expires_at, created_at)\n      VALUES ($1, 'balance', $2, 'unused', $3, $4, $5) RETURNING id\n    "
    this._markUsed = "\n      UPDATE redeem_codes SET status = 'used', used_by = $1, used_at = $2\n      WHERE id = $3 AND status = 'unused'\n    "
    this._delete = "DELETE FROM redeem_codes WHERE id = $1 AND status = 'unused'"
  }

  async list() {
    return (await this.db.query(this._list, [])).rows.map(rowToRec)
  }

  async getByCode(code) {
    return rowToRec((await this.db.query(this._getByCode, [String(code || '').trim()])).rows[0])
  }

  async create({ value, notes = null, expires_at = null, code = null } = {}) {
    const v = Number(value)
    if (!Number.isFinite(v) || v <= 0) return null
    const c = code || generateRedeemCode()
    const info = (await this.db.query(this._insert, [c, v, notes, expires_at, new Date().toISOString()]))
    return rowToRec((await this.db.query(this._get, [info.rows[0].id])).rows[0])
  }

  /** Unused codes only; used codes stay as the audit ledger. */
  async remove(id) {
    return (await this.db.query(this._delete, [id])).rowCount > 0
  }

  /**
   * Redeem a code for a user: optimistic status flip + balance credit in one
   * transaction. Returns {ok, code?, error?}.
   */
  async redeem(code, userId) {
    const rec = (await this.getByCode(code))
    if (!rec) return { ok: false, error: 'code_not_found' }
    if (rec.status !== 'unused') return { ok: false, error: 'code_used' }
    if (rec.expires_at && Date.parse(rec.expires_at) < Date.now()) {
      return { ok: false, error: 'code_expired' }
    }
    const user = (await this.users.getById(userId))
    if (!user) return { ok: false, error: 'user_not_found' }
    return await this.db.transaction(async () => {
      const info = (await this.db.query(this._markUsed, [userId, new Date().toISOString(), rec.id]))
      if (!info.rowCount) return { ok: false, error: 'code_used' }
      const credited = await this.users.addBalance(userId, rec.value)
      if (!credited) throw new Error('Redeem user no longer exists')
      return { ok: true, code: rowToRec((await this.db.query(this._get, [rec.id])).rows[0]) }
    })
  }
}
