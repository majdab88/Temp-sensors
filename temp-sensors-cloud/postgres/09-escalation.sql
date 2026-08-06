-- ============================================================
-- Migration: unacknowledged-alarm escalation
-- Run manually on existing deployments:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < postgres/09-escalation.sql
-- ============================================================

-- Per-org escalation config (extends health_settings). Absent columns fall back
-- to the compiled DEFAULTS in backend/src/health.js.
ALTER TABLE health_settings
  ADD COLUMN IF NOT EXISTS escalation_enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS escalation_minutes INT     DEFAULT 30;

-- Last time a reminder was sent for an open, unacknowledged excursion.
ALTER TABLE excursions
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
