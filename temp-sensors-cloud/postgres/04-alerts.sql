-- ============================================================
-- Migration: Temperature alerts (phase 1 — threshold + dashboard)
-- Run manually on existing deployments:
--   docker exec -i postgres psql -U tempsensors -d tempsensors < postgres/04-alerts.sql
-- ============================================================

-- One alert rule per sensor. Threshold-based for phase 1; hysteresis prevents
-- flapping around the limit, cooldown throttles re-notifications while breached.
CREATE TABLE IF NOT EXISTS alert_rules (
  id         SERIAL PRIMARY KEY,
  sensor_id  INT NOT NULL UNIQUE REFERENCES sensors(id) ON DELETE CASCADE,
  high_limit FLOAT,                                    -- fire 'high' when temp > this (NULL = disabled)
  low_limit  FLOAT,                                    -- fire 'low'  when temp < this (NULL = disabled)
  hysteresis FLOAT   DEFAULT 1.0,                      -- clear band in °C (must fall this far back inside to recover)
  channels   TEXT[]  DEFAULT '{dashboard}',           -- subset of: dashboard, push, whatsapp (only dashboard delivers in phase 1)
  cooldown_s INT     DEFAULT 1800,                     -- min seconds between re-notifies while still breached (0 = notify once)
  enabled    BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit trail of every alert transition (breach + recovery). Also seeds the
-- engine's in-memory state on backend restart.
CREATE TABLE IF NOT EXISTS alert_events (
  id         BIGSERIAL PRIMARY KEY,
  rule_id    INT REFERENCES alert_rules(id) ON DELETE CASCADE,
  sensor_id  INT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  kind       VARCHAR(12) NOT NULL CHECK (kind IN ('high', 'low', 'recovered')),
  value      FLOAT,                                    -- reading (°C) that triggered the transition
  channels   TEXT[],                                   -- channels the notification was actually delivered on
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS alert_events_sensor_id_created_at_idx
  ON alert_events (sensor_id, created_at DESC);
