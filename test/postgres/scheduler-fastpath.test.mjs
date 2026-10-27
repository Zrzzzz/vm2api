import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createTestDatabase } from './isolated-db.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { UnitCircuit } from '../../src/lib/pool/unit-circuit.mjs'

async function fixture(t, { concurrency = 2, workerHealth } = {}) {
  const db = await createTestDatabase()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-fastpath-'))
  fs.mkdirSync(path.join(root, 'vms'))
  const quota = new AccountQuota({ db, config: { concurrency: { default_max_per_account: concurrency } }, accounts: [] })
  const runtime = new AccountRuntimeRepo(db)
  quota.attachRuntimeRepo(runtime)
  for (const n of [1, 2]) {
    const id = `vm-0${n}`, accountId = `fast-account-${n}`
    await quota.ensure({ account_id: accountId, vm_id: id, max_concurrency: concurrency, concurrency_override: true })
    const vm = { id, name: id, status: 'running', schedulable: true, proxy_cli_enabled: true,
      proxy: { id: `proxy-${id}`, url: 'socks5h://127.0.0.1:10001' },
      policy: { maxConcurrency: concurrency, concurrencyOverride: true },
      claude: { account_uuid: accountId, account_tier: 'max', access_token: `synthetic-${id}`,
        refresh_token: `synthetic-refresh-${id}`, expires_at: Math.floor(Date.now()/1000)+3600 },
    }
    fs.writeFileSync(path.join(root, 'vms', `${id}.json`), JSON.stringify(vm))
  }
  const probes = []
  const pool = new PoolScheduler({ projectRoot: root, runtimeRepo: runtime, accountQuota: quota,
    workerHealth: workerHealth || (async exec => { probes.push(exec.vmId); return { ok: true, healthy: true } }),
    config: { worker_health_ttl_ms: 5000, default_session_slots: 20, fallback_wait_timeout_ms: 1000 },
  })
  pool.unitCircuit = new UnitCircuit({ repo: runtime })
  await pool.ready
  t.after(async () => { await pool.stopMaintenance(); await db.close() })
  return { db, root, quota, runtime, pool, probes }
}

const options = { model: 'claude-sonnet-5-5', allowWait: false }

test('runtime reads use one unlocked joined snapshot even during an account mutation', async t => {
  const { db, runtime } = await fixture(t)
  let unlock, locked
  const held = new Promise(resolve => { locked = resolve })
  const release = new Promise(resolve => { unlock = resolve })
  const mutation = db.withEntityLock('account', 'fast-account-1', async () => { locked(); await release })
  await held
  const sql = []
  const listener = query => sql.push(query.sql)
  db.knex.on('query', listener)
  try {
    const snapshots = await Promise.race([
      runtime.schedulingSnapshot(['fast-account-1', 'fast-account-2']),
      delay(500).then(() => { throw Error('read blocked on exclusive account lock') }),
    ])
    assert.equal(snapshots.size, 2)
    assert.equal(snapshots.get('fast-account-1').account.max_concurrency, 2)
    assert.equal(snapshots.get('fast-account-1').state.vm_id, 'vm-01')
    assert.equal(sql.length, 1)
    assert(!sql[0].includes('advisory'))
    assert(!sql[0].includes('credentials'))
  } finally { db.knex.off('query', listener); unlock(); await mutation }
})

test('healthy selection uses snapshots and held sessions only check their own VM', async t => {
  const { db, pool, probes } = await fixture(t)
  const first = await pool.selectAndReserve({ ...options, seatKey: 'seat:sess:test-held' })
  assert.equal(first.ok, true)
  const before = probes.length
  // Keep the seat occupied while the second request takes its second concurrency slot.
  pool.healthCache.clear()
  const sql=[]; const listener=q=>sql.push(q.sql); db.knex.on('query',listener)
  const second = await pool.selectAndReserve({ ...options, seatKey: 'seat:sess:test-held' })
  db.knex.off('query',listener)
  assert.equal(second.vmId, first.vmId)
  assert.equal(second.selectionReason, 'seat-held')
  assert.deepEqual(probes.slice(before), [first.vmId])
  assert.equal(sql.filter(q=>q.startsWith('BEGIN')).length, 1)
  assert.equal(sql.filter(q=>q.includes('pg_advisory')).length, 1)
  assert.equal(sql.filter(q=>q.includes('FULL JOIN account_runtime')).length, 2)
  assert.equal(sql.filter(q=>/^(INSERT|UPDATE|DELETE)/.test(q.trim())).length, 0)
  first.release(); second.release()
  assert.equal(pool.inflight.size, 0)
})

