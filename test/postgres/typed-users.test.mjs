import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestDatabase } from './isolated-db.mjs'
import { UsersRepo } from '../../src/lib/db/adapters/postgres/repos/users-repo.mts'
import { ownerScopeFromRequest } from '../../src/lib/admin/resource-owner.mts'

test('typed users preserve CRUD, roles, balances and transaction rollback', async () => {
  const db = await createTestDatabase()
  try {
    const users = new UsersRepo(db)
    const now = new Date().toISOString()
    const inserted = await users.insert({
      id: 'typed-admin',
      username: 'TypedAdmin',
      password_hash: 'test-only',
      role: 'admin',
      created_at: now,
      updated_at: now,
    })
    assert.equal(inserted.email, 'TypedAdmin@panel.local')
    assert.equal(inserted.enabled, true)
    assert.equal((await users.getByUsername('typedadmin')).id, inserted.id)
    assert.equal(await users.countEnabledRole('admin'), 1)
    assert.equal((await users.list()).length, 1)
    const request = { apiKeyKind: 'managed', apiKeyRecord: { user_id: inserted.id } }
    assert.deepEqual(await ownerScopeFromRequest(request, users), { type: 'platform' })
    const credited = await db.withEntityLock('user', inserted.id, () => users.addBalance(inserted.id, 7.5))
    assert.equal(credited.balance, 7.5)
    assert.equal(await db.transaction(() => 42), 42)
    await assert.rejects(
      db.transaction(async () => {
        await users.addBalance(inserted.id, 10)
        throw new Error('rollback typed user')
      }),
      /rollback typed user/,
    )
    assert.equal((await users.getById(inserted.id)).balance, 7.5)
    await users.update({ ...credited, role: 'user', enabled: false })
    assert.deepEqual(await ownerScopeFromRequest(request, users), { type: 'user', userId: inserted.id })
    assert.equal((await users.getById(inserted.id)).enabled, false)
    assert.equal(await users.countEnabledRole('admin'), 0)
    assert.equal(await users.remove(inserted.id), true)
    assert.equal(await users.remove(inserted.id), false)
    assert.equal(await users.getById(inserted.id), null)
    assert.deepEqual(await users.list(), [])
  } finally {
    await db.close()
  }
})
