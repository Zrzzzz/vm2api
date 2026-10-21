import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {startGateway,api} from '../harness.mjs'
import {PostgresDatabase,postgresConfig} from '../../src/lib/db/adapters/postgres/database.mjs'
import {createDatabase} from './fixtures/sqlite-source.mjs'
import {migrateSnapshot} from '../../scripts/migrate-sqlite-to-postgres.mjs'

for (const mode of ['unavailable','success']) {
test(`PostgreSQL gateway authenticates and persists ${mode} inference`,async()=>{
 const schema='gateway_test_'+crypto.randomBytes(8).toString('hex');
 const root=new PostgresDatabase(postgresConfig());await root.query(`CREATE SCHEMA ${schema}`);await root.close();
 const db=new PostgresDatabase(postgresConfig({...process.env,PGSCHEMA:schema}));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vm2api-gateway-pg-'));const source=path.join(dir,'source.db');createDatabase({dbPath:source}).close();
 let gw;
 try{
 await migrateSnapshot(source,db,{baseline:fs.readFileSync(new URL('../../src/lib/db/postgres-migrations/001_baseline.sql',import.meta.url),'utf8')});
 gw=await startGateway({readyMs:15000,env:{PGSCHEMA:schema,KIN_BACKUP_DISABLED:'1',KIN_REQUEST_LOG_MODE:'debug',KIN_KERNEL_BIN:mode==='success'?'/bin/true':''}});
 const metrics=await api(gw,'GET','/api/panel/database/metrics');assert.equal(metrics.status,200,metrics.text);assert.equal(metrics.json.data.database.engine,'postgresql');
 const rejected=await fetch(gw.baseUrl+'/api/panel/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'wrong-password'})});assert.equal(rejected.status,401);
 const unauthorized=await fetch(gw.baseUrl+'/api/panel/database/metrics');assert.equal(unauthorized.status,401);
 const login=await fetch(gw.baseUrl+'/api/panel/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'testpass'})});assert.equal(login.status,200,await login.text());
 const inference=await api(gw,'POST','/v1/messages',{body:{model:'claude-sonnet-4-6',max_tokens:20,messages:[{role:'user',content:'hello'}]}});if(mode==='unavailable'){assert.equal(inference.status,503,inference.text);assert.match(inference.text,/rust kernel is not available/)}
 else {assert.equal(inference.status,200,inference.text);assert.match(inference.text,/pong/);
 const stream=await api(gw,'POST','/v1/messages',{body:{model:'claude-sonnet-4-6',stream:true,max_tokens:20,messages:[{role:'user',content:'stream hello'}]}});assert.equal(stream.status,200,stream.text);assert.match(stream.text,/message_stop/)}
 let rows; for(let i=0;i<40;i++){({rows}=await db.query('SELECT count(*) AS n FROM usage_logs'));if(rows[0].n>0)break;await new Promise(r=>setTimeout(r,50))}assert.ok(rows[0].n>0,gw.stderr());
 assert.ok((await db.query('SELECT count(*) AS n FROM request_log_debug')).rows[0].n>0);
 for(const endpoint of ['users','vm-pools','api-keys','request-logs','request-logs/stats','usage-logs','usage-logs/summary','usage-logs/filter-options','usage-logs/session-suggestions','usage-logs/active-sessions','usage-logs/overview','statistics','statistics/leaderboard','backups','backups/config','routing','proxies','proxies/config']) {
   const result=await api(gw,'GET','/api/panel/'+endpoint);
   assert.equal(result.status,200,endpoint+': '+result.text);
 }

 }finally{if(gw)await gw.stop();await db.close()}
})

}
