import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSlotResources, createSlotResourceSampler } from '../../src/lib/vm/slot-resources.mjs'
const inspect = { State: { Running: true }, HostConfig: { NanoCpus: 2e9, Memory: 1024 } }
const stats = {
  cpu_stats: { online_cpus: 8, system_cpu_usage: 2000, cpu_usage: { total_usage: 150 } },
  precpu_stats: { system_cpu_usage: 1000, cpu_usage: { total_usage: 100 } },
  memory_stats: { usage: 600, limit: 1024, stats: { inactive_file: 100 } },
}
test('resource metrics use CPU deltas and exclude reclaimable cache', () => {
  const result = parseSlotResources(inspect, stats)
  assert.equal(result.status, 'ok')
  assert.equal(result.cpu_used_cores, 0.4)
  assert.equal(result.cpu_limit_cores, 2)
  assert.equal(result.memory_used_bytes, 500)
  assert.equal(result.memory_limit_bytes, 1024)
})
test('CPU quota and cpuset both constrain capacity; v1 cache is handled', () => {
  const result = parseSlotResources({ ...inspect, HostConfig: { CpuQuota: 50000, CpuPeriod: 100000, CpusetCpus: '0-2,4' } }, {
    ...stats, memory_stats: { usage: 600, limit: 2048, stats: { total_inactive_file: 200 } },
  })
  assert.equal(result.cpu_limit_cores, 0.5)
  assert.equal(result.memory_used_bytes, 400)
  assert.equal(result.memory_limit_kind, 'host')
})
test('missing CPU baseline is warming, stopped container is not zero usage', () => {
  const result = parseSlotResources(inspect, { ...stats, precpu_stats: {} })
  assert.equal(result.status, 'warming')
  assert.equal(result.cpu_used_cores, null)
  assert.deepEqual(parseSlotResources({ State: { Running: false } }, {}), { status: 'stopped' })
  assert.throws(() => parseSlotResources(inspect, { ...stats, memory_stats: {} }), /invalid_resource_sample/)
})
test('sampler deduplicates requests and does not replay successful data after a collection failure', async () => {
  let calls = 0
  let fail = false
  const sample = createSlotResourceSampler({ ttlMs: 0, hostOf: () => ({ dockerApi: () => () => {} }), read: async (_, { path }) => {
    calls++
    await new Promise((resolve) => setImmediate(resolve))
    if (fail) throw new Error('private backend details')
    return path.endsWith('/json') ? inspect : stats
  } })
  const vm = { id: 'vm-01' }
  const [a, b] = await Promise.all([sample(vm), sample(vm)])
  assert.equal(a.status, 'ok')
  assert.deepEqual(a, b)
  assert.equal(calls, 2)
  fail = true
  assert.deepEqual(await sample(vm), { status: 'error', error: 'resource_collection_failed' })
})
test('native nodes explicitly report unsupported', async () => {
  const sample = createSlotResourceSampler({ hostOf: () => ({ native: true }) })
  assert.deepEqual(await sample({ id: 'vm-01' }), { status: 'unsupported' })
})
