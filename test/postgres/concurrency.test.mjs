import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {PostgresDatabase,postgresConfig} from '../../src/lib/db/adapters/postgres/database.mts'
import {ApiKeyStore} from '../../src/lib/admin/api-keys.mjs'
import {AccountQuota} from '../../src/lib/pool/account-quota.mjs'
import {AccountRuntimeRepo} from '../../src/lib/db/repos/account-runtime-repo.mjs'

test('account updates and reservations remain correct across asynchronous database waits',async()=>{
 const schema='concurrency_test_'+crypto.randomBytes(8).toString('hex');
 const root=new PostgresDatabase(postgresConfig());await root.query(`CREATE SCHEMA ${schema}`);await root.close();
 const db=new PostgresDatabase(postgresConfig({...process.env,PGSCHEMA:schema}));
 try{
 await db.initializeBaseline(fs.readFileSync(new URL('../../src/lib/db/postgres-migrations/001_baseline.sql',import.meta.url),'utf8'));
 await db.query("INSERT INTO groups(id,name) VALUES(1,'coding')");
 const quota=new AccountQuota({db,accounts:[{account_id:'a',vm_id:'v',max_concurrency:2}]});await quota.initialize();
 await Promise.all(Array.from({length:8},()=>quota.ingestCliRateLimit('a',{}, {input_tokens:2,output_tokens:3},{countRequest:true})));
 const row=(await db.query("SELECT requests,tokens_in,tokens_out FROM accounts WHERE id='a'")).rows[0];assert.deepEqual(row,{requests:8,tokens_in:16,tokens_out:24});
 const reservations=await Promise.all(Array.from({length:8},()=>quota.tryAcquire('a',{skipGate:true})));
 assert.equal(reservations.filter(r=>r.ok).length,2);assert.equal(quota.inflight.get('a'),2);
 const runtime=new AccountRuntimeRepo(db);
 await Promise.all(Array.from({length:8},(_,i)=>runtime.markCooldown('a',{vmId:'v',model:'model-'+i,until:Date.now()+10000,reason:'test'})));
 assert.equal(Object.keys((await runtime.get('a')).model_states).length,8);
 await db.query("INSERT INTO users(id,email,username,password_hash,concurrency,status,role) VALUES('owner','owner@example.test','owner','test',2,'active','user')");
 const keys=new ApiKeyStore({db,hashSecret:'test-only'});
 const first=await keys.create({name:'one',key:'sk-test-concurrency-one',user_id:'owner',max_concurrency:10,quota:4});
 const second=await keys.create({name:'two',key:'sk-test-concurrency-two',user_id:'owner',max_concurrency:10});
 const records=await Promise.all([keys.repo.getById(first.id),keys.repo.getById(second.id)]);
 const granted=await Promise.all(Array.from({length:8},(_,i)=>keys.acquire(records[i%2])));
 assert.equal(granted.filter(r=>r.ok).length,2);
 await Promise.all(Array.from({length:8},()=>keys.recordUsage(first.id,{input_tokens:2,output_tokens:3},{officialCost:1})));
 const billed=await keys.repo.getById(first.id);
 assert.equal(billed.quota_used,8);assert.equal(billed.usage_5h,8);assert.equal(billed.status,'quota_exhausted');

 }finally{await db.close()}
})