test('health probes are singleflight, cancelled callers do not cancel others, and writes preserve cooldowns', async t => {
  let probes=0
  const { runtime, pool }=await fixture(t,{workerHealth:async()=>{probes++;await delay(40);return {ok:true,healthy:true}}})
  const exec={vmId:'vm-01',accountId:'fast-account-1'}
  const controller=new AbortController()
  const cancelled=pool.getWorkerHealth(exec,{signal:controller.signal})
  const surviving=pool.getWorkerHealth(exec)
  controller.abort()
  await assert.rejects(cancelled,{code:'selection_cancelled'})
  assert.equal((await surviving).ok,true)
  assert.equal(probes,1)
  assert.equal((await runtime.get(exec.accountId)).worker_heartbeat_at,null)
  await runtime.markCooldown(exec.accountId,{vmId:exec.vmId,until:Date.now()+60000,reason:'model_limit',model:'claude-sonnet-5-5'})
  await pool.flushHealthWrites()
  const state=await runtime.get(exec.accountId)
  assert(state.worker_heartbeat_at>0)
  assert.equal(state.model_states['claude-sonnet-5-5'].reason,'model_limit')
  await runtime.writeHeartbeat({account_id:exec.accountId,vm_id:exec.vmId,status:'ready',worker_heartbeat_at:state.worker_heartbeat_at-100,worker_status:{ok:false},credential_generation:0,refresh_status:'fresh'})
  assert.equal((await runtime.get(exec.accountId)).worker_status.ok,true)
  pool.healthCache.clear()
  pool.workerHealth=async()=>{throw Error('probe unavailable')}
  assert.equal((await pool.getWorkerHealth(exec)).ok,false)
  pool.workerHealth=async()=>({ok:true,healthy:true})
  assert.equal((await pool.getWorkerHealth({...exec,accountId:'fast-account-2'})).ok,true,
    'a new account on the same VM must not reuse the old account health result')
})

test('final admission rejects changes made after eligibility, including queued stale candidates', async t => {
  const { db, pool, runtime }=await fixture(t)
  const candidate=(await pool.eligibleCandidates(options))[0]
  await db.query("UPDATE accounts SET schedulable=0 WHERE id=$1",[candidate.accountId])
  assert.equal(await pool.reserve(candidate),null)
  await db.query("UPDATE accounts SET schedulable=1 WHERE id=$1",[candidate.accountId])
  await runtime.updateWindow(candidate.accountId,{vmId:candidate.vmId,overloadUntil:Date.now()+60000})
  assert.equal(await pool.reserve(candidate),null)
  await runtime.updateWindow(candidate.accountId,{vmId:candidate.vmId,overloadUntil:Date.now()-1})
  const reserved=await pool.reserve(candidate)
  assert(reserved,'expired cooldown must not depend on background cleanup')
  reserved.release()
  assert.equal(pool.inflight.size,0)
})

test('concurrent admission and cancellation never leak or overbook capacity', async t => {
  const { pool, quota }=await fixture(t,{concurrency:2})
  const candidate=(await pool.eligibleCandidates(options))[0]
  const granted=await Promise.all(Array.from({length:20},()=>pool.reserve(candidate)))
  assert.equal(granted.filter(Boolean).length,2)
  for(const lease of granted)lease?.release()
  assert.equal(pool.inflight.size,0)
  assert.equal(quota.inflight.get(candidate.accountId),0)
  const controller=new AbortController();controller.abort()
  await assert.rejects(pool.reserve({...candidate,signal:controller.signal}),{code:'selection_cancelled'})
  assert.equal(quota.inflight.get(candidate.accountId),0)
})

