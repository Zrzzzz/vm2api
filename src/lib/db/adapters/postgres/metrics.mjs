export async function snapshotDatabaseMetrics({ db, usageCache, now = () => Date.now(), clock = () => performance.now() }) {
  const started = clock()
  await db.query('SELECT 1')
  const latency = Math.max(0, clock() - started)
  const {rows} = await db.query(`SELECT pg_database_size(current_database()) AS bytes,
    current_setting('server_version') AS version,
    (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()) AS connections,
    (SELECT count(*) FROM postgres_schema_migrations) AS migrations`)
  return {
    sampled_at: new Date(now()).toISOString(),
    database: {ok:true, engine:'postgresql', version:rows[0].version, probe_latency_ms:latency,
      file_size_bytes:Number(rows[0].bytes), connections:Number(rows[0].connections),
      ...db.poolMetrics(), migration_count:Number(rows[0].migrations)},
    usage_cache: usageCache?.stats?.() ?? null,
  }
}
