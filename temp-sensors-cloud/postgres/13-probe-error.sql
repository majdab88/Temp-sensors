-- ============================================================
-- Migration: surface NTC probe failures (Phase 2 follow-up)
-- Run manually on existing deployments:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < postgres/13-probe-error.sql
-- ============================================================

-- A sensor reports -999 when it cannot read its probe -- open, shorted, or out
-- of range. The hub used to drop those frames, so a failed probe reached the
-- cloud as nothing at all: the node looked quiet rather than broken, and the
-- last good reading stayed on screen.
--
-- Now the frame is forwarded, the reading is stored with a NULL temperature,
-- and this flag says why it is NULL.
ALTER TABLE sensors
  ADD COLUMN IF NOT EXISTS probe_error    BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS probe_error_at TIMESTAMPTZ;
