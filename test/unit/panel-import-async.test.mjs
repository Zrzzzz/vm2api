import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

for (const endpoint of [
  '/api/panel/vms/import',
  '/api/panel/vms/vm-02/oauth/generate-auth-url',
  '/api/panel/vms/vm-02/oauth/exchange-code',
]) {
  test(`${endpoint} awaits proxy validation before returning its status`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-import-async-'))
    try {
      fs.mkdirSync(path.join(root, 'vms'))
      fs.writeFileSync(path.join(root, 'vms/vm-02.json'), JSON.stringify({ id: 'vm-02' }))
      let resolved = false
      let response
      const handle = createPanelHandler({
        cfg: { paths: { project: root } },
        requireAuth(req) {
          req.apiKeyKind = 'master'
          req.panelRole = 'admin'
          return true
        },
        readBody: async () => ({ vm_id: 'vm-02', session_key: 'test-only' }),
        requireSlotProxy: async () => {
          await new Promise(resolve => setImmediate(resolve))
          resolved = true
          return { ok: false, status: 400, message: 'proxy unavailable' }
        },
        json(_res, status, body) {
          assert.equal(resolved, true)
          assert.equal(status, 400)
          response = body
          return true
        },
      })
      await handle({ method: 'POST' }, {}, new URL(endpoint, 'http://localhost'))
      assert.equal(response.ok, false)
      assert.equal(response.error.message, 'proxy unavailable')
    } finally {
      execFileSync('trash', [root])
    }
  })
}
