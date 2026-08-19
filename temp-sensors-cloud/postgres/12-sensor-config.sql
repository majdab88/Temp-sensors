-- ============================================================
-- Migration: remote sensor configuration (Phase 2)
-- Run manually on existing deployments:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < postgres/12-sensor-config.sql
-- ============================================================

-- Desired configuration per sensor. The applied version is sensors.cfg_ver,
-- reported by the node itself in every data frame (migration 10), so "did this
-- land?" is answered by comparing the two rather than by assuming.
--
-- Delivery takes up to one full reporting interval: a sleeping sensor can only
-- be reached in the brief window after it transmits.
ALTER TABLE sensors
  ADD COLUMN IF NOT EXISTS cfg_desired_ver INT     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cfg_sleep_secs  INT,
  ADD COLUMN IF NOT EXISTS cfg_temp_offset REAL,
  ADD COLUMN IF NOT EXISTS cfg_temp_gain   REAL,
  ADD COLUMN IF NOT EXISTS cfg_updated_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cfg_applied_at  TIMESTAMPTZ;

-- Calibration changes shift every subsequent reading, so a step in the history
-- must remain explicable months later. One row per change, rendered as a marker
-- on temperature charts.
CREATE TABLE IF NOT EXISTS sensor_config_events (
  id          SERIAL PRIMARY KEY,
  sensor_id   INT REFERENCES sensors(id) ON DELETE CASCADE,
  cfg_ver     INT,
  sleep_secs  INT,
  temp_offset REAL,
  temp_gain   REAL,
  changed_by  INT REFERENCES users(id) ON DELETE SET NULL,
  changed_at  TIMESTAMPTZ DEFAULT NOW(),
  applied_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sensor_config_events_sensor_idx
  ON sensor_config_events (sensor_id, changed_at DESC);
