import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { PostgresDatabase, postgresConfig } from '../src/lib/db/adapters/postgres/database.mts'

const identifier = (name) => '"' + name.replaceAll('"', '""') + '"'
const MASK = (1n << 256n) - 1n
export function rowDigest(row, columns) {
  return BigInt('0x' + crypto.createHash('sha256').update(JSON.stringify(columns.map((c) => c === 'record_json' ? crypto.createHash('sha256').update(row[c]).digest('hex') : row[c]))).digest('hex'))
}

/** Import an offline consistent SQLite snapshot into an empty PostgreSQL schema. */
export async function migrateSnapshot(snapshot, target, { baseline, onTable = () => {} } = {}) {
  const source = new DatabaseSync(snapshot, { readOnly: true })
  try {
    assert.equal(Object.values(source.prepare('PRAGMA quick_check').get())[0], 'ok', 'SQLite integrity check failed')
    const tables = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name)
    await target.initializeBaseline(baseline)
    const existing = await target.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename <> 'postgres_schema_migrations' ORDER BY tablename")
    assert.deepEqual(existing.rows.map((r) => r.tablename), tables, 'Source and target table sets differ')
    const report = []
    // One transaction: an interrupted or failed copy cannot publish a partial import.
    await target.transaction(async () => {
      await target.query('SET LOCAL statement_timeout=0')
      await target.query('SET CONSTRAINTS ALL DEFERRED')
      for (const table of tables) {
        const count = await target.query(`SELECT count(*) AS n FROM ${identifier(table)}`)
        assert.equal(count.rows[0].n, 0, `Refusing to overwrite non-empty table ${table}`)
      }
      // Parent tables before child tables; other tables have no foreign keys.
      const ordered = [...tables].sort((a,b) => (a==='vm_pools'?-1:a==='vm_pool_members'?1:0)-(b==='vm_pools'?-1:b==='vm_pool_members'?1:0))
      for (const table of ordered) {
        const columns = source.prepare(`PRAGMA table_info(${identifier(table)})`).all().map((c) => c.name)
        let sourceHash = 0n, sourceCount = 0
        let iterable = source.prepare(`SELECT * FROM ${identifier(table)} ORDER BY rowid`).iterate()
        if (table === 'cluster_nodes') {
          const pending = Array.from(iterable), orderedRows = [], done = new Set()
          while (pending.length) {
            const next = pending.findIndex((r) => !r.jump_node_id || done.has(r.jump_node_id))
            if (next < 0) throw new Error('Cyclic cluster node jump references')
            const [row] = pending.splice(next, 1); orderedRows.push(row); done.add(row.id)
          }
          iterable = orderedRows
        }
        let chunk = []
        const flush = async () => {
          if (!chunk.length) return
          const values = []
          const tuples = chunk.map((row) => '(' + columns.map((c) => {values.push(row[c]); return '$' + values.length}).join(',') + ')')
          await target.query(`INSERT INTO ${identifier(table)} (${columns.map(identifier).join(',')}) VALUES ${tuples.join(',')}`, values)
          chunk = []
        }
        for (const row of iterable) {
          sourceHash = (sourceHash + rowDigest(row, columns)) & MASK
          sourceCount++
          chunk.push(row)
          if (chunk.length === (table === 'request_log_debug' ? 1 : 10)) await flush()
        }
        await flush()
        const schema = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql
        if (/AUTOINCREMENT/i.test(schema)) {
          const pk=source.prepare(`PRAGMA table_info(${identifier(table)})`).all().find((c)=>c.pk).name
          await target.query(`SELECT setval(pg_get_serial_sequence($1,$2), COALESCE((SELECT MAX(${identifier(pk)}) FROM ${identifier(table)}),1), EXISTS(SELECT 1 FROM ${identifier(table)}))`,[table,pk])
        }
        // Order-independent SHA-256 multiset fingerprints preserve duplicate counts.
        let targetHash = 0n, targetCount = 0
        const verifyColumns = table === 'request_log_debug'
          ? columns.map(c => c === 'record_json' ? `encode(sha256(convert_to(record_json, 'UTF8')), 'hex') AS record_json_hash` : identifier(c)).join(',')
          : '*'
        await target.query(`DECLARE migration_verify NO SCROLL CURSOR FOR SELECT ${verifyColumns} FROM ${identifier(table)}`)
        try {
          while (true) {
            const {rows} = await target.query('FETCH FORWARD 10 FROM migration_verify')
            if (!rows.length) break
            for (const row of rows) {
              const digest = table === 'request_log_debug'
                ? BigInt('0x' + crypto.createHash('sha256').update(JSON.stringify(columns.map(c => c === 'record_json' ? row.record_json_hash : row[c]))).digest('hex'))
                : rowDigest(row, columns)
              targetHash = (targetHash + digest) & MASK
              targetCount++
            }
          }
        } finally {await target.query('CLOSE migration_verify')}
        assert.equal(targetCount, sourceCount, `Row count mismatch: ${table}`)
        assert.equal(targetHash, sourceHash, `Data mismatch: ${table}`)
        const result = {table, rows: sourceCount, sha256_multiset: sourceHash.toString(16).padStart(64,'0')}
        report.push(result); onTable({table, rows: sourceCount})
      }
    })
    return {ok:true,tables:report,verified_rows:report.reduce((sum,r)=>sum+r.rows,0)}
  } finally {source.close()}
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Provide a consistent SQLite snapshot path')
  const target=new PostgresDatabase({...postgresConfig(), query_timeout:0})
  try {
    const baseline=fs.readFileSync(new URL('../src/lib/db/postgres-migrations/001_baseline.sql',import.meta.url),'utf8')
    const report=await migrateSnapshot(process.argv[2],target,{baseline,onTable:(row)=>console.error(JSON.stringify(row))})
    console.log(JSON.stringify(report,null,2))
  } catch (error) {
    console.error(JSON.stringify({ok:false,code:error.code||'migration_failed',error_type:error.name}))
    process.exitCode=1
  } finally {await target.close()}
}