test('a delayed PostgreSQL round trip does not multiply by every eligibility check', async t => {
  const { db,pool }=await fixture(t)
  const first=await pool.selectAndReserve({...options,seatKey:'seat:sess:latency'})
  assert(first.ok)
  const proto=db.knex.client.constructor.prototype, original=proto._query
  proto._query=async function(...args){await delay(42);return await original.apply(this,args)}
  t.after(()=>{proto._query=original})
  const samples=[]
  for(let i=0;i<5;i++){
    const started=performance.now()
    const grant=await pool.selectAndReserve({...options,seatKey:'seat:sess:latency'})
    samples.push(performance.now()-started)
    assert(grant.ok);grant.release()
  }
  first.release()
  t.diagnostic('42ms per SQL: scheduling milliseconds '+samples.map(x=>x.toFixed(1)).join(', '))
  assert(Math.max(...samples)<450,`unexpected amplified latency: ${samples}`)
})

test('queue residence is measured separately and a cancelled waiter leaves no provisional seat', async t => {
  const { pool }=await fixture(t,{concurrency:1})
  const held=await pool.selectAndReserve({...options,seatKey:'seat:sess:queued'})
  assert(held.ok)
  const waiting=pool.selectAndReserve({...options,allowWait:true,seatKey:'seat:sess:queued'})
  await delay(80)
  held.release()
  const granted=await waiting
  assert(granted.ok)
  assert.equal(granted.selectionReason,'queued')
  assert(granted.queueWaitMs>=40)
  assert(granted.schedulingMs>=0)
  assert.equal(granted.waitMs,granted.queueWaitMs+granted.schedulingMs)
  const controller=new AbortController()
  const cancelled=pool.selectAndReserve({...options,allowWait:true,seatKey:'seat:sess:queued',signal:controller.signal})
  await delay(30);controller.abort()
  await assert.rejects(cancelled,{code:'selection_cancelled'})
  granted.release()
  await delay(30)
  assert.equal(pool.queuedTotal(),0)
  assert.equal(pool.inflight.size,0)
})

test('health expiry and new quota/RPM limits are rechecked before granting a stale candidate', async t => {
  const { pool,db,quota }=await fixture(t)
  const candidate=(await pool.eligibleCandidates(options))[0]
  pool.healthCache.clear()
  pool.workerHealth=async()=>({ok:false,healthy:false,error:'worker unavailable'})
  assert.equal(await pool.reserve(candidate),null)
  pool.healthCache.clear();pool.workerHealth=async()=>({ok:true,healthy:true})
  const acc=await quota.repo.get(candidate.accountId)
  acc.unified.headers={'5h':{utilization:1,status:'rejected',reset:new Date(Date.now()+3600000).toISOString()}}
  await quota.repo.save(acc)
  assert.equal(await pool.reserve(candidate),null)
  acc.unified.headers={};acc.max_rpm=1;acc.rpm_override=1
  await quota.repo.save(acc)
  const first=await pool.reserve(candidate);assert(first);first.release()
  assert.equal(await pool.reserve(candidate),null,'released capacity must not reset the RPM window')
  await db.query('UPDATE accounts SET concurrency=0 WHERE id=$1',[candidate.accountId])
  assert.equal(await pool.reserve(candidate),null)
})

test('failed transaction commit and circuit persistence return local reservation capacity', async t => {
  const { quota,pool,db }=await fixture(t)
  const original=db.withEntityLock.bind(db)
  db.withEntityLock=async (...args)=>{const result=await original(...args);throw Error('synthetic commit failure')}
  await assert.rejects(quota.tryAcquire('fast-account-1'),/synthetic commit failure/)
  assert.equal(quota.inflight.get('fast-account-1'),0)
  assert.equal(quota._rpmCount('fast-account-1').n,0)
  db.withEntityLock=original
  const candidate=(await pool.eligibleCandidates(options))[0]
  pool.unitCircuit.admit=async()=>{throw Error('synthetic circuit persistence failure')}
  await assert.rejects(pool.reserve(candidate),/synthetic circuit persistence failure/)
  assert.equal(quota.inflight.get(candidate.accountId),0)
  assert.equal(pool.inflight.size,0)
})

