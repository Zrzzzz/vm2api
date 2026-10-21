// Repository contract selected by the configured database adapter.
import { repositories } from '../adapters/index.mjs'
export const { lookupNames, toUsageLogRow, UsageLogsView } = repositories.usage_logs_view
