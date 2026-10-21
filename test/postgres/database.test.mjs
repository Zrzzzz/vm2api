import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { PostgresDatabase, postgresConfig } from '../../src/lib/db/adapters/postgres/database.mjs'
import { createDatabase } from './fixtures/sqlite-source.mjs'
import { migrateSnapshot } from '../../scripts/migrate-sqlite-to-postgres.mjs'

const baseline = fs.readFileSync(new URL('../../src/lib/db/postgres-migrations/001_baseline.sql',import.meta.url),'utf8')
async function fresh() {
  const root = new PostgresDatabase(postgresConfig())
  const schema = 'migration_test_'+crypto.randomBytes(8).toString('hex')
  await root.query(`CREATE SCHEMA ${schema}`)
  await root.close()
  return new PostgresDatabase(postgresConfig({...process.env,PGSCHEMA:schema}))
}

test('production pool is capped and remote TLS cannot be disabled',()=>{
  const env={PGHOST:'example.invalid',PGDATABASE:'test',PGUSER:'test',PGPASSWORD:'test'}
  assert.equal(postgresConfig(env).max,15)
  assert.throws(()=>postgresConfig({...env,PGPOOL_MAX:'21'}),/1..20/)
  assert.throws(()=>postgresConfig({...env,PGSSLMODE:'disable'}),/verified TLS/)
})

test('concurrent transactions own connections, rollback does not affect another transaction',async()=>{
  const db=await fresh()
  try {
    await db.query('CREATE TABLE events (id bigint PRIMARY KEY)')
    const results=await Promise.allSettled([
      db.transaction(async()=>{await db.query('INSERT INTO events VALUES ($1)',[1]);await new Promise(r=>setTimeout(r,30));throw new Error('expected')}),
      db.transaction(async()=>{await db.query('INSERT INTO events VALUES ($1)',[2]);await new Promise(r=>setTimeout(r,50))}),
    ])
    assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled')
    assert.deepEqual((await db.query('SELECT * FROM events')).rows,[{id:2}])
    await assert.rejects(db.transaction(()=>db.transaction(()=>{})),/Nested/)
  } finally {await db.close()}
})

test('all-table migration preserves values, identity sequences and case-insensitive uniqueness',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vm2api-full-migration-'))
  const file=path.join(dir,'source.db')
  const src=createDatabase({dbPath:file})
  src.prepare("INSERT INTO users (id,email,username,password_hash) VALUES (?,?,?,?)").run('u','u@example.test','AdminCase','hash-test')
  src.prepare("INSERT INTO request_log_debug VALUES (?,?,?)").run('req','2000-01-01T00:00:00Z','{ "input":"中文🙂", "output":"完整输出", "large":9007199254740993 }')
  src.prepare("INSERT INTO sticky_sessions (key,bound_at) VALUES (?,?)").run('millis',1790000000000)
  src.close()
  const sourceHash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const db=await fresh()
  try {
    const result=await migrateSnapshot(file,db,{baseline})
    assert.equal(result.ok,true);assert.equal(result.tables.length,28)
    assert.equal((await db.query('SELECT bound_at FROM sticky_sessions')).rows[0].bound_at,1790000000000)
    assert.equal((await db.query('SELECT record_json FROM request_log_debug')).rows[0].record_json,'{ "input":"中文🙂", "output":"完整输出", "large":9007199254740993 }')
    await assert.rejects(db.query("INSERT INTO users (id,email,username,password_hash) VALUES ('u2','different@example.test','admincase','hash')"),{code:'23505'})
    const g=await db.query("INSERT INTO groups (name) VALUES ('next') RETURNING id")
    assert.equal(g.rows[0].id,3)
    await assert.rejects(migrateSnapshot(file,db,{baseline}),/Refusing to overwrite/)
    assert.equal((await db.query('SELECT count(*) AS n FROM users')).rows[0].n,1)
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),sourceHash)
  } finally {await db.close()}
})

test('final delta sync preserves unchanged bodies and reconciles inserts, updates and deletions',async()=>{
 const {DatabaseSync}=await import('node:sqlite')
 const {syncSnapshot}=await import('../../scripts/sync-sqlite-to-postgres.mjs')
 const {verifySnapshot}=await import('../../scripts/verify-sqlite-postgres.mjs')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vm2api-delta-')),file=path.join(dir,'source.db')
 const source=createDatabase({dbPath:file})
 source.prepare('INSERT INTO request_log_debug VALUES (?,?,?)').run('keep','2000-01-01','{"input":"保留"}')
 source.prepare('INSERT INTO request_log_debug VALUES (?,?,?)').run('change','2000-01-01','{"input":"旧值"}')
 source.prepare('INSERT INTO settings VALUES (?,?,?)').run('remove','true','2000-01-01')
 source.close()
 const db=await fresh()
 try{
  await migrateSnapshot(file,db,{baseline})
  const edit=new DatabaseSync(file)
  edit.prepare('UPDATE request_log_debug SET record_json=? WHERE request_id=?').run('{"input":"新值"}','change')
  edit.prepare('INSERT INTO request_log_debug VALUES (?,?,?)').run('insert','2000-01-02','{"output":"新增"}')
  edit.prepare('DELETE FROM settings WHERE key=?').run('remove');edit.close()
  const result=await syncSnapshot(file,db)
  const debug=result.tables.find(r=>r.table==='request_log_debug')
  assert.deepEqual({inserted:debug.inserted,updated:debug.updated,rows:debug.rows},{inserted:1,updated:1,rows:3})
  assert.equal(result.tables.find(r=>r.table==='settings').deleted,1)
  assert.equal((await verifySnapshot(file,db)).ok,true)
  const again=await syncSnapshot(file,db)
  assert.equal(again.tables.reduce((sum,r)=>sum+r.inserted+r.updated+r.deleted,0),0)
 }finally{await db.close()}
})

test('database errors never interpolate bound secrets into their public message',async()=>{
 const db=await fresh()
 try{
  await db.query('CREATE TABLE secret_test(value text PRIMARY KEY)')
  await db.query('INSERT INTO secret_test VALUES($1)',['private-test-value'])
  await assert.rejects(db.query('INSERT INTO secret_test VALUES($1)',['private-test-value']),error=>{
   assert.equal(error.code,'23505');assert.doesNotMatch(error.message,/private-test-value|INSERT/);assert.equal(error.detail,undefined);return true
  })
 }finally{await db.close()}
})
