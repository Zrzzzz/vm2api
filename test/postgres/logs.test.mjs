import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {PostgresDatabase,postgresConfig} from '../../src/lib/db/adapters/postgres/database.mjs'
import {UsageLogsRepo} from '../../src/lib/db/repos/usage-logs-repo.mjs'
import {UsageLogsView} from '../../src/lib/db/repos/usage-logs-view.mjs'
import {StatisticsRepo} from '../../src/lib/db/repos/statistics-repo.mjs'

test('PostgreSQL log queries preserve tenant filters, bodies, statistics and permanent retention',async()=>{
 const admin=new PostgresDatabase(postgresConfig()); const schema='logs_test_'+crypto.randomBytes(8).toString('hex');
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.close();
 const db=new PostgresDatabase(postgresConfig({...process.env,PGSCHEMA:schema}));
 try{
 await db.initializeBaseline(fs.readFileSync(new URL('../../src/lib/db/postgres-migrations/001_baseline.sql',import.meta.url),'utf8'));
 const repo=new UsageLogsRepo(db),view=new UsageLogsView(db,{mutedErrorClasses:[]}),stats=new StatisticsRepo(db);
 const now=new Date().toISOString();
 for(const user of ['one','two']) {
 await db.query('INSERT INTO users(id,email,username,password_hash) VALUES($1,$2,$1,$3)',[user,user+'@example.test','test']);
 await repo.insertSummary({id:user,request_id:'req-'+user,user_id:user,ts:now,status:200,model:'test-model',outbound_session_id:'session-'+user,input_tokens:10,output_tokens:5,total_cost:0.5});
 await repo.insertDebug('req-'+user,now,{input:'输入 '+user,output:'输出 '+user});
 }
 assert.equal(await repo.hasSuccessfulRequest({owner_user_id:'one'}),true);
 assert.equal(await repo.belongsToOwner('req-two','one'),false);
 assert.equal((await repo.query({owner_user_id:'one'})).items.length,1);
 assert.equal((await repo.listDebug({owner_user_id:'one'})).length,1);
 assert.equal((await view.listBatch({owner_user_id:'one',limit:1,include_muted:true})).logs[0].userId,'one');
 assert.equal((await view.summary({owner_user_id:'one',include_muted:true})).totalRequests,1);
 assert.equal((await view.exportRows({owner_user_id:'one',include_muted:true})).total,1);
 assert.deepEqual(await view.sessionSuggestions({owner_user_id:'one',q:'session'}),['session-one']);
 assert.deepEqual(await view.sessionSuggestions({owner_user_id:'one'}),['session-one']);
 assert.equal((await view.activeSessions({owner_user_id:'one'})).total,1);
 assert.equal((await view.overview({owner_user_id:'one'})).todayRequests,1);
 await view.filterOptions({owner_user_id:'one'});
 await stats.statistics({owner_user_id:'one'});
 await stats.leaderboard({owner_user_id:'one'});
 await repo.aggregate({since:'2000-01-01',owner_user_id:'one'});
 const totals=await repo.totals();assert.equal(totals.input_tokens,20);assert.equal(totals.requests,2);
 await repo.costByAccount({since:'2000-01-01'});
 await repo.costByModel({since:'2000-01-01'});
 await repo.vmUsageStats({vmId:'v'});
 await repo.keyUsageStats({apiKeyId:'k'});
 await repo.protocolEntryStats();
 await repo.billingStats();
 await repo.ownerBilling({ownerUserId:'one',since:'2000-01-01'});
 await repo.windowStats({owner_user_id:'one',since:'2000-01-01'});
 await repo.errorCollection({owner_user_id:'one',since:'2000-01-01'});
 await repo.repriceRange();
 await repo.cleanup({retainDays:0,maxBytes:1});
 assert.equal(await repo.count(),2);assert.equal(await repo.countDebug(),2);
 }finally{await db.close()}
})
