-- ============================================================
-- Migration: battery chemistry per sensor
-- Run manually on existing deployments:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < postgres/20-battery-type.sql
-- ============================================================
--
-- The battery percentage is computed in the backend (src/battery.js) from the
-- pack voltages, and which voltage means what depends on the cells: lithium
-- (L91) is judged by its voltage under load, alkaline by its voltage at rest.
-- Set per sensor from the dashboard.
--
-- Apply BEFORE deploying the backend that reads it: the sensor list and every
-- reading insert select this column.

ALTER TABLE sensors ADD COLUMN IF NOT EXISTS battery_type VARCHAR(16) NOT NULL DEFAULT 'lithium';
