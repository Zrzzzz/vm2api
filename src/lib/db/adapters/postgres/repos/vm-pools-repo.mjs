/**
 * Named slot pools. Membership is the schedule source for keys with vm_pool_id.
 * A vm_id can appear in only one pool (unique index).
 */
import crypto from 'node:crypto'
import { getDb } from '../../../database.mjs'

function nowIso() {
  return new Date().toISOString()
}

function rowToPool(row, vmIds) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    vm_ids: vmIds,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export class VmPoolsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._list = "SELECT * FROM vm_pools ORDER BY created_at, id"
    this._get = "SELECT * FROM vm_pools WHERE id = $1"
    this._members = "SELECT vm_id FROM vm_pool_members WHERE pool_id = $1 ORDER BY vm_id"
    this._allMembers = "SELECT pool_id, vm_id FROM vm_pool_members ORDER BY vm_id"
    this._insert = "INSERT INTO vm_pools (id, name, enabled, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)"
    this._name = "UPDATE vm_pools SET name = $1, updated_at = $2 WHERE id = $3"
    this._enabled = "UPDATE vm_pools SET enabled = $1, updated_at = $2 WHERE id = $3"
    this._touch = "UPDATE vm_pools SET updated_at = $1 WHERE id = $2"
    this._delete = "DELETE FROM vm_pools WHERE id = $1"
    this._clearMembers = "DELETE FROM vm_pool_members WHERE pool_id = $1"
    this._addMember = "INSERT INTO vm_pool_members (pool_id, vm_id, created_at) VALUES ($1, $2, $3)"
    this._other = "SELECT pool_id FROM vm_pool_members WHERE vm_id = $1 AND pool_id != $2"
    this._keyCount = "SELECT COUNT(*) AS n FROM api_keys WHERE vm_pool_id = $1 AND deleted_at IS NULL"
  }

  async _ids(poolId) {
    return (await this.db.query(this._members, [poolId])).rows.map((row) => row.vm_id)
  }

  async list() {
    const grouped = new Map()
    for (const row of (await this.db.query(this._allMembers, [])).rows) {
      const list = grouped.get(row.pool_id) || []
      list.push(row.vm_id)
      grouped.set(row.pool_id, list)
    }
    return (await this.db.query(this._list, [])).rows.map((row) => rowToPool(row, grouped.get(row.id) || []))
  }

  async get(id) {
    const row = (await this.db.query(this._get, [id])).rows[0]
    if (!row) return null
    return rowToPool(row, (await this._ids(id)))
  }

  async countKeys(id) {
    return Number((await this.db.query(this._keyCount, [id])).rows[0]?.n) || 0
  }

  async insert({ name, enabled = true }) {
    const now = nowIso()
    const id = `pool_${crypto.randomBytes(4).toString('hex')}`
    try {
      ;(await this.db.query(this._insert, [id, name, enabled ? 1 : 0, now, now]))
    } catch (error) {
      throw mapConstraint(error)
    }
    return (await this.get(id))
  }

  async rename(id, name) {
    try {
      const info = (await this.db.query(this._name, [name, nowIso(), id]))
      if (!info.rowCount) return null
    } catch (error) {
      throw mapConstraint(error)
    }
    return (await this.get(id))
  }

  async setEnabled(id, enabled) {
    const info = (await this.db.query(this._enabled, [enabled ? 1 : 0, nowIso(), id]))
    if (!info.rowCount) return null
    return (await this.get(id))
  }

  /**
   * Replace membership. A vm already in another pool is rejected and nothing
   * is written. Passing the same vm ids is a no-op aside from updated_at.
   */
  async setMembers(id, vmIds) {
    if (!(await this.db.query(this._get, [id])).rows[0]) return null
    for (const vmId of vmIds) {
      const other = (await this.db.query(this._other, [vmId, id])).rows[0]
      if (other) {
        throw Object.assign(new Error(`槽位 ${vmId} 已在其他账号池`), {
          code: 'vm_in_other_pool',
          vm_id: vmId,
          pool_id: other.pool_id,
        })
      }
    }
    const now = nowIso()
    await this.db.transaction(async () => {
      ;(await this.db.query(this._clearMembers, [id]))
      for (const vmId of vmIds) { await this.db.query(this._addMember, [id, vmId, now]) }
      ;(await this.db.query(this._touch, [now, id]))
    })
    return (await this.get(id))
  }

  async remove(id) {
    const info = (await this.db.query(this._delete, [id]))
    return info.rowCount > 0
  }
  async removeVm(vmId) {
    const result = await this.db.query('DELETE FROM vm_pool_members WHERE vm_id = $1', [String(vmId)])
    return result.rowCount || 0
  }

  async pruneUnknown(knownIds) {
    const known = new Set([...knownIds].map(String))
    const stale = (await this.db.query('SELECT DISTINCT vm_id FROM vm_pool_members')).rows
      .map(row => row.vm_id).filter(id => !known.has(id))
    for (const id of stale) await this.removeVm(id)
    return stale
  }

}

function mapConstraint(error) {
  const message = String(error?.message || error)
  if (error?.code === '23505' && /vm_pools|name/i.test(error.constraint || '')) {
    return Object.assign(new Error('账号池名称已存在'), { code: 'vm_pool_name_taken' })
  }
  return error
}
