-- ============================================================
-- Migration: firmware / config version reporting (Phase 0)
-- Run manually on existing deployments:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < postgres/10-firmware-versions.sql
-- ============================================================

-- Hub firmware version, reported in the retained status payload on every
-- MQTT connect. NULL means the hub has not yet been updated to firmware that
-- reports a version.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS fw_version     VARCHAR(16),
  ADD COLUMN IF NOT EXISTS fw_reported_at TIMESTAMPTZ;

-- Sensor firmware version and applied config version, reported in every data
-- frame and forwarded by the hub.
--
-- fw_version NULL / cfg_ver 0 means a pre-1.0 sensor that does not report them:
-- the hub zero-fills the missing fields rather than dropping the frame, so an
-- un-updated node still delivers readings normally.
ALTER TABLE sensors
  ADD COLUMN IF NOT EXISTS fw_version     VARCHAR(16),
  ADD COLUMN IF NOT EXISTS cfg_ver        INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fw_reported_at TIMESTAMPTZ;
