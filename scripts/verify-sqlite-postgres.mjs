import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {pathToFileURL} from 'node:url'
import {rowDigest} from './migrate-sqlite-to-postgres.mjs'
import {targetDigest,targetRows} from './sync-sqlite-to-postgres.mjs'
import {PostgresDatabase,postgresConfig} from '../src/lib/db/adapters/postgres/database.mjs'
const ident=name=>'"'+name.replaceAll('"','""')+'"',mask=(1n<<256n)-1n
export async function verifySnapshot(snapshot,db){
 const source=new DatabaseSync(snapshot,{readOnly:true})
 try{
  const tables=source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name)
  const report=[]
  await db.transaction(async()=>{
   await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
   await db.query('SET LOCAL statement_timeout=0')
   const target=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'postgres_schema_migrations' ORDER BY tablename")).rows.map(r=>r.tablename)
   assert.deepEqual(target,tables)
   for(const table of tables){
    const columns=source.prepare(`PRAGMA table_info(${ident(table)})`).all().map(c=>c.name)
    let expected=0n,count=0
    for(const row of source.prepare(`SELECT * FROM ${ident(table)}`).iterate()){expected=(expected+rowDigest(row,columns))&mask;count++}
    const rows=await targetRows(db,table,columns)
    assert.equal(rows.length,count,'Row count mismatch: '+table)
    assert.equal(rows.reduce((sum,r)=>(sum+targetDigest(r,columns))&mask,0n),expected,'Content mismatch: '+table)
    report.push({table,rows:count,sha256_multiset:expected.toString(16).padStart(64,'0')})
   }
  })
  return {ok:true,tables:report,verified_rows:report.reduce((sum,r)=>sum+r.rows,0)}
 }finally{source.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const db=new PostgresDatabase({...postgresConfig(),query_timeout:0})
 try{console.log(JSON.stringify(await verifySnapshot(process.argv[2],db),null,2))}
 catch(error){console.error(JSON.stringify({ok:false,code:error.code||'verification_failed',error_type:error.name}));process.exitCode=1}
 finally{await db.close()}
}
