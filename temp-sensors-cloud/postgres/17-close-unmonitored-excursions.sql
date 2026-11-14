-- ============================================================
-- Migration: close excursions that are no longer being monitored
-- Run manually on existing deployments:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < postgres/17-close-unmonitored-excursions.sql
-- ============================================================
--
-- Deleting or disabling a sensor's alert rule, or deleting the sensor, while it
-- was breaching left the excursion open: with no rule nothing evaluates its
-- readings, and a deleted sensor's readings are dropped, so no recovery could
-- ever close it. It showed as ONGOING and sent "still unacknowledged" reminders
-- until someone acknowledged it.
--
-- The backend now closes the excursion when that happens. This closes the ones
-- already stuck. Their true end is unknown, so they end now; the record keeps
-- its start, peak and limit.

UPDATE excursions e
   SET ended_at = NOW()
 WHERE e.ended_at IS NULL
   AND (
     NOT EXISTS (SELECT 1 FROM sensors s WHERE s.id = e.sensor_id AND s.active = TRUE)
     OR NOT EXISTS (SELECT 1 FROM alert_rules r WHERE r.sensor_id = e.sensor_id AND r.enabled = TRUE)
   );
