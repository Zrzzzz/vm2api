import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ESLint } from 'eslint'
import { diagnostics, newDiagnostics, strictDiagnostics } from '../../scripts/check-type-regressions.mjs'

const baseline = JSON.parse(fs.readFileSync(new URL('../../typecheck-baseline.json', import.meta.url), 'utf8'))

test('type gate catches the actual missing-await bug at repository and all three request boundaries', () => {
  const mutations = [
    [
      'src/lib/db/adapters/postgres/repos/users-repo.mts',
      '(await this.db.query<UserRow>(this._get, [id]))',
      'this.db.query<UserRow>(this._get, [id])',
    ],
    ['src/lib/admin/resource-owner.mts', '(await usersRepo.getById(userId))', 'usersRepo.getById(userId)'],
    [
      'src/lib/protocol/handle-protocol.mjs',
      'await ownerScopeFromRequest(req, apiKeyStore?.users)',
      'ownerScopeFromRequest(req, apiKeyStore?.users)',
    ],
    [
      'src/lib/protocol/user-count-tokens.mjs',
      'await ownerScopeFromRequest(req, usersRepo)',
      'ownerScopeFromRequest(req, usersRepo)',
    ],
  ]
  const overrides = new Map(
    mutations.map(([file, before, after]) => {
      const source = fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8')
      assert.ok(source.includes(before), `Mutation target changed: ${file}`)
      return [file, source.replace(before, after)]
    }),
  )
  const strictErrors = strictDiagnostics(overrides)
  for (const [file] of mutations.slice(0, 2)) {
    assert.ok(
      strictErrors.some((d) => d.file === file && /Promise|Raw</.test(d.message)),
      `Strict gate missed ${file}`,
    )
  }
  const added = newDiagnostics(diagnostics(overrides), baseline)
  for (const [file] of mutations) {
    assert.ok(
      added.some((d) => d.file === file && /Promise|Raw</.test(d.message)),
      `Missing type error for ${file}`,
    )
  }
})

test('type-aware ESLint rejects dropped Promises and Promise conditions', async () => {
  const eslint = new ESLint()
  const [result] = await eslint.lintText(
    `
    async function queryUser() { return { role: 'admin' } }
    queryUser()
    if (queryUser()) console.log('incorrect permission decision')
  `,
    { filePath: 'src/lib/admin/resource-owner.mts' },
  )
  const rules = new Set(result.messages.map((m) => m.ruleId))
  assert.ok(rules.has('@typescript-eslint/no-floating-promises'))
  assert.ok(rules.has('@typescript-eslint/no-misused-promises'))
})

test('a second identical diagnostic cannot hide behind the baseline', () => {
  const diagnostic = { file: 'example.mjs', code: 2339, message: 'Promise.role' }
  assert.equal(newDiagnostics([diagnostic, diagnostic], [diagnostic]).length, 1)
})

test('strict TypeScript rejects an untyped transaction callback without a baseline', () => {
  const file = 'src/lib/db/adapters/postgres/database.mts'
  const source = fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8')
  const before = 'transaction<T>(fn: () => T | PromiseLike<T>)'
  assert.ok(source.includes(before))
  const errors = strictDiagnostics(new Map([[file, source.replace(before, 'transaction<T>(fn)')]]))
  assert.ok(errors.some((d) => d.file === file && d.code === 7006 && d.message.includes('fn')))
})

test('async lint checks actual query, transaction and entity-lock results', async () => {
  const eslint = new ESLint()
  const [result] = await eslint.lintText(
    `
    import type { PostgresDatabase } from '../database.mts'
    declare const db: PostgresDatabase
    db.query('SELECT 1')
    db.transaction(async () => 1)
    db.withEntityLock('user', 'u1', async () => 1)
    if (db.transaction(async () => false)) console.log('incorrect permission decision')
  `,
    { filePath: 'src/lib/db/adapters/postgres/repos/users-repo.mts' },
  )
  assert.equal(result.messages.filter((m) => m.ruleId === '@typescript-eslint/no-floating-promises').length, 3)
  assert.ok(result.messages.some((m) => m.ruleId === '@typescript-eslint/no-misused-promises'))
})
