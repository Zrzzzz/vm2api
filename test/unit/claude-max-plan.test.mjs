import test from 'node:test'
import assert from 'node:assert/strict'
import { maxMultiplierFromOauthProfile, tierFromOauthProfile } from '../../src/lib/oauth/official-cc-stats.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { inferClaudeTier } from '../../src/lib/pool/claude-tier.mjs'
import { collectOfficialCcAccount } from '../../src/lib/oauth/official-cc-bootstrap.mjs'

for (const multiplier of [5, 20]) {
  test(`official profile identifies Max ${multiplier}x and bootstrap retains it`, async () => {
    const body = { account: { has_claude_max: true }, organization: { rate_limit_tier: `default_claude_max_${multiplier}x` } }
    assert.equal(maxMultiplierFromOauthProfile(body), multiplier)
    assert.equal(tierFromOauthProfile(body), 'max')
    const result = await collectOfficialCcAccount({}, { slotOauth: async () => ({ ok: true, body }) })
    assert.equal(result.account_max_multiplier, multiplier)
  })
}

test('missing, novel and misleading rate tiers never guess the Max multiplier', () => {
  for (const tier of ['', 'default_claude_max', 'default_claude_max_50x', 'default_claude_max_20x_trial']) {
    assert.equal(maxMultiplierFromOauthProfile({ account: { has_claude_max: true }, organization: { rate_limit_tier: tier } }), null)
  }
})

test('profile changes update multiplier, usage cannot erase it, downgrade clears it', async () => {
  let account = { unified: {} }
  const quota = Object.create(AccountQuota.prototype)
  quota.db = { withEntityLock: async (_kind, _id, fn) => await fn() }
  quota.repo = { get: async () => structuredClone(account), save: async (value) => { account = structuredClone(value); return value } }
  for (const multiplier of [5, 20]) {
    await quota.setAccountTier('account', 'max', { source: 'profile', maxMultiplier: multiplier })
    assert.equal(account.unified.account_max_multiplier, multiplier)
    await quota.setAccountTier('account', 'pro', { source: 'usage' })
    assert.equal(account.unified.account_tier, 'max')
    assert.equal(account.unified.account_max_multiplier, multiplier)
  }
  assert.equal(inferClaudeTier({ has_token: true, usage_has_fable: false }, account.unified).key, 'max')
  quota.ensure = async () => account
  quota._writeSessionWindow = async () => {}
  quota._observeUtil = () => {}
  quota.headerUnderSafety = () => false
  await quota.ingestOAuthUsage('account', { ok: true, usage_status: 200, limits_present: true, usage_has_fable: false, five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.2 } })
  assert.equal(account.unified.account_tier, 'max')
  assert.equal(account.unified.account_max_multiplier, 20)
  assert.equal(account.unified.account_tier_source, 'profile')
  await quota.setAccountTier('account', 'pro', { source: 'profile' })
  assert.equal(account.unified.account_max_multiplier, null)
  assert.equal(inferClaudeTier({ has_token: true, usage_has_fable: true }, account.unified).key, 'pro')
})

test('VM file retains profile multiplier across usage writes and updates on plan change', async () => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const { persistAccountTier } = await import('../../src/lib/vm/vm-registry.mjs')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vm2api-max-plan-'))
  await fs.mkdir(path.join(root, 'vms'))
  const file = path.join(root, 'vms', 'vm-01.json')
  await fs.writeFile(file, JSON.stringify({ id: 'vm-01', claude: {} }))
  for (const multiplier of [5, 20]) {
    await persistAccountTier(root, 'vm-01', 'max', { source: 'profile', maxMultiplier: multiplier })
    await persistAccountTier(root, 'vm-01', 'pro', { source: 'usage' })
    const saved = JSON.parse(await fs.readFile(file, 'utf8')).claude
    assert.equal(saved.account_tier, 'max')
    assert.equal(saved.account_max_multiplier, multiplier)
  }
  await persistAccountTier(root, 'vm-01', 'pro', { source: 'profile' })
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).claude.account_max_multiplier, null)
})

test('slot model gate uses authoritative profile despite missing Fable usage', async () => {
  const { resolveSlotTier } = await import('../../src/lib/pool/slot-model-gate.mjs')
  assert.equal(resolveSlotTier({ claude: { account_tier: 'pro' } }, { unified: { account_tier: 'max', account_tier_source: 'profile', account_max_multiplier: 5, usage_has_fable: false } }), 'max')
})
