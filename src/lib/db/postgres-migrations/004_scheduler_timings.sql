-- Old wait_ms is total selection elapsed time, not proven queue residence.
-- Leave new measurements NULL for historical requests; never reconstruct them.
ALTER TABLE request_attempts ADD COLUMN queue_wait_ms BIGINT;
ALTER TABLE request_attempts ADD COLUMN scheduling_ms BIGINT;
ALTER TABLE request_attempts ADD CONSTRAINT request_attempts_timing_nonnegative CHECK (
  (queue_wait_ms IS NULL OR queue_wait_ms >= 0) AND
  (scheduling_ms IS NULL OR scheduling_ms >= 0)
);
