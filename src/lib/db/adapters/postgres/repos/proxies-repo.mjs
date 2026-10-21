/**
 * proxies repository — SOCKS5 pool rows + pool config in settings.
 * The ProxyPool keeps its working set in memory (probe loop mutates it);
 * this repo is the persistence surface: loadAll / replaceAll.
 */

import { getDb } from '../../../database.mjs'
import { SettingsRepo } from '../../../repos/settings-repo.mjs'

const CONFIG_KEY = 'proxy_pool_config'

const COLUMNS = [
  'id',
  'protocol',
  'host',
  'port',
  'username',
  'password',
  'raw',
  'status',
  'enabled',
  'name',
  'label',
  'owner_user_id',
  'bound_vm_id',
  'consecutive_failures',
  'latency_ms',
  'last_probe_at',
  'last_error',
  'geo_ip',
  'geo_country',
  'geo_country_code',
  'geo_region',
  'geo_city',
  'geo_isp',
  'geo_timezone',
  'geo_checked_at',
  'geo_error',
  'geo_v6_ip',
  'geo_v6_country',
  'geo_v6_country_code',
  'geo_v6_region',
  'geo_v6_city',
  'geo_v6_isp',
  'geo_v6_timezone',
  'geo_v6_checked_at',
  'geo_v6_error',
  'created_at',
  'updated_at',
  'domain_forward',
]

function rowToProxy(row) {
  if (!row) return null
  // ProxyPool still speaks `scheme`; the column is sub2api's `protocol`.
  return { ...row, scheme: row.protocol, enabled: !!row.enabled, domain_forward: !!row.domain_forward }
}

export class ProxiesRepo {
  constructor(db = getDb()) {
    this.db = db
    this.settings = new SettingsRepo(db)
    this._all = "SELECT * FROM proxies ORDER BY created_at, id"
    this._clear = "DELETE FROM proxies"
    this._insert = "\n      INSERT INTO proxies (id, protocol, host, port, username, password, raw, status, enabled, name, label, owner_user_id, bound_vm_id, consecutive_failures, latency_ms, last_probe_at, last_error, geo_ip, geo_country, geo_country_code, geo_region, geo_city, geo_isp, geo_timezone, geo_checked_at, geo_error, geo_v6_ip, geo_v6_country, geo_v6_country_code, geo_v6_region, geo_v6_city, geo_v6_isp, geo_v6_timezone, geo_v6_checked_at, geo_v6_error, created_at, updated_at, domain_forward)\n      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38)\n    "
  }

  async loadAll() {
    return (await this.db.query(this._all, [])).rows.map(rowToProxy)
  }

  async replaceAll(proxies = []) {
    await this.db.transaction(async () => {
      ;(await this.db.query(this._clear, []))
      for (const p of proxies) {
        ;(await this.db.query(this._insert, [...COLUMNS.map((c) => {
            if (c === 'enabled') return p.enabled === false ? 0 : 1
            if (c === 'domain_forward') return p.domain_forward ? 1 : 0
            if (c === 'protocol') return p.protocol ?? p.scheme ?? 'socks5'
            if (c === 'name') return p.name ?? (p.host && p.port != null ? `${p.host}:${p.port}` : p.id)
            return p[c] ?? null
          })]))
      }
    })
  }

  async getConfig(fallback = null) {
    return (await this.settings.get(CONFIG_KEY, fallback))
  }

  async setConfig(config) {
    return (await this.settings.set(CONFIG_KEY, config))
  }
}
