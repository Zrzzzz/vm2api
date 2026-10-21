import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {createTestDatabase} from './isolated-db.mjs'
import {ClusterNodesRepo} from '../../src/lib/db/repos/cluster-nodes-repo.mjs'
import {UsageLogsRepo} from '../../src/lib/db/repos/usage-logs-repo.mjs'
import {createClusterRoutes} from '../../src/lib/cluster/cluster-routes.mjs'

const migration = fs.readFileSync(new URL('../../src/lib/db/postgres-migrations/002_upstream_207.sql', import.meta.url), 'utf8')
test('upstream PostgreSQL migration is repeatable, checksummed, and atomic on failure', async () => {
 const db = await createTestDatabase()
 try {
  await db.applyMigration('002', migration)
  assert.equal((await db.query("SELECT count(*) AS n FROM postgres_schema_migrations WHERE version='002'")).rows[0].n, 1)
  await assert.rejects(db.applyMigration('002', migration + '\n-- modified'), /checksum mismatch/)
  await assert.rejects(db.applyMigration('bad', 'CREATE TABLE migration_probe(id int); SELECT * FROM nonexistent_upgrade_table;'))
  assert.equal((await db.query("SELECT to_regclass('migration_probe') AS table_name")).rows[0].table_name, null)
  assert.equal((await db.query("SELECT count(*) AS n FROM postgres_schema_migrations WHERE version='bad'")).rows[0].n, 0)
 } finally { await db.close() }
})
test('cluster direct link preserves certificate pin, platform, and cascading deletion', async () => {
 const db = await createTestDatabase()
 try {
  const repo = new ClusterNodesRepo(db)
  await repo.insert({id:'node-upgrade',label:'test',host:'example.test',port:22,username:'test',auth_type:'key',host_key_alg:'ssh-ed25519',host_key_sha256:'test'})
  assert.equal((await repo.get('node-upgrade')).platform, 'linux')
  await repo.setPlatform('node-upgrade','darwin')
  assert.equal(await repo.platform('node-upgrade'),'darwin')
  const previous = await repo.get('node-upgrade')
  const renamed = await repo.updateLabel('node-upgrade','renamed',previous.updated_at)
  assert.equal(renamed.platform,'darwin')
  await repo.setDirectLink('node-upgrade',{address:'example.test',port:8443,token:'test-token'})
  await repo.setDirectLinkCert('node-upgrade','test-pin')
  await repo.setDirectLink('node-upgrade',{address:'new.example.test',port:8444,token:'changed-token'})
  assert.deepEqual(await repo.getDirectLink('node-upgrade'),{address:'new.example.test',port:8444,token:'changed-token',certSha256:'test-pin'})
  assert.deepEqual((await repo.directLinks()).get('node-upgrade'),{address:'new.example.test',port:8444})
  await repo.remove('node-upgrade')
  assert.equal(await repo.getDirectLink('node-upgrade'),null)
 } finally { await db.close() }
})
test('inbound device survives storage and billing snapshot cache can be bypassed by explicit time', async () => {
 const db = await createTestDatabase()
 try {
  const repo = new UsageLogsRepo(db), now = Date.now()
  await repo.insertSummary({id:'req-device',request_id:'req-device',ts:new Date(now).toISOString(),model:'test',status:200,inbound_device_id:'client-device',input_tokens:10,output_tokens:2,total_cost:0.5})
  assert.equal((await db.query('SELECT inbound_device_id FROM usage_logs')).rows[0].inbound_device_id,'client-device')
  const first = await repo.billingStats()
  assert.equal(await repo.billingStats(),first)
  assert.notEqual(await repo.billingStats({now}),first)
 } finally { await db.close() }
})
test('cluster routes await asynchronous PostgreSQL-backed list and get results', async () => {
 const manager = {list:async()=>[{id:'node-test'}],get:async(id)=>({id,install:{state:'ready'}})}
 let body
 const routes=createClusterRoutes({manager,json:(_res,_status,value)=>{body=value;return true},readBody:async()=>({}),ok:data=>({ok:true,data})})
 await routes.handle({method:'GET'}, {}, new URL('http://test/api/panel/cluster/nodes'))
 assert.deepEqual(body.data.items,[{id:'node-test'}])
 await routes.handle({method:'GET'}, {}, new URL('http://test/api/panel/cluster/nodes/node-test/docker/install'))
 assert.deepEqual(body.data,{state:'ready'})
 routes.close?.()
})
