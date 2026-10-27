-- 042_usage_logs_image_generation — GPT image generation usage and cost.
-- image_usage keeps the raw `tool_usage.image_gen` / Images `usage` JSON so a reprice can split
-- text and image tokens again. Text-model token columns and PROMPT/TOTAL aggregates are unchanged.
-- Historical rows: image_* NULL / 0.

ALTER TABLE usage_logs ADD COLUMN image_model TEXT;
ALTER TABLE usage_logs ADD COLUMN image_usage TEXT;
ALTER TABLE usage_logs ADD COLUMN image_input_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN image_output_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN image_cost DOUBLE PRECISION;

-- Historical rows have no observed upstream window; never reconstruct it from TTFT.
ALTER TABLE usage_logs ADD COLUMN first_byte_ms BIGINT;
ALTER TABLE usage_logs ADD COLUMN generation_ms BIGINT;

-- Exact text classifyJev posted as payload.state. Not a span the model named.
ALTER TABLE usage_logs ADD COLUMN jev_state TEXT;

-- Per-provider-attempt telemetry. Never stores keys, prompts, questions or responses.
CREATE TABLE jev_usage_meta (
  id BIGINT PRIMARY KEY CHECK (id = 1),
  started_at TEXT NOT NULL
);
INSERT INTO jev_usage_meta (id, started_at) VALUES (1, to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
CREATE TABLE jev_usage_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  http_status BIGINT,
  outcome TEXT NOT NULL,
  duration_ms BIGINT NOT NULL,
  input_tokens BIGINT,
  output_tokens BIGINT,
  estimated_cost_nano_usd BIGINT,
  input_nano_usd_per_token BIGINT,
  output_nano_usd_per_token BIGINT,
  pricing_basis TEXT NOT NULL
);
CREATE INDEX idx_jev_usage_recent ON jev_usage_events(created_at DESC, id DESC);
CREATE INDEX idx_jev_usage_key_recent ON jev_usage_events(key_fingerprint, created_at DESC, id DESC);
-- 'all' plus one row per Asia/Shanghai day; daily rows are pruned after 90 days.
CREATE TABLE jev_usage_totals (
  period TEXT PRIMARY KEY,
  requests BIGINT NOT NULL DEFAULT 0,
  successful BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  unknown_usage_requests BIGINT NOT NULL DEFAULT 0,
  estimated_cost_nano_usd BIGINT NOT NULL DEFAULT 0,
  unknown_cost_requests BIGINT NOT NULL DEFAULT 0
);
