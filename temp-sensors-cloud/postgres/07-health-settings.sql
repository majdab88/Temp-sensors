-- ============================================================
-- Migration: per-org device-health alert settings
-- Run manually on existing deployments:
--   docker exec -i postgres psql -U tempsensors -d tempsensors < postgres/07-health-settings.sql
-- ============================================================

-- One row per org. Absent row = the compiled defaults (see backend/src/health.js
-- and routes/health.js). Controls the low-battery + sensor/hub offline alerts.
CREATE TABLE IF NOT EXISTS health_settings (
  org_id                 INT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  sensor_offline_enabled BOOLEAN DEFAULT TRUE,
  sensor_offline_minutes INT     DEFAULT 45,   -- no reading for this long → offline
  hub_offline_enabled    BOOLEAN DEFAULT TRUE,
  hub_offline_minutes    INT     DEFAULT 10,   -- grace after MQTT last-will
  low_battery_enabled    BOOLEAN DEFAULT TRUE,
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);
