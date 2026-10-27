import { getDb } from '../../../database.mjs'

function parse(value, fallback = null) {
  if (value == null) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function rowToAttempt(row) {
  if (!row) return null
  return {
    id: row.id,
    request_id: row.request_id,
    attempt_no: row.attempt_no,
    vm_id: row.vm_id,
    account_id: row.account_id,
    model: row.model,
    selection_reason: row.selection_reason,
    started_at: row.started_at,
    completed_at: row.completed_at,
    upstream_status: row.upstream_status,
    error_scope: row.error_scope,
    action: row.action,
    cooldown_until: row.cooldown_until,
    downstream_committed: !!row.downstream_committed,
    terminal_state: row.terminal_state,
    usage: parse(row.usage_json),
    wait_ms: row.wait_ms,
    queue_wait_ms: row.queue_wait_ms,
    scheduling_ms: row.scheduling_ms,
    ttft_ms: row.ttft_ms,
    latency_ms: row.latency_ms,
  }
}

export class RequestAttemptsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._insert = "\n      INSERT INTO request_attempts (\n        request_id, attempt_no, vm_id, account_id, model, selection_reason,\n        started_at, completed_at, upstream_status, error_scope, action,\n        cooldown_until, downstream_committed, terminal_state, usage_json,\n        wait_ms, ttft_ms, latency_ms, queue_wait_ms, scheduling_ms\n      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)\n    "
    this._complete = "\n      UPDATE request_attempts SET\n        completed_at = $1, upstream_status = $2, error_scope = $3, action = $4,\n        cooldown_until = $5, downstream_committed = $6, terminal_state = $7,\n        usage_json = $8, ttft_ms = $9, latency_ms = $10\n      WHERE request_id = $11 AND attempt_no = $12\n    "
    this._list = "\n      SELECT * FROM request_attempts WHERE request_id = $1 ORDER BY attempt_no\n    "

  }

  async begin({ requestId, attemptNo, vmId, accountId, model, selectionReason, waitMs = 0, queueWaitMs = null, schedulingMs = null }) {
    const startedAt = new Date().toISOString()
    ;(await this.db.query(this._insert, [requestId, attemptNo, vmId ?? null, accountId ?? null, model ?? null, selectionReason ?? null, startedAt, null, null, null, null, null, 0, 'started', null, waitMs ?? 0, null, null, queueWaitMs, schedulingMs]))
    return (await this.list(requestId)).find((item) => item.attempt_no === attemptNo) || null
  }

  async complete(requestId, attemptNo, result = {}) {
    ;(await this.db.query(this._complete, [new Date().toISOString(), result.upstreamStatus ?? null, result.errorScope ?? null, result.action ?? null, result.cooldownUntil ?? null, result.downstreamCommitted ? 1 : 0, result.terminalState ?? null, result.usage != null ? JSON.stringify(result.usage) : null, result.ttftMs ?? null, result.latencyMs ?? null, requestId, attemptNo]))
    return (await this.list(requestId)).find((item) => item.attempt_no === attemptNo) || null
  }

  async list(requestId) {
    return (await this.db.query(this._list, [requestId])).rows.map(rowToAttempt)
  }

  async cleanup() { return 0 }
}
