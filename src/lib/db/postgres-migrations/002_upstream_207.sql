-- 039_cluster_node_direct_links — optional direct TLS path to a node's slot gate.
--
-- When set, remote slot traffic dials kin-slot-gate at address:port with one
-- TLS connection per request instead of a channel on the long-lived SSH link.
-- cert_sha256 pins the gate's self-signed certificate (read over SSH); token
-- authorizes the connection and goes through maybeEncrypt.

CREATE TABLE IF NOT EXISTS cluster_node_direct_links (
  node_id TEXT PRIMARY KEY REFERENCES cluster_nodes(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  port INTEGER NOT NULL,
  token TEXT NOT NULL,
  cert_sha256 TEXT,
  updated_at TEXT NOT NULL
);

-- 040_cluster_node_platform — operating system of a cluster node.
--
-- 'linux' nodes run slots as Docker containers; 'darwin' nodes (Apple Silicon
-- Macs) run them as launchd services of the SSH user. Detected from `uname -s`
-- whenever the node's SSH link comes up; existing rows are Linux.

ALTER TABLE cluster_nodes ADD COLUMN platform TEXT NOT NULL DEFAULT 'linux';

-- 041_usage_logs_inbound_device — client device id captured before outbound rewrite.
-- Source: metadata.user_id.device_id, body device_id, or x-kin-device-id.
-- Absent on the inbound request stays NULL. Historical rows stay NULL.

ALTER TABLE usage_logs ADD COLUMN inbound_device_id TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_logs_inbound_device ON usage_logs(inbound_device_id, created_at);

