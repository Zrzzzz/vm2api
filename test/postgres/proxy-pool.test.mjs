import test from 'node:test'
import assert from 'node:assert/strict'
import {createTestDatabase} from './isolated-db.mjs'
import {ProxyPool} from '../../src/lib/vm/proxy-pool.mjs'

test('asynchronous egress health is awaited before disabling or repairing a healthy proxy',async()=>{
 const db=await createTestDatabase();let repairs=0
 try{
  const pool=new ProxyPool({db,egressCheck:async()=>({ok:true}),repairEgress:async()=>{repairs++}})
  pool._probeSocks=async()=>({ok:true,scope:'socks',latency_ms:1})
  const result=await pool.probeOne({id:'px-test',host:'127.0.0.1',port:1080})
  assert.equal(result.ok,true);assert.equal(repairs,0)
 }finally{await db.close()}
})
