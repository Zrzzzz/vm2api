// Repository contract selected by the configured database adapter.
import { repositories } from '../adapters/index.mjs'
export const { generateRedeemCode, RedeemCodesRepo } = repositories.redeem_codes_repo
