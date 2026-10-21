// Repository contract selected by the configured database adapter.
import { repositories } from '../adapters/index.mjs'
export const { ERROR_PRED, SUCCESS_PRED, SLA_SUCCESS_PRED, SLA_ERROR_PRED, PROMPT_TOKENS_SQL, TOTAL_TOKENS_SQL, totalTokens, ownerPred } = repositories.usage_log_preds