test('new timing columns preserve measured values and leave historical data unknown', async t => {
  const {db,pool}=await fixture(t)
  const {RequestAttemptsRepo}=await import('../../src/lib/db/repos/request-attempts-repo.mjs')
  const attempts=new RequestAttemptsRepo(db)
  const grant=await pool.selectAndReserve({...options,seatKey:'seat:sess:timing-persistence'})
  assert(grant.ok);grant.release()
  const saved=await attempts.begin({requestId:'timing-new',attemptNo:1,vmId:grant.vmId,
    accountId:grant.accountId,waitMs:grant.waitMs,queueWaitMs:grant.queueWaitMs,schedulingMs:grant.schedulingMs})
  assert.equal(saved.queue_wait_ms,0)
  assert.equal(saved.scheduling_ms,saved.wait_ms)
  const historical=await attempts.begin({requestId:'timing-old',attemptNo:1,waitMs:5500})
  assert.equal(historical.queue_wait_ms,null)
  assert.equal(historical.scheduling_ms,null)
})

test('held-seat shortcut still honors changed VM disable', async t => {
  const {pool,root}=await fixture(t)
  const held=await pool.selectAndReserve({...options,seatKey:'seat:sess:disabled-home'})
  assert(held.ok)
  const file=path.join(root,'vms',held.vmId+'.json')
  const vm=JSON.parse(fs.readFileSync(file,'utf8'))
  vm.schedule_off=true;vm.schedulable=false
  fs.writeFileSync(file,JSON.stringify(vm))
  const next=await pool.selectAndReserve({...options,seatKey:'seat:sess:disabled-home'})
  assert(next.ok)
  assert.notEqual(next.vmId,held.vmId)
  held.release();next.release()
  assert.equal(pool.inflight.size,0)
})

test('cancellation after quota admission and before circuit completion releases the slot', async t => {
  const {pool,quota}=await fixture(t)
  const candidate=(await pool.eligibleCandidates(options))[0]
  const controller=new AbortController()
  pool.unitCircuit.admit=async()=>{controller.abort();return {ok:true,state:'closed'}}
  await assert.rejects(pool.reserve({...candidate,signal:controller.signal}),{code:'selection_cancelled'})
  assert.equal(pool.inflight.size,0)
  assert.equal(quota.inflight.get(candidate.accountId),0)
})

test('a pending health write never overwrites a credential disable or a newer health observation', async t => {
  const {pool,runtime}=await fixture(t)
  const id='fast-account-1'
  await runtime.upsert({account_id:id,vm_id:'vm-01',status:'disabled',cooldown_reason:'operator_disabled',cooldown_until:Date.now()+60000})
  await pool.getWorkerHealth({vmId:'vm-01',accountId:id})
  await pool.flushHealthWrites()
  const disabled=await runtime.get(id)
  assert.equal(disabled.status,'disabled')
  assert.equal(disabled.cooldown_reason,'operator_disabled')
  await runtime.upsert({...disabled,worker_heartbeat_at:disabled.worker_heartbeat_at-1000,worker_status:{ok:false},credential_generation:0})
  const live=await runtime.get(id)
  assert.equal(live.worker_status.ok,true)
  assert.equal(live.worker_heartbeat_at,disabled.worker_heartbeat_at)
})


test('final admission honors key scope and database failures never reuse a stale snapshot', async t => {
  const { pool, runtime }=await fixture(t)
  const candidate=(await pool.eligibleCandidates(options))[0]
  const denied=await pool.reserve({...candidate,keyScope:{group_type:'anthropic',allowed_vms:[]}})
  assert.equal(denied,null)
  runtime.schedulingSnapshot=async()=>{throw Error('synthetic database unavailable')}
  await assert.rejects(pool.selectAndReserve(options),/synthetic database unavailable/)
  assert.equal(pool.inflight.size,0)
})
