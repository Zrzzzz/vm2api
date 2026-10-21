export type DatabaseRuntimeMetrics = {
  ok: boolean
  engine: 'postgresql'
  version: string
  probe_latency_ms: number | null
  file_size_bytes: number | null
  connections: number
  pool_max: number
  pool_total: number
  pool_idle: number
  pool_waiting: number
  migration_count: number | null
}

export type UsageCacheMetrics = {
  since: string
  entries_total: number
  entries_fresh: number
  entries_stale: number
  inflight: number
  requests: number
  success_hits: number
  error_hits: number
  misses: number
  singleflight_joins: number
  upstream_fetches: number
  upstream_failures: number
  hit_rate: number | null
  reuse_rate: number | null
  success_ttl_ms: number
  error_ttl_ms: number
}

export type DatabaseMetricsPayload = {
  sampled_at: string | null
  database: DatabaseRuntimeMetrics
  usage_cache: UsageCacheMetrics | null
}
