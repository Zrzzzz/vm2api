/** PostgreSQL custom-format snapshots bundled with slot and configuration files. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { spawnSync } from 'node:child_process'
import { getDb, closeDatabase, openDatabase } from '../db/database.mjs'
import { adapter } from '../db/adapters/index.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { BackupRepo } from '../db/repos/backup-repo.mjs'
import { reconcileVms } from '../vm/vm-db-sync.mjs'
import { repairSlotSmbios, repairVmProxyCliEnabled } from '../vm/vm-registry.mjs'
import { invalidateReadCache, isVmRecordFile } from '../vm/vm-file.mjs'

const SCHEDULE_KEY = 'backup_schedule'

export const DEFAULT_SCHEDULE = {
  enabled: true,
  interval_hours: 24,
  retention: 7,
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-')
}

// Chunked on purpose: the DB snapshot and the archive both outgrow Node's
// ~2 GiB Buffer ceiling, and readFileSync would throw before hashing.
function sha256File(file) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
    let read = 0
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(read === buf.length ? buf : buf.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

export function tarAvailable() {
  try {
    const r = spawnSync('tar', ['--version'], { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

export class BackupService {
  constructor({ dataDir, projectRoot, configDir, backupDir, tmpDir, checkIntervalMs = 10 * 60_000 } = {}) {
    this.dataDir = dataDir
    this.projectRoot = projectRoot
    this.configDir = configDir || null
    this.backupDir = backupDir || path.join(dataDir, 'backups')
    this.tmpDir = tmpDir || path.join(dataDir, 'tmp')
    this.checkIntervalMs = checkIntervalMs
    this.isRestoring = false
    this._running = false
    this._timer = null
    this._bootTimer = null
    this._rebindStores = null // set via onRestored()
  }

  _repo() {
    return new BackupRepo(getDb())
  }
  _settings() {
    return new SettingsRepo(getDb())
  }

  /** Staging dir on the data volume — the DB snapshot can be several GB. */
  _mkdtemp(prefix) {
    const base = process.env.KIN_BACKUP_TMPDIR || this.tmpDir
    fs.mkdirSync(base, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(base, 0o700)
    } catch {}
    return fs.mkdtempSync(path.join(base, prefix))
  }

  /** Register the callback that re-binds stores to the new DB after restore. */
  onRestored(fn) {
    this._rebindStores = typeof fn === 'function' ? fn : null
  }

  // ---------- schedule config ----------

  async getSchedule() {
    let cfg = { ...DEFAULT_SCHEDULE, ...((await this._settings().get(SCHEDULE_KEY, {})) || {}) }
    if (process.env.KIN_BACKUP_DISABLED === '1') cfg.enabled = false
    if (process.env.KIN_BACKUP_INTERVAL_HOURS) {
      const n = Number(process.env.KIN_BACKUP_INTERVAL_HOURS)
      if (Number.isFinite(n) && n > 0) cfg.interval_hours = n
    }
    if (process.env.KIN_BACKUP_RETENTION) {
      const n = Number(process.env.KIN_BACKUP_RETENTION)
      if (Number.isFinite(n) && n > 0) cfg.retention = n
    }
    return cfg
  }

  async updateSchedule(patch = {}) {
    const cur = { ...DEFAULT_SCHEDULE, ...((await this._settings().get(SCHEDULE_KEY, {})) || {}) }
    if (patch.enabled != null) cur.enabled = !!patch.enabled
    if (patch.interval_hours != null) {
      const n = Number(patch.interval_hours)
      if (!Number.isFinite(n) || n < 1 || n > 24 * 30) {
        throw Object.assign(new Error('interval_hours must be 1..720'), { code: 'invalid_interval' })
      }
      cur.interval_hours = n
    }
    if (patch.retention != null) {
      const n = Math.floor(Number(patch.retention))
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        throw Object.assign(new Error('retention must be 1..100'), { code: 'invalid_retention' })
      }
      cur.retention = n
    }
    await this._settings().set(SCHEDULE_KEY, cur)
    return (await this.getSchedule())
  }

  async nextAutoAt() {
    const cfg = (await this.getSchedule())
    if (!cfg.enabled) return null
    const last = (await this._repo().lastSuccessful({}))
    const base = last ? Date.parse(last.created_at) : 0
    return new Date(Math.max(Date.now(), base + cfg.interval_hours * 3600_000)).toISOString()
  }

  // ---------- create ----------

  /** @returns backup record */
  async createBackup({ kind = 'manual', note = null } = {}) {
    if (this._running) throw Object.assign(new Error('backup already in progress'), { code: 'backup_in_progress' })
    this._running = true
    const id = 'bak_' + crypto.randomBytes(6).toString('hex')
    const createdAt = new Date().toISOString()
    try {
      return await this._runBackupWorker({
        id,
        createdAt,
        kind,
        note,
        retention: (await this.getSchedule()).retention,
      })
    } catch (e) {
      // The worker records its own failure; this covers the cases where it never
      // got that far (module error, OOM, kill) so the panel still shows the job.
      try {
        if (!(await this._repo().get(id))) {
          await this._repo().insert({
            id,
            created_at: createdAt,
            kind,
            status: 'failed',
            file_path: null,
            file_name: null,
            size_bytes: null,
            sha256: null,
            db_bytes: null,
            includes: null,
            error: String(e.message || e).slice(0, 500),
            note,
          })
        }
      } catch {}
      throw e
    } finally {
      this._running = false
    }
  }

  _runBackupWorker(job) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./backup-worker.mjs', import.meta.url), {
        workerData: {
          dataDir: this.dataDir,
          ctx: {
            projectRoot: this.projectRoot,
            configDir: this.configDir,
            backupDir: this.backupDir,
            tmpDir: this.tmpDir,
          },
          job,
        },
      })
      let settled = false
      const finish = (fn, arg) => {
        if (settled) return
        settled = true
        fn(arg)
      }
      worker.once('message', (msg) => {
        if (msg && msg.ok) return finish(resolve, msg.rec)
        finish(
          reject,
          Object.assign(new Error((msg && msg.error && msg.error.message) || 'backup failed'), {
            code: (msg && msg.error && msg.error.code) || 'backup_failed',
          }),
        )
      })
      worker.once('error', (e) => finish(reject, e))
      worker.once('exit', (code) => {
        if (code !== 0) finish(reject, new Error(`backup worker exited with code ${code}`))
      })
    })
  }

  // ---------- retention ----------

  async applyRetention() {
    const cfg = (await this.getSchedule())
    const repo = this._repo()
    const drop = [...(await repo.beyondRetention(cfg.retention)), ...(await repo.preRestoreBeyond(3))]
    for (const rec of drop) {
      try {
        if (rec.file_path && fs.existsSync(rec.file_path)) fs.rmSync(rec.file_path, { force: true })
      } catch {}
      try {
        await repo.remove(rec.id)
      } catch {}
    }
    return drop.length
  }

  // ---------- list / delete ----------

  async list({ limit = 100 } = {}) {
    return (await this._repo()
      .list({ limit }))
      .map((r) => ({
        ...r,
        file_exists: !!(r.file_path && fs.existsSync(r.file_path)),
      }))
  }

  async get(id) {
    return (await this._repo().get(id))
  }

  async remove(id) {
    const rec = (await this._repo().get(id))
    if (!rec) return false
    try {
      if (rec.file_path && fs.existsSync(rec.file_path)) fs.rmSync(rec.file_path, { force: true })
    } catch {}
    return (await this._repo().remove(id))
  }

  // ---------- restore ----------

  /**
   * Restore from a recorded backup. Automatically snapshots the current
   * state first (kind=pre_restore). Re-binds stores via onRestored callback.
   */
  async restoreBackup(id) {
    const rec = (await this._repo().get(id))
    if (!rec) throw Object.assign(new Error('backup not found'), { code: 'backup_not_found' })
    if (rec.status !== 'ok')
      throw Object.assign(new Error('backup record is not restorable'), { code: 'backup_not_ok' })
    if (!rec.file_path || !fs.existsSync(rec.file_path)) {
      throw Object.assign(new Error('backup file missing on disk'), { code: 'backup_file_missing' })
    }
    if (this.isRestoring) throw Object.assign(new Error('restore already in progress'), { code: 'restore_in_progress' })

    // integrity: archive checksum must match the record
    const actual = sha256File(rec.file_path)
    if (rec.sha256 && actual !== rec.sha256) {
      throw Object.assign(new Error('backup archive sha256 mismatch'), { code: 'backup_corrupt' })
    }

    this.isRestoring = true
    let tmp = null
    try {
      // 0. safety net snapshot of the current state
      const pre = (await this.createBackup({ kind: 'pre_restore', note: `before restore of ${rec.id}` }))

      // Only verified PostgreSQL archives can be restored.
      tmp = this._mkdtemp('kin-restore-')
      if (!rec.file_name?.endsWith('.tar.gz')) throw new Error('Not a PostgreSQL backup archive')
      const extracted = spawnSync('tar', ['-xzf', rec.file_path, '-C', tmp], { stdio: 'pipe' })
      if (extracted.status !== 0) throw new Error('Backup extraction failed')
      const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'))
      if (manifest.version !== 2 || manifest.engine !== 'postgresql') throw new Error('Not a PostgreSQL backup archive')
      const dbFile = path.join(tmp, 'db', 'database.dump')
      if (!manifest.sha256s?.['db/database.dump'] || sha256File(dbFile) !== manifest.sha256s['db/database.dump']) {
        throw Object.assign(new Error('Database snapshot checksum mismatch'), {code:'backup_corrupt'})
      }
      await closeDatabase()
      await adapter.backup.restorePostgres(dbFile)

      // 3. restore vm + config files from the archive (tar flavor only)
      const vmsDirSrc = path.join(tmp, 'vms')
      if (this.projectRoot && fs.existsSync(vmsDirSrc)) {
        const vmsDir = path.join(this.projectRoot, 'vms')
        fs.mkdirSync(vmsDir, { recursive: true })
        // replace vm json records with archive state (cli-home dirs untouched)
        for (const f of fs.readdirSync(vmsDir)) {
          if (isVmRecordFile(f) || f === 'active.json') {
            try {
              fs.rmSync(path.join(vmsDir, f), { force: true })
            } catch {}
          }
        }
        for (const f of fs.readdirSync(vmsDirSrc)) {
          fs.copyFileSync(path.join(vmsDirSrc, f), path.join(vmsDir, f))
          try {
            fs.chmodSync(path.join(vmsDir, f), 0o600)
          } catch {}
        }
      }
      const cfgDirSrc = path.join(tmp, 'config')
      if (this.configDir && fs.existsSync(cfgDirSrc)) {
        fs.mkdirSync(this.configDir, { recursive: true })
        for (const f of fs.readdirSync(cfgDirSrc)) {
          fs.copyFileSync(path.join(cfgDirSrc, f), path.join(this.configDir, f))
        }
      }

      // 4. reopen + migrate (old backups upgrade automatically)
      const db = await openDatabase()

      // 5. db-only backups: rebuild vm files from the credential mirror
      if (this.projectRoot) {
        invalidateReadCache()
        try {
          await reconcileVms(this.projectRoot)
          try {
            await repairVmProxyCliEnabled(this.projectRoot)
          } catch {}
          try {
            await repairSlotSmbios(this.projectRoot)
          } catch {}
        } catch {}
      }

      // 6. the ledger itself rolled back with the DB — re-register the
      //    pre_restore snapshot (and any other on-disk archives) so the
      //    user can still see/undo from the panel.
      try {
        await this._registerOrphanArchives([pre, rec])
      } catch {}

      // 7. re-bind stores to the fresh connection. A failed rebind leaves the
      //    process partially attached to the closed database, so it must make
      //    the restore fail instead of reporting a false success.
      if (this._rebindStores) await this._rebindStores(db)

      return { ok: true, restored: rec.id, pre_restore: pre.id }
    } finally {
      this.isRestoring = false
      if (tmp) {
        try {
          fs.rmSync(tmp, { recursive: true, force: true })
        } catch {}
      }
    }
  }

  /**
   * Insert ledger rows for archive files that exist on disk but have no
   * record in the (freshly restored) DB. `known` records are inserted
   * verbatim; remaining orphans get kind='imported'.
   */
  async _registerOrphanArchives(known = []) {
    const repo = this._repo()
    const existing = new Set((await repo.list({ limit: 500 })).map((r) => r.file_name))
    for (const rec of known) {
      if (rec?.file_name && !existing.has(rec.file_name) && rec.file_path && fs.existsSync(rec.file_path)) {
        try {
          await repo.insert(rec)
          existing.add(rec.file_name)
        } catch {}
      }
    }
    if (!fs.existsSync(this.backupDir)) return
    for (const f of fs.readdirSync(this.backupDir)) {
      if (!/^kin-backup-.*\.(tar\.gz|db\.gz)$/.test(f) || existing.has(f)) continue
      const fp = path.join(this.backupDir, f)
      try {
        const st = fs.statSync(fp)
        await repo.insert({
          id: 'bak_' + crypto.randomBytes(6).toString('hex'),
          created_at: st.mtime.toISOString(),
          kind: 'imported',
          status: 'ok',
          file_path: fp,
          file_name: f,
          size_bytes: st.size,
          sha256: sha256File(fp),
          db_bytes: null,
          includes: null,
          error: null,
          note: 're-registered from disk after restore',
        })
        existing.add(f)
      } catch {}
    }
  }

  // ---------- scheduler ----------

  /** Auto-backup checker: every checkIntervalMs + a catch-up run at boot. */
  startScheduler() {
    this.stopScheduler()
    const check = async () => {
      try {
        if ((await this.shouldRunScheduled())) {
          await this.createBackup({ kind: 'scheduled' })
          console.log('[backup] scheduled backup completed')
        }
      } catch (e) {
        console.warn('[backup] scheduled backup failed:', String(e.message || e))
      }
    }
    this._timer = setInterval(check, this.checkIntervalMs)
    if (typeof this._timer.unref === 'function') this._timer.unref()
    // boot catch-up (delayed so startup isn't blocked)
    this._bootTimer = setTimeout(check, 5_000)
    if (typeof this._bootTimer.unref === 'function') this._bootTimer.unref()
  }

  async shouldRunScheduled(now = Date.now()) {
    const cfg = (await this.getSchedule())
    if (!cfg.enabled || this._running || this.isRestoring) return false
    const last = (await this._repo().lastSuccessful({}))
    if (!last) return true
    return now - Date.parse(last.created_at) >= cfg.interval_hours * 3600_000
  }

  stopScheduler() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (this._bootTimer) {
      clearTimeout(this._bootTimer)
      this._bootTimer = null
    }
  }
}
