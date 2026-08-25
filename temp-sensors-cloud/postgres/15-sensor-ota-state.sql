-- ============================================================
-- Migration: sensor firmware transfer state
-- Run manually on existing deployments:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < postgres/15-sensor-ota-state.sql
-- ============================================================
--
-- Migration 11 added these to devices, for hub firmware. Sensors need their
-- own: a sensor image is relayed by its hub, so the transfer belongs to the
-- sensor rather than to the hub carrying it, and both can be in flight at once.
--
-- Without them, staging an image published the MQTT command and then failed
-- writing the record, so the hub had the job while the dashboard showed an
-- error and no progress.
ALTER TABLE sensors
  ADD COLUMN IF NOT EXISTS ota_state      VARCHAR(16),
  ADD COLUMN IF NOT EXISTS ota_version    VARCHAR(16),
  ADD COLUMN IF NOT EXISTS ota_pct        INT,
  ADD COLUMN IF NOT EXISTS ota_error      TEXT,
  ADD COLUMN IF NOT EXISTS ota_updated_at TIMESTAMPTZ;
