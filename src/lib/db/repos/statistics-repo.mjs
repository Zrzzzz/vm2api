// Repository contract selected by the configured database adapter.
import { repositories } from '../adapters/index.mjs'
export const { STATS_RANGES, STATS_DIMENSIONS, USER_ROLE_DIMENSIONS, normalizeRange, normalizeDimension, resolveWindow, StatisticsRepo } = repositories.statistics_repo
