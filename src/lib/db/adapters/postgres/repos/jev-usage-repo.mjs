import { getDb } from '../../../database.mjs'
import { shanghaiUsageDay } from '../../../../protocol/jev-usage.mjs'

const FIELDS = ['id', 'created_at', 'request_id', 'provider', 'model', 'key_fingerprint', 'http_status',
  'outcome', 'duration_ms', 'input_tokens', 'output_tokens', 'estimated_cost_nano_usd',
  'input_nano_usd_per_token', 'output_nano_usd_per_token', 'pricing_basis']
const COUNTS = ['requests', 'successful', 'input_tokens', 'output_tokens', 'unknown_usage_requests',
  'estimated_cost_nano_usd', 'unknown_cost_requests']
const empty = () => Object.fromEntries(COUNTS.map(name => [name, 0]))

export class JevUsageRepo {
  constructor(db = getDb(), { now = Date.now } = {}) {
    this.db = db
    this.now = now
    this.nextPruneAt = 0
  }
  async record(event) {
    const amounts = [1, event.outcome === 'success' ? 1 : 0, event.input_tokens ?? 0, event.output_tokens ?? 0,
      event.input_tokens === null || event.output_tokens === null ? 1 : 0,
      event.estimated_cost_nano_usd ?? 0, event.estimated_cost_nano_usd === null ? 1 : 0]
    await this.db.transaction(async () => {
      await this.db.query(`INSERT INTO jev_usage_events (${FIELDS.join(',')}) VALUES (${FIELDS.map((_, i) => '$' + (i + 1)).join(',')})`, FIELDS.map(name => event[name]))
      for (const period of ['all', shanghaiUsageDay(event.created_at)]) {
        await this.db.query(`INSERT INTO jev_usage_totals (period,${COUNTS.join(',')}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT(period) DO UPDATE SET ${COUNTS.map(name => `${name}=jev_usage_totals.${name}+excluded.${name}`).join(',')}`,
          [period, ...amounts])
      }
    })
    const now = this.now()
    if (now >= this.nextPruneAt) {
      this.nextPruneAt = now + 60000
      await this.db.query('DELETE FROM jev_usage_events WHERE id IN (SELECT id FROM jev_usage_events WHERE created_at < $1 ORDER BY created_at,id LIMIT 500)', [new Date(now - 30 * 86400000).toISOString()])
      await this.db.query("DELETE FROM jev_usage_totals WHERE period IN (SELECT period FROM jev_usage_totals WHERE period <> 'all' AND period < $1 LIMIT 32)", [shanghaiUsageDay(new Date(now - 90 * 86400000).toISOString())])
    }
  }
  async overview() {
    const today = shanghaiUsageDay(new Date(this.now()).toISOString())
    const rows = (await this.db.query("SELECT * FROM jev_usage_totals WHERE period IN ('all', $1)", [today])).rows
    const total = empty(), daily = empty()
    for (const row of rows) {
      const target = row.period === 'all' ? total : daily
      for (const name of COUNTS) target[name] += Number(row[name])
    }
    return {
      started_at: (await this.db.query('SELECT started_at FROM jev_usage_meta WHERE id=1')).rows[0]?.started_at ?? null,
      day: today, timezone: 'Asia/Shanghai', total, today: daily, detail_retention_days: 30,
    }
  }
  async list({ limit = 50, cursor_created_at = '', cursor_id = '', key_fingerprint = '' } = {}) {
    limit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 50)))
    const where = [], args = []
    if (cursor_created_at || cursor_id) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor_created_at) || !/^[a-f0-9-]{36}$/.test(cursor_id)) throw new TypeError('Invalid cursor')
      where.push('(created_at,id) < ($1,$2)')
      args.push(cursor_created_at, cursor_id)
    }
    if (key_fingerprint) {
      if (!/^[a-f0-9]{12}$/.test(key_fingerprint)) throw new TypeError('Invalid key fingerprint')
      args.push(key_fingerprint)
      where.push(`key_fingerprint=$${args.length}`)
    }
    args.push(limit + 1)
    const rows = (await this.db.query(`SELECT ${FIELDS.join(',')} FROM jev_usage_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC,id DESC LIMIT $${args.length}`, args)).rows
    const more = rows.length > limit
    if (more) rows.pop()
    const last = rows.at(-1)
    return { rows, has_more: more, next_cursor: more && last ? { created_at: last.created_at, id: last.id } : null }
  }
}
