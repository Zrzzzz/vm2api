/**
 * refusal_guards — persisted AUP fingerprints. Lookup before hop; remember after refusal.
 * signature is the user-text MinHash used for the 90% near-duplicate check.
 */
import { decodeSignature, REFUSAL_SIMILARITY, signatureSimilarity } from '../../../../core/refusal-similarity.mjs'
import { getDb } from '../../../database.mjs'

function rowToRec(row) {
  if (!row) return null
  return {
    fingerprint: row.fingerprint,
    model: row.model,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    hit_count: Number(row.hit_count) || 0,
    source_request_id: row.source_request_id,
    error_message: row.error_message,
    preview: row.preview,
    expires_at: row.expires_at || null,
  }
}

export class RefusalGuardsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = "SELECT * FROM refusal_guards WHERE fingerprint = $1"
    this._insert = "\n      INSERT INTO refusal_guards (\n        fingerprint, model, first_seen_at, last_seen_at, hit_count,\n        source_request_id, error_message, preview, expires_at, signature\n      ) VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9)\n      ON CONFLICT(fingerprint) DO UPDATE SET\n        last_seen_at = excluded.last_seen_at,\n        error_message = COALESCE(excluded.error_message, refusal_guards.error_message),\n        preview = COALESCE(excluded.preview, refusal_guards.preview),\n        signature = COALESCE(excluded.signature, refusal_guards.signature),\n        expires_at = CASE\n          WHEN refusal_guards.expires_at IS NULL THEN NULL\n          WHEN excluded.expires_at IS NULL THEN NULL\n          ELSE excluded.expires_at\n        END\n    "
    this._hit = "\n      UPDATE refusal_guards SET hit_count = hit_count + 1, last_seen_at = $1\n      WHERE fingerprint = $2\n    "
    this._list = "SELECT fingerprint, model, first_seen_at, last_seen_at, hit_count,\n              source_request_id, error_message, preview, expires_at\n       FROM refusal_guards ORDER BY last_seen_at DESC, fingerprint LIMIT $1"
    this._signatures = "SELECT fingerprint, signature FROM refusal_guards\n       WHERE signature IS NOT NULL AND (expires_at IS NULL OR expires_at > $1)"
    this._count = "SELECT COUNT(*) AS n FROM refusal_guards"
    this._remove = "DELETE FROM refusal_guards WHERE fingerprint = $1"
    this._clear = "DELETE FROM refusal_guards"
  }

  async get(fingerprint) {
    const rec = rowToRec((await this.db.query(this._get, [String(fingerprint || '')])).rows[0])
    if (!rec?.expires_at) return rec
    if (Date.parse(rec.expires_at) > Date.now()) return rec
    await this.remove(rec.fingerprint)
    return null
  }

  async remember({
    fingerprint = null,
    model = '',
    requestId = null,
    errorMessage = null,
    preview = null,
    expiresAt = null,
    signature = null,
  } = {}) {
    const fp = String(fingerprint || '').trim()
    if (!fp) return null
    const now = new Date().toISOString()
    ;(await this.db.query(this._insert, [fp, String(model || ''), now, now, requestId, errorMessage ? String(errorMessage).slice(0, 500) : null, preview ? String(preview).slice(0, 240) : null, expiresAt || null, signature || null]))
    return (await this.get(fp))
  }

  async hit(fingerprint) {
    const fp = String(fingerprint || '').trim()
    if (!fp) return null
    ;(await this.db.query(this._hit, [new Date().toISOString(), fp]))
    return (await this.get(fp))
  }
  /** Highest stored user-text signature at or above the threshold. */
  async nearest(signature, threshold = REFUSAL_SIMILARITY) {
    const query = Array.isArray(signature) ? signature : decodeSignature(signature)
    if (!query) return null
    let best = null
    for (const row of (await this.db.query(this._signatures, [new Date().toISOString()])).rows) {
      const score = signatureSimilarity(query, decodeSignature(row.signature))
      if (score < threshold) continue
      if (!best || score > best.score) best = { fingerprint: row.fingerprint, score }
    }
    if (!best) return null
    const rec = (await this.get(best.fingerprint))
    if (!rec) return null
    return { ...rec, score: best.score }
  }

  async list(limit = 200) {
    const n = Math.min(500, Math.max(1, Number(limit) || 200))
    const now = Date.now()
    return (await this.db.query(this._list, [n])).rows
      .map(rowToRec)
      .filter((rec) => !rec.expires_at || Date.parse(rec.expires_at) > now)
  }

  async count() {
    return Number((await this.db.query(this._count, [])).rows[0]?.n) || 0
  }

  async remove(fingerprint) {
    const fp = String(fingerprint || '').trim()
    if (!fp) return false
    return (await this.db.query(this._remove, [fp])).rowCount > 0
  }

  async clear() {
    return (await this.db.query(this._clear, [])).rowCount
  }
}
