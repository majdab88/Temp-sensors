-- ============================================================
-- Migration: pack voltage per reading
-- Run manually on existing deployments:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < postgres/19-battery-voltage.sql
-- ============================================================
--
-- NTC sensors from 1.1.16 (through a hub from 1.1.28) report the pack voltage
-- twice: at rest, and the lowest seen with the radio on. A lithium pack's
-- resting voltage stays high until it is nearly empty, so the percentage is
-- worked out here from the voltage under load (src/battery.js), and the table
-- that does it can be corrected without updating every sensor by hand.
--
-- Apply BEFORE deploying the backend that writes them: without the columns
-- every reading insert fails.

ALTER TABLE readings ADD COLUMN IF NOT EXISTS bat_mv      SMALLINT;
ALTER TABLE readings ADD COLUMN IF NOT EXISTS bat_load_mv SMALLINT;
