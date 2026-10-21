// Repository contract selected by the configured database adapter.
import { repositories } from '../adapters/index.mjs'
export const { percentile, summarizeLatency, UsageLogsRepo, RequestLogsRepo } = repositories.usage_logs_repo
