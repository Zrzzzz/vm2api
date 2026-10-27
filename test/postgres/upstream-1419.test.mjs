import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createTestDatabase } from './isolated-db.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { UsageLogsView } from '../../src/lib/db/repos/usage-logs-view.mjs'
import { JevUsageRepo } from '../../src/lib/db/repos/jev-usage-repo.mjs'
import { ThinkingOwnerStore, filterThinkingForAccount } from '../../src/lib/pool/thinking-owner.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'

test('1.4.019 request timings, image usage and decision state survive PostgreSQL persistence', async () => {
  const db = await createTestDatabase()
  try {
    const repo = new UsageLogsRepo(db), view = new UsageLogsView(db, { mutedErrorClasses: [] })
    const ts = new Date().toISOString()
    await repo.insertSummary({ id: 'new-fields', request_id: 'new-fields', ts, status: 200, model: 'test',
      vm_id: 'test-vm', first_token_ms: 1200, first_byte_ms: 300, generation_ms: 2500,
      image_model: 'gpt-image-1', image_usage: '{"input_tokens":12}', image_input_tokens: 12,
      image_output_tokens: 20, image_cost: 0.4, total_cost: 0.5, jev_state: 'synthetic submitted instruction',
      cache_creation_tokens: null,
    })
    const stored = (await db.query("SELECT * FROM usage_logs WHERE id='new-fields'")).rows[0]
    assert.equal(stored.first_byte_ms, 300)
    assert.equal(stored.image_output_tokens, 20)
    assert.equal(stored.image_cost, 0.4)
    assert.equal(stored.cache_creation_tokens, null)
    const row = (await view.listBatch({ include_muted: true })).logs[0]
    assert.equal(row.firstByteMs, 300)
    assert.equal(row.generationMs, 2500)
    assert.equal(row.jevState, 'synthetic submitted instruction')
    assert.equal((await repo.costBetween({ since: ts, until: ts, vmId: 'test-vm' })).total_cost, 0.5)
  } finally { await db.close() }
})

test('Jev usage ledger atomically records concurrent provider attempts and paginates them', async () => {
  const db = await createTestDatabase()
  try {
    const repo = new JevUsageRepo(db), ts = new Date().toISOString()
    await Promise.all(Array.from({ length: 8 }, () => repo.record({
      id: randomUUID(), created_at: ts, request_id: 'synthetic', provider: 'jev', model: 'jev-latest',
      key_fingerprint: '0123456789ab', http_status: 200, outcome: 'success', duration_ms: 40,
      input_tokens: 10, output_tokens: 2, estimated_cost_nano_usd: 420,
      input_nano_usd_per_token: 42, output_nano_usd_per_token: 0, pricing_basis: 'test',
    })))
    const overview = await repo.overview()
    assert.equal(overview.total.requests, 8)
    assert.equal(overview.today.input_tokens, 80)
    const first = await repo.list({ limit: 3 })
    assert.equal(first.rows.length, 3)
    const second = await repo.list({ limit: 3, cursor_created_at: first.next_cursor.created_at, cursor_id: first.next_cursor.id })
    assert.equal(second.rows.length, 3)
    assert.equal(new Set([...first.rows, ...second.rows].map(x => x.id)).size, 6)
  } finally { await db.close() }
})

test('thinking ownership uses PostgreSQL and preserves only the signing account blocks', async () => {
  const db = await createTestDatabase()
  try {
    const store = new ThinkingOwnerStore({ db })
    const { thinkingSignatureKey } = await import('../../src/lib/pool/thinking-owner.mjs')
    const block = { type: 'thinking', thinking: 'synthetic reasoning', signature: 'synthetic-signature-with-more-than-24-characters' }
    const body = { messages: [{ role: 'assistant', content: [block] }] }
    await store.record([thinkingSignatureKey(block)], 'account-a')
    assert.equal((await filterThinkingForAccount(body, 'account-a', store)).kept, 1)
    assert.equal((await filterThinkingForAccount(body, 'account-b', store)).converted, 1)
  } finally { await db.close() }
})

test('async quota admission cannot overbook concurrency or a provisional seat', async () => {
  const pool = new PoolScheduler({ accountQuota: {
    tryAcquire: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return { ok: true } }, release() {},
  } })
  await pool.ready
  const candidate = { accountId: 'delayed-account', vmId: 'delayed-vm', maxConcurrency: 2, seatCap: 1, vm: {} }
  const reservations = await Promise.all(Array.from({ length: 6 }, () => pool.reserve(candidate)))
  assert.equal(reservations.filter(Boolean).length, 2)
  assert.equal(pool.inflight.get(candidate.accountId), 2)
  for (const reservation of reservations) reservation?.release()
  const seats = await Promise.all(Array.from({ length: 6 }, (_, i) => pool.claimSeat('seat-'+i, candidate, 'test')))
  assert.equal(seats.filter(Boolean).length, 1)
  for (const seat of seats) seat?.reservation.release()
  assert.equal(pool.planner.openCount(candidate.vmId), 0)
  assert.equal(pool.inflight.size, 0)
})
