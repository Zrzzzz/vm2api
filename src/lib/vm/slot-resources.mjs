import { dockerJson } from '../cluster/docker-remote.mjs'
import { slotHost } from './slot-host.mjs'
import { containerName } from './vm-runtime.mjs'

const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0

export function parseSlotResources(inspect, stats) {
  if (!inspect?.State?.Running) return { status: 'stopped' }
  const cpu = stats.cpu_stats
  const prev = stats.precpu_stats
  const hostCores = cpu?.online_cpus || cpu?.cpu_usage?.percpu_usage?.length
  const delta = cpu?.cpu_usage?.total_usage - prev?.cpu_usage?.total_usage
  const systemDelta = cpu?.system_cpu_usage - prev?.system_cpu_usage
  const cpuUsed = finite(delta) && systemDelta > 0 && hostCores > 0 ? delta / systemDelta * hostCores : null
  const config = inspect.HostConfig || {}
  const limits = [hostCores]
  if (config.NanoCpus > 0) limits.push(config.NanoCpus / 1e9)
  if (config.CpuQuota > 0 && config.CpuPeriod > 0) limits.push(config.CpuQuota / config.CpuPeriod)
  if (config.CpusetCpus) {
    const ids = new Set()
    for (const part of config.CpusetCpus.split(',')) {
      if (!/^\d+(-\d+)?$/.test(part)) throw new Error('invalid_cpu_set')
      const [start, end = start] = part.split('-').map(Number)
      if (end < start || end - start > 65536) throw new Error('invalid_cpu_set')
      for (let id = start; id <= end; id++) ids.add(id)
    }
    if (ids.size) limits.push(ids.size)
  }
  const cpuLimit = Math.min(...limits.filter((n) => finite(n) && n > 0))
  const mem = stats.memory_stats || {}
  const cache = mem.stats?.total_inactive_file ?? mem.stats?.inactive_file ?? 0
  const memUsed = finite(mem.usage) && finite(cache) ? mem.usage - (cache < mem.usage ? cache : 0) : null
  const memLimit = config.Memory > 0 ? Math.min(config.Memory, mem.limit) : mem.limit
  if (!finite(memUsed) || !(memLimit > 0) || !finite(memLimit) || !finite(cpuLimit)) throw new Error('invalid_resource_sample')
  return {
    status: cpuUsed == null ? 'warming' : 'ok',
    sampled_at: new Date().toISOString(),
    cpu_used_cores: cpuUsed,
    cpu_limit_cores: cpuLimit,
    memory_used_bytes: memUsed,
    memory_limit_bytes: memLimit,
    memory_limit_kind: config.Memory > 0 ? 'container' : 'host',
  }
}

export function createSlotResourceSampler({ read = dockerJson, hostOf = slotHost, ttlMs = 5000 } = {}) {
  const samples = new Map()
  return async function sample(vm) {
    const now = Date.now()
    const name = vm.runtime?.container || containerName(vm.id)
    const key = `${vm.node_id || vm.placement?.node_id || 'local'}:${name}`
    const cached = samples.get(key)
    if (cached && cached.expires > now) return cached.promise
    for (const [id, entry] of samples) if (entry.expires <= now) samples.delete(id)
    const promise = (await (async () => {
      try {
        const host = hostOf(vm)
        if ('native' in host && host.native) return { status: 'unsupported' }
        const connect = host.dockerApi()
        const base = `/containers/${encodeURIComponent(name)}`
        const inspect = await read(connect, { path: `${base}/json`, timeoutMs: 3000 })
        if (!inspect?.State?.Running) return { status: 'stopped' }
        const stats = await read(connect, { path: `${base}/stats?stream=false`, timeoutMs: 4000 })
        return parseSlotResources(inspect, stats)
      } catch {
        return { status: 'error', error: 'resource_collection_failed' }
      }
    })())
    const entry = { promise, expires: Infinity }
    samples.set(key, entry)
    promise.finally(() => { entry.expires = Date.now() + ttlMs })
    return promise
  }
}

const sample = createSlotResourceSampler()

export async function attachSlotResources(items, getRecord) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      const vm = getRecord(item.id)
      item.resource_usage = vm ? await sample(vm) : { status: 'error', error: 'vm_not_found' }
    }
  }))
}
