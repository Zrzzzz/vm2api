import fs from 'node:fs'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {pathToFileURL} from 'node:url'
import {rowDigest} from './migrate-sqlite-to-postgres.mjs'
import {PostgresDatabase,postgresConfig} from '../src/lib/db/adapters/postgres/database.mts'
const ident=name=>'"'+name.replaceAll('"','""')+'"'
const mask=(1n<<256n)-1n
const key=(row,columns)=>JSON.stringify(columns.map(c=>row[c]))
export function targetDigest(row,columns){
 return BigInt('0x'+crypto.createHash('sha256').update(JSON.stringify(columns.map(c=>c==='record_json'?row.record_json_hash:row[c]))).digest('hex'))
}
export async function targetRows(db,table,columns){
 const selected=columns.map(c=>c==='record_json'?`encode(sha256(convert_to(record_json,'UTF8')),'hex') AS record_json_hash`:ident(c)).join(',')
 return (await db.query(`SELECT ${selected} FROM ${ident(table)}`)).rows
}

/** Reconcile an already imported schema against a fresh, consistent source snapshot. */
export async function syncSnapshot(snapshot,db,{onTable=()=>{}}={}){
 const source=new DatabaseSync(snapshot,{readOnly:true})
 try{
  assert.equal(Object.values(source.prepare('PRAGMA quick_check').get())[0],'ok')
  const tables=source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name)
  const target=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'postgres_schema_migrations' ORDER BY tablename")).rows.map(r=>r.tablename)
  assert.deepEqual(target,tables)
  const ordered=[...tables].sort((a,b)=>(a==='vm_pools'?-1:a==='vm_pool_members'?1:0)-(b==='vm_pools'?-1:b==='vm_pool_members'?1:0))
  const report=[]
  await db.transaction(async()=>{
   await db.query('SET LOCAL statement_timeout=0')
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended(current_database() || current_schema(),0))')
   const pendingDeletes=[]
   for(const table of ordered){
    const metadata=source.prepare(`PRAGMA table_info(${ident(table)})`).all(),columns=metadata.map(c=>c.name),primary=metadata.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name)
    if (!primary.length) {
      const result={table,inserted:0,updated:0,deleted:(await db.query(`DELETE FROM ${ident(table)}`)).rowCount,rows:0,sha256_multiset:0n}
      for(const row of source.prepare(`SELECT * FROM ${ident(table)}`).iterate()) {
        await db.query(`INSERT INTO ${ident(table)} (${columns.map(ident).join(',')}) VALUES (${columns.map((_,i)=>'$'+(i+1)).join(',')})`,columns.map(c=>row[c]))
        result.inserted++;result.rows++;result.sha256_multiset=(result.sha256_multiset+rowDigest(row,columns))&mask
      }
      pendingDeletes.push({table,primary,columns,result,rows:[]});report.push(result);continue
    }
    const old=new Map((await targetRows(db,table,columns)).map(row=>[key(row,primary),{row,digest:targetDigest(row,columns)}]))
    const result={table,inserted:0,updated:0,deleted:0,rows:0,sha256_multiset:0n}
    let rows=source.prepare(`SELECT * FROM ${ident(table)}`).iterate()
    if(table==='cluster_nodes'){
      const pending=[...rows],sorted=[],done=new Set()
      while(pending.length){const i=pending.findIndex(r=>!r.jump_node_id||done.has(r.jump_node_id));assert.ok(i>=0,'Invalid cluster references');const [row]=pending.splice(i,1);sorted.push(row);done.add(row.id)}rows=sorted
    }
    for(const row of rows){
     const id=key(row,primary),digest=rowDigest(row,columns),previous=old.get(id)
     old.delete(id);result.rows++;result.sha256_multiset=(result.sha256_multiset+digest)&mask
     if(previous?.digest===digest)continue
     const update=columns.filter(c=>!primary.includes(c)).map(c=>`${ident(c)}=excluded.${ident(c)}`).join(',')
     await db.query(`INSERT INTO ${ident(table)} (${columns.map(ident).join(',')}) VALUES (${columns.map((_,i)=>'$'+(i+1)).join(',')}) ON CONFLICT (${primary.map(ident).join(',')}) ${update?'DO UPDATE SET '+update:'DO NOTHING'}`,columns.map(c=>row[c]))
     if(previous)result.updated++;else result.inserted++
    }
    pendingDeletes.push({table,primary,columns,result,rows:[...old.values()].map(x=>x.row)})
    report.push(result)
   }
   for(const item of pendingDeletes.reverse()){
    const {table,primary,rows,result}=item
    while(rows.length){
     const i=table==='cluster_nodes'?rows.findIndex(r=>!rows.some(other=>other.jump_node_id===r.id)):0
     assert.ok(i>=0,'Cyclic cluster delete references')
     const [row]=rows.splice(i,1)
     const deleted=await db.query(`DELETE FROM ${ident(table)} WHERE ${primary.map((c,i)=>`${ident(c)}=$${i+1}`).join(' AND ')}`,primary.map(c=>row[c]))
     result.deleted+=deleted.rowCount
    }
   }
   for(const {table,columns,result} of pendingDeletes){
    const ddl=source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql
    if(/AUTOINCREMENT/i.test(ddl)){
     const pk=source.prepare(`PRAGMA table_info(${ident(table)})`).all().find(c=>c.pk).name
     await db.query(`SELECT setval(pg_get_serial_sequence($1,$2),COALESCE((SELECT MAX(${ident(pk)}) FROM ${ident(table)}),1),EXISTS(SELECT 1 FROM ${ident(table)}))`,[table,pk])
    }
    const rows=await targetRows(db,table,columns)
    assert.equal(rows.length,result.rows,'Row count mismatch: '+table)
    const sum=rows.reduce((s,r)=>(s+targetDigest(r,columns))&mask,0n)
    assert.equal(sum,result.sha256_multiset,'Content mismatch: '+table)
    result.sha256_multiset=sum.toString(16).padStart(64,'0');onTable({...result})
   }
  })
  return {ok:true,tables:report,verified_rows:report.reduce((s,r)=>s+r.rows,0)}
 }finally{source.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const db=new PostgresDatabase({...postgresConfig(),query_timeout:0})
 try{console.log(JSON.stringify(await syncSnapshot(process.argv[2],db,{onTable:r=>console.error(JSON.stringify({table:r.table,inserted:r.inserted,updated:r.updated,deleted:r.deleted}))}),null,2))}
 catch(error){console.error(JSON.stringify({ok:false,code:error.code||'sync_failed',error_type:error.name}));process.exitCode=1}
 finally{await db.close()}
}
