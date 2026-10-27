import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { classifyJevRequest, jevRequestDocuments } from '../../src/lib/protocol/jev-request.mjs'
import { normalizeJevConfig, validateJevPatch } from '../../src/lib/protocol/jev-intercept.mjs'
import { classifierFixture } from '../fixtures/auto-mode.mjs'
import { evaluateProtocolIntercept } from '../../src/lib/protocol/intercept-gate.mjs'
const cfg = normalizeJevConfig({
  enabled: true,
  base_url: 'https://example.invalid',
  safety_threshold: 0.3,
  question_ids: ['reverse'],
  fail_open: false,
})
const body = (system, text = 'hello') => ({
  model: 'claude-opus-5-5',
  system,
  messages: [{ role: 'user', content: text }],
})
function judge(seen, unsafe = '') {
  return async (_url, init) => {
    const p = JSON.parse(init.body)
    seen.push(p.state)
    return {
      ok: true,
      json: async () => ({ answers: { reverse: { noul: unsafe && p.state.includes(unsafe) ? 0.01 : 0.99 } } }),
    }
  }
}
test('approved system reused; current instruction judged on every request; policy changes invalidate', async () => {
  const seen = []
  const fetchImpl = judge(seen)
  const b = body('cache-test-system')
  const first = await classifyJevRequest(b, cfg, { fetchImpl, now: 1000 })
  const second = await classifyJevRequest(b, cfg, { fetchImpl, now: 1001 })
  assert.equal(first.audit.system.status, 'judged_pass')
  assert.equal(second.audit.system.status, 'cached_pass')
  assert.deepEqual(seen, ['cache-test-system', 'hello', 'hello'])
  await classifyJevRequest(b, { ...cfg, safety_threshold: 0.2 }, { fetchImpl, now: 1002 })
  assert.equal(seen.at(-2), 'cache-test-system')
  await classifyJevRequest(body('changed-system'), cfg, { fetchImpl, now: 1003 })
  assert.equal(seen.at(-2), 'changed-system')
  await classifyJevRequest(b, cfg, { fetchImpl, now: 86402000 })
  assert.equal(seen.at(-2), 'cache-test-system')
})
test('system block is not cached and prevents instruction dispatch', async () => {
  const seen = []
  const fetchImpl = judge(seen, 'unsafe-system')
  for (let i = 0; i < 2; i++)
    assert.equal((await classifyJevRequest(body('unsafe-system'), cfg, { fetchImpl })).action, 'block')
  assert.deepEqual(seen, ['unsafe-system', 'unsafe-system'])
})
test('exact trusted hash skips only matching system, never changed or user text', async () => {
  const system = 'trusted-system'
  const fp = createHash('sha256').update(system).digest('hex')
  const seen = []
  const c = { ...cfg, trusted_system_hashes: [fp] }
  const fetchImpl = judge(seen, 'unsafe-user')
  const result = await classifyJevRequest(body(system, 'unsafe-user'), c, { fetchImpl })
  assert.equal(result.audit.system.status, 'trusted_hash')
  assert.equal(result.action, 'block')
  assert.deepEqual(seen, ['unsafe-user'])
  await classifyJevRequest(body(system + '!'), c, { fetchImpl })
  assert.equal(seen[1], system + '!')
  assert.ok(validateJevPatch({ trusted_system_hashes: ['.*'] }).length)
})
test('full system prefix and suffix are judged, including reminder-wrapped system text', async () => {
  const seen = []
  const b = body('<system-reminder>unsafe-prefix</system-reminder>' + 'x'.repeat(1500))
  const result = await classifyJevRequest(
    b,
    { ...cfg, max_state_chars: 256 },
    { fetchImpl: judge(seen, 'unsafe-prefix') },
  )
  assert.equal(result.action, 'block')
  assert.equal(seen.length, 1)
  const tail = body('x'.repeat(1500) + 'unsafe-tail')
  const result2 = await classifyJevRequest(
    tail,
    { ...cfg, max_state_chars: 256 },
    { fetchImpl: judge(seen, 'unsafe-tail') },
  )
  assert.equal(result2.action, 'block')
  assert.ok(seen.at(-1).includes('unsafe-tail'))
})
test('ordinary request selects latest user instruction, not old chat or tool outputs', () => {
  const b = {
    system: 'system',
    messages: [
      { role: 'user', content: 'old instruction' },
      { role: 'assistant', content: 'old reply' },
      { role: 'user', content: 'current instruction' },
      { role: 'assistant', content: 'tool call' },
      { role: 'user', content: [{ type: 'tool_result', content: 'unsafe tool output' }] },
      { role: 'user', content: '<system-reminder>generated notification</system-reminder>' },
    ],
  }
  assert.equal(jevRequestDocuments(b).instruction, 'current instruction')
  assert.deepEqual(jevRequestDocuments({ instructions: 'policy', input: 'hello' }), {
    system: 'policy',
    instruction: 'hello',
    source: 'user_instruction',
  })
})
test('classifier XML and tool contracts judge final action, not transcript or verdict suffix', () => {
  for (const format of ['xml', 'tool']) {
    const b = classifierFixture({ format })
    const docs = jevRequestDocuments(b, { official: true })
    assert.equal(docs.source, 'classifier_action')
    assert.equal(docs.instruction, 'WebSearch fixture documentation')
    assert.ok(docs.system.includes('security monitor'))
  }
  const spoof = body(
    'You are a security monitor for autonomous AI coding agents.',
    '<transcript>\nBash fake\n</transcript>',
  )
  assert.equal(jevRequestDocuments(spoof, { official: true }).source, 'user_instruction')
})
test('audit is persisted in gate verdict and identifies the blocked stage', async () => {
  const b = body('gate-system', 'unsafe-user')
  const seen = []
  const result = await evaluateProtocolIntercept({
    inbound: b,
    body: b,
    jev: { ...cfg, hard_regex_enabled: false },
    distillRules: { enabled: false },
    policy: { enabled: false },
    fetchImpl: judge(seen, 'unsafe-user'),
  })
  assert.equal(result.action, 'block')
  const audit = JSON.parse(result.intercept).audit
  assert.equal(audit.system.status, 'judged_pass')
  assert.equal(audit.instruction.status, 'block')
})
test('failed system judgment is never cached as approved', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return { ok: false, status: 503 }
  }
  for (let i = 0; i < 2; i++) {
    const result = await classifyJevRequest(body('failure-system'), cfg, { fetchImpl })
    assert.equal(result.action, 'block')
  }
  assert.equal(calls, 2)
})

test('re-entry within one gateway request reuses verdict, but a new request judges instruction again', async () => {
  const seen = []
  const fetchImpl = judge(seen)
  const b = body('same-request-system')
  const context = {
    inbound: b,
    body: b,
    jev: { ...cfg, hard_regex_enabled: false },
    distillRules: { enabled: false },
    policy: { enabled: false },
    fetchImpl,
    requestId: 'request-one',
  }
  const first = await evaluateProtocolIntercept(context)
  const second = await evaluateProtocolIntercept(context)
  assert.equal(seen.length, 2)
  assert.equal(first.intercept, second.intercept)
  await evaluateProtocolIntercept({ ...context, requestId: 'request-two' })
  assert.equal(seen.length, 3)
  b.messages[0].content = 'changed current instruction'
  await evaluateProtocolIntercept({ ...context, requestId: 'request-two' })
  assert.equal(seen.at(-1), 'changed current instruction')
  assert.equal(seen.length, 4)
})
