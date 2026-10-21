import { parentPort, workerData } from 'node:worker_threads'
import { openDatabase, closeDatabase } from '../db/database.mjs'
import { runBackupJob } from './backup-core.mjs'

try {
  await openDatabase({env:{...process.env,PGPOOL_MAX:'2'}})
  const rec = await runBackupJob(workerData.ctx, workerData.job)
  parentPort.postMessage({ ok: true, rec })
} catch (e) {
  parentPort.postMessage({
    ok: false,
    error: { message: String((e && e.message) || e), code: (e && e.code) || null },
  })
} finally {
  try {
    await closeDatabase()
  } catch {}
}
