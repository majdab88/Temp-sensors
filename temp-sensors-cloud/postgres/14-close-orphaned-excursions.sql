-- ============================================================
-- Migration: close excursions that were orphaned and can never end
-- Run manually on existing deployments:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < postgres/14-close-orphaned-excursions.sql
-- ============================================================
--
-- openExcursion() inserted unconditionally, and recovery closed only the single
-- excursion the running process happened to be tracking. So a backend restart
-- while a sensor was breaching could leave a row that nothing would ever look
-- at again -- permanently ONGOING, long after the sensor recovered.
--
-- The code no longer creates these. This clears the ones already stuck.

-- 1. Sensors that have since recovered: every open excursion is an orphan.
--    Ended at the time of the recovery event, not now, so the duration stays
--    truthful in the compliance record.
WITH latest AS (
  SELECT DISTINCT ON (sensor_id) sensor_id, kind, created_at
    FROM alert_events
   ORDER BY sensor_id, created_at DESC
)
UPDATE excursions e
   SET ended_at = l.created_at
  FROM latest l
 WHERE e.sensor_id = l.sensor_id
   AND l.kind = 'recovered'
   AND e.ended_at IS NULL;

-- 2. A sensor still breaching keeps only its most recent open excursion; any
--    older duplicates are orphans from a previous process.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY sensor_id ORDER BY started_at DESC) AS rn
    FROM excursions
   WHERE ended_at IS NULL
)
UPDATE excursions e
   SET ended_at = NOW()
  FROM ranked r
 WHERE e.id = r.id
   AND r.rn > 1;
