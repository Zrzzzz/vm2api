import { adapter } from './adapters/index.mjs'
export async function snapshotDatabaseMetrics(options) { return await adapter.metrics(options) }
