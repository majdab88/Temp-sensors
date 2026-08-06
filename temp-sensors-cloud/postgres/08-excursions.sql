-- ============================================================
-- Migration: excursion records (accountability / compliance)
-- Run manually on existing deployments:
--   docker exec -i postgres psql -U tempsensors -d tempsensors < postgres/08-excursions.sql
-- ============================================================

-- One row per breach episode: opened when a sensor crosses its limit, peak
-- tracked while breached, closed on recovery. Acknowledgement records who
-- responded and when — the audit trail an inspector or food-safety manager
-- expects. Distinct from alert_events (which logs raw notification transitions).
CREATE TABLE IF NOT EXISTS excursions (
  id          BIGSERIAL PRIMARY KEY,
  sensor_id   INT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  kind        VARCHAR(8) NOT NULL CHECK (kind IN ('high', 'low')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ,                 -- NULL = still active
  peak_value  FLOAT,                       -- worst temperature during the episode
  limit_value FLOAT,                       -- the limit that was breached
  ack_at      TIMESTAMPTZ,                 -- NULL = not acknowledged
  ack_by      VARCHAR(255),                -- username / email of acknowledger
  ack_note    TEXT
);

CREATE INDEX IF NOT EXISTS excursions_sensor_started_idx ON excursions (sensor_id, started_at DESC);
-- Fast lookup of the currently-open excursion per sensor
CREATE INDEX IF NOT EXISTS excursions_open_idx ON excursions (sensor_id) WHERE ended_at IS NULL;
