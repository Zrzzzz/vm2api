import type { PostgresDatabase } from '../database.mts'
/**
 * users repository — sub2api-shaped users table.
 *
 * Superset of the old PanelUsersRepo contract: console operators are now
 * first-class users with balance/concurrency. `enabled` is projected from
 * status ('active' ↔ enabled) so panel-users.mjs keeps its record shape.
 * Soft delete: rows with deleted_at are invisible to every query here.
 */

const COLUMNS = [
  'id',
  'email',
  'username',
  'password_hash',
  'role',
  'balance',
  'concurrency',
  'vm_create_quota',
  'status',
  'notes',
  'last_login_at',
  'last_active_at',
  'created_at',
  'updated_at',
  'deleted_at',
] as const

export interface UserRecord {
  id: string
  email: string
  username: string
  password_hash: string
  role: string
  balance: number
  concurrency: number
  vm_create_quota: number
  status: string
  enabled: boolean
  notes: string
  last_login_at: string | null
  last_active_at: string | null
  created_at: string | null
  updated_at: string | null
}
type UserRow = Omit<UserRecord, 'enabled'> & { deleted_at: string | null }
export type UserWrite = Pick<UserRecord, 'id' | 'username' | 'password_hash' | 'role' | 'created_at' | 'updated_at'> &
  Partial<Omit<UserRecord, 'id' | 'username' | 'password_hash' | 'role' | 'created_at' | 'updated_at'>>

function rowToRec(row: UserRow): UserRecord
function rowToRec(row: UserRow | undefined): UserRecord | null
function rowToRec(row: UserRow | undefined): UserRecord | null {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    password_hash: row.password_hash,
    role: row.role,
    balance: Number(row.balance) || 0,
    concurrency: Number(row.concurrency) || 0,
    vm_create_quota: Number(row.vm_create_quota) || 0,
    status: row.status,
    enabled: row.status === 'active',
    notes: row.notes ?? '',
    last_login_at: row.last_login_at,
    last_active_at: row.last_active_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function statusOf(rec: Pick<UserWrite, 'enabled' | 'status'>) {
  // explicit boolean `enabled` wins over a stale status carried on the record
  if (typeof rec.enabled === 'boolean') return rec.enabled ? 'active' : 'disabled'
  return rec.status ?? 'active'
}

export class UsersRepo {
  readonly db: PostgresDatabase
  private readonly _list: string
  private readonly _get: string
  private readonly _getByName: string
  private readonly _insert: string
  private readonly _softDelete: string
  private readonly _countRole: string
  private readonly _addBalance: string

  constructor(db: PostgresDatabase) {
    this.db = db
    this._list = 'SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at, username'
    this._get = 'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL'
    this._getByName = 'SELECT * FROM users WHERE ascii_fold(username) = ascii_fold($1) AND deleted_at IS NULL'
    this._insert =
      '\n      INSERT INTO users (id, email, username, password_hash, role, balance, concurrency, vm_create_quota, status, notes, last_login_at, last_active_at, created_at, updated_at, deleted_at)\n      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)\n    '
    this._softDelete = 'UPDATE users SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL'
    this._countRole = "SELECT COUNT(*) AS c FROM users WHERE role = $1 AND status = 'active' AND deleted_at IS NULL"
    this._addBalance = 'UPDATE users SET balance = balance + $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL'
  }

  async list(): Promise<UserRecord[]> {
    return (await this.db.query<UserRow>(this._list, [])).rows.map((row) => rowToRec(row))
  }

  async getById(id: string): Promise<UserRecord | null> {
    return rowToRec((await this.db.query<UserRow>(this._get, [id])).rows[0])
  }

  async getByUsername(username: string): Promise<UserRecord | null> {
    return rowToRec((await this.db.query<UserRow>(this._getByName, [String(username || '').trim()])).rows[0])
  }

  async insert(rec: UserWrite): Promise<UserRecord | null> {
    await this.db.query(this._insert, [
      ...COLUMNS.map((c) => {
        if (c === 'email') return rec.email ?? `${rec.username}@panel.local`
        if (c === 'status') return statusOf(rec)
        if (c === 'balance') return rec.balance ?? 0
        if (c === 'concurrency') return rec.concurrency ?? 5
        if (c === 'vm_create_quota') return rec.vm_create_quota ?? 0
        if (c === 'notes') return rec.notes ?? ''
        if (c === 'deleted_at') return null
        return rec[c] ?? null
      }),
    ])
    return await this.getById(rec.id)
  }

  async update(rec: UserWrite): Promise<UserRecord | null> {
    const cols = COLUMNS.filter((c) => c !== 'id' && c !== 'deleted_at')
    const sql = `UPDATE users SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1} AND deleted_at IS NULL`
    await this.db.query(sql, [
      ...cols.map((c) => {
        if (c === 'email') return rec.email ?? `${rec.username}@panel.local`
        if (c === 'status') return statusOf(rec)
        if (c === 'balance') return rec.balance ?? 0
        if (c === 'concurrency') return rec.concurrency ?? 5
        if (c === 'vm_create_quota') return rec.vm_create_quota ?? 0
        if (c === 'notes') return rec.notes ?? ''
        return rec[c] ?? null
      }),
      rec.id,
    ])
    return await this.getById(rec.id)
  }

  /** Soft delete (sub2api SoftDeleteMixin semantics). */
  async remove(id: string): Promise<boolean> {
    const now = new Date().toISOString()
    return Number((await this.db.query(this._softDelete, [now, now, id])).rowCount) > 0
  }

  async countEnabledRole(role: string): Promise<number> {
    const row = (await this.db.query<{ c: number }>(this._countRole, [role])).rows[0]
    return Number(row?.c || 0)
  }

  /** Atomic balance credit/debit (redeem, billing). Negative delta = charge. */
  async addBalance(id: string, delta: number): Promise<UserRecord | null> {
    await this.db.query(this._addBalance, [Number(delta) || 0, new Date().toISOString(), id])
    return await this.getById(id)
  }
}
