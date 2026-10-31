-- Additive schema for persisted daily monitor reports. No release history changes.
CREATE TABLE IF NOT EXISTS monitor_report_configs (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_report_at TIMESTAMPTZ NOT NULL,
  last_report_at TIMESTAMPTZ,
  last_message_id TEXT,
  lease_until TIMESTAMPTZ,
  lease_token TEXT,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
