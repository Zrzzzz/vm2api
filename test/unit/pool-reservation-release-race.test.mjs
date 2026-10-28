import test from 'node:test'
import assert from 'node:assert/strict'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

for (const phase of ['quota', 'circuit']) {
  test(`release during ${phase} admission does not resurrect account occupancy`, async () => {
    let pause = null
    let quotaInflight = 0
    const gate = async (current) => {
      if (pause?.phase === current) {
        pause.entered.resolve()
        await pause.resume.promise
      }
      return { ok: true }
    }
    const scheduler = new PoolScheduler({
      accountQuota: {
        async tryAcquire() {
          await gate('quota')
          quotaInflight += 1
          return { ok: true }
        },
        release() {
          quotaInflight -= 1
        },
      },
    })
    scheduler.unitCircuit = { admit: () => gate('circuit') }
    await scheduler.ready
    const candidate = { accountId: 'race-account', vmId: 'race-vm', model: 'claude-sonnet-4-5', maxConcurrency: 2 }

    // Repeated handoffs must not gradually consume the account's capacity.
    for (let round = 0; round < 20; round += 1) {
      const first = await scheduler.reserve(candidate)
      assert.ok(first)
      pause = { phase, entered: deferred(), resume: deferred() }
      const pending = scheduler.reserve(candidate)
      await pause.entered.promise
      first.release()
      pause.resume.resolve()
      const second = await pending
      pause = null
      assert.ok(second)
      assert.equal(scheduler.inflight.get(candidate.accountId), 1)
      assert.equal(scheduler.vmInflight.get(candidate.vmId), 1)
      assert.equal(quotaInflight, 1)

      const third = await scheduler.reserve(candidate)
      assert.ok(third, 'the released capacity must be reusable')
      assert.equal(await scheduler.reserve(candidate), null, 'the configured cap must still hold')
      second.release()
      third.release()
      third.release()
      assert.equal(scheduler.inflight.size, 0)
      assert.equal(scheduler.vmInflight.size, 0)
      assert.equal(quotaInflight, 0)
    }
  })
}
