'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth, isSuperadminUnscoped } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { resetSensor, formatAlertMessage, KNOWN_CHANNELS } = require('../alerts');
const { audit } = require('../audit');

const router = express.Router();
router.use(requireAuth);

/**
 * Resolve a sensor id, enforcing org ownership for non-superadmins.
 * Returns { id, name } or null if not found / not owned.
 */
async function findOwnedSensor(req, sensorId) {
  if (isSuperadminUnscoped(req)) {
    const r = await query('SELECT s.id, s.name FROM sensors s WHERE s.id = $1 AND s.active = TRUE', [sensorId]);
    return r.rows[0] || null;
  }
  if (!req.orgId) return null;
  const r = await query(
    `SELECT s.id, s.name
     FROM sensors s JOIN devices d ON d.id = s.device_id
     WHERE s.id = $1 AND s.active = TRUE AND d.org_id = $2`,
    [sensorId, req.orgId]
  );
  return r.rows[0] || null;
}

function parseSensorId(req, res) {
  const id = parseInt(req.params.sensorId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid sensor id' });
    return null;
  }
  return id;
}

// GET /api/alerts/rules/:sensorId — fetch the rule for a sensor (null if none)
router.get('/rules/:sensorId', async (req, res) => {
  const sensorId = parseSensorId(req, res);
  if (sensorId === null) return;
  try {
    const sensor = await findOwnedSensor(req, sensorId);
    if (!sensor) return res.status(404).json({ error: 'Sensor not found' });

    const result = await query('SELECT * FROM alert_rules WHERE sensor_id = $1', [sensorId]);
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/alerts/rules/:sensorId — create or update the sensor's alert rule
router.put('/rules/:sensorId', requirePermission('editor'), async (req, res) => {
  const sensorId = parseSensorId(req, res);
  if (sensorId === null) return;

  const body = req.body || {};

  // Validation ---------------------------------------------------------------
  const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));
  const highLimit = numOrNull(body.high_limit);
  const lowLimit  = numOrNull(body.low_limit);
  if (highLimit !== null && !Number.isFinite(highLimit)) return res.status(400).json({ error: 'high_limit must be a number or null' });
  if (lowLimit  !== null && !Number.isFinite(lowLimit))  return res.status(400).json({ error: 'low_limit must be a number or null' });
  if (highLimit === null && lowLimit === null) return res.status(400).json({ error: 'At least one of high_limit or low_limit is required' });
  if (highLimit !== null && lowLimit !== null && lowLimit >= highLimit) {
    return res.status(400).json({ error: 'low_limit must be below high_limit' });
  }

  let hysteresis = body.hysteresis === undefined ? 1.0 : Number(body.hysteresis);
  if (!Number.isFinite(hysteresis) || hysteresis < 0) return res.status(400).json({ error: 'hysteresis must be a non-negative number' });

  let cooldownS = body.cooldown_s === undefined ? 1800 : parseInt(body.cooldown_s, 10);
  if (!Number.isInteger(cooldownS) || cooldownS < 0) return res.status(400).json({ error: 'cooldown_s must be a non-negative integer' });

  let channels = body.channels === undefined ? ['dashboard'] : body.channels;
  if (!Array.isArray(channels) || channels.length === 0 || !channels.every((c) => KNOWN_CHANNELS.includes(c))) {
    return res.status(400).json({ error: `channels must be a non-empty subset of ${KNOWN_CHANNELS.join(', ')}` });
  }
  channels = [...new Set(channels)];

  const enabled = body.enabled === undefined ? true : !!body.enabled;

  try {
    const sensor = await findOwnedSensor(req, sensorId);
    if (!sensor) return res.status(404).json({ error: 'Sensor not found' });

    const result = await query(
      `INSERT INTO alert_rules (sensor_id, high_limit, low_limit, hysteresis, channels, cooldown_s, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (sensor_id) DO UPDATE
         SET high_limit = EXCLUDED.high_limit,
             low_limit  = EXCLUDED.low_limit,
             hysteresis = EXCLUDED.hysteresis,
             channels   = EXCLUDED.channels,
             cooldown_s = EXCLUDED.cooldown_s,
             enabled    = EXCLUDED.enabled,
             updated_at = NOW()
       RETURNING *`,
      [sensorId, highLimit, lowLimit, hysteresis, channels, cooldownS, enabled]
    );

    resetSensor(sensorId); // re-evaluate against new limits on next reading
    await audit({ req, action: 'alert.rule.set', targetType: 'sensor', targetId: sensorId, details: { highLimit, lowLimit, enabled } });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/alerts/rules/:sensorId — remove the sensor's alert rule
router.delete('/rules/:sensorId', requirePermission('editor'), async (req, res) => {
  const sensorId = parseSensorId(req, res);
  if (sensorId === null) return;
  try {
    const sensor = await findOwnedSensor(req, sensorId);
    if (!sensor) return res.status(404).json({ error: 'Sensor not found' });

    await query('DELETE FROM alert_rules WHERE sensor_id = $1', [sensorId]);
    resetSensor(sensorId);
    await audit({ req, action: 'alert.rule.delete', targetType: 'sensor', targetId: sensorId });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/alerts/active — sensors currently in a breached state, org-scoped.
// Derived from the latest alert_event per sensor (authoritative, restart-safe).
// Shape matches the live `alert` socket event so the dashboard can seed from it.
router.get('/active', async (req, res) => {
  try {
    const params = [];
    let orgFilter = '';
    if (!isSuperadminUnscoped(req)) {
      if (!req.orgId) return res.json([]);
      params.push(req.orgId);
      orgFilter = `AND d.org_id = $${params.length}`;
    }

    const result = await query(
      `SELECT latest.sensor_mac, latest.sensor_name, latest.hub_mac,
              latest.kind, latest.value, latest.high_limit, latest.low_limit, latest.ts,
              latest.excursion_id, latest.ack_at, latest.ack_by
       FROM (
         SELECT DISTINCT ON (e.sensor_id)
                s.mac AS sensor_mac, s.name AS sensor_name, d.mac AS hub_mac,
                e.kind, e.value, r.high_limit, r.low_limit, r.enabled,
                ex.id AS excursion_id, ex.ack_at, ex.ack_by,
                EXTRACT(EPOCH FROM e.created_at)::bigint AS ts
         FROM alert_events e
         JOIN sensors s ON s.id = e.sensor_id
         JOIN devices d ON d.id = s.device_id
         LEFT JOIN alert_rules r ON r.sensor_id = e.sensor_id
         LEFT JOIN excursions ex ON ex.sensor_id = e.sensor_id AND ex.ended_at IS NULL
         WHERE s.active = TRUE ${orgFilter}
         ORDER BY e.sensor_id, e.created_at DESC
       ) latest
       -- Only report a breach that is STILL valid under the current rule:
       -- the stored reading must still violate the (possibly just-changed) limit,
       -- and the rule must still exist and be enabled. Otherwise the sensor is no
       -- longer breaching (the engine records 'recovered' on its next reading) and
       -- we must not emit a stale, self-contradictory message.
       WHERE latest.kind <> 'recovered'
         AND latest.enabled IS TRUE
         AND (
           (latest.kind = 'high' AND latest.high_limit IS NOT NULL AND latest.value > latest.high_limit)
           OR (latest.kind = 'low' AND latest.low_limit IS NOT NULL AND latest.value < latest.low_limit)
         )`,
      params
    );

    const rows = result.rows.map((r) => ({
      sensor_mac: r.sensor_mac,
      sensor_name: r.sensor_name,
      hub_mac: r.hub_mac,
      kind: r.kind,
      value: r.value,
      high_limit: r.high_limit,
      low_limit: r.low_limit,
      message: formatAlertMessage({ name: r.sensor_name || r.sensor_mac, temp: r.value, kind: r.kind, high: r.high_limit, low: r.low_limit }),
      ts: r.ts * 1000,
      excursion_id: r.excursion_id ?? null,
      acked: r.ack_at != null,
      ack_by: r.ack_by ?? null,
    }));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/alerts/events — recent alert transitions, org-scoped
//   ?sensor_id=<id>  filter to one sensor
//   ?limit=<n>       default 100, max 500
router.get('/events', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const sensorId = req.query.sensor_id ? parseInt(req.query.sensor_id, 10) : null;

  try {
    const where = [];
    const params = [];

    if (!isSuperadminUnscoped(req)) {
      if (!req.orgId) return res.json([]);
      params.push(req.orgId);
      where.push(`d.org_id = $${params.length}`);
    }
    if (sensorId) {
      params.push(sensorId);
      where.push(`e.sensor_id = $${params.length}`);
    }
    params.push(limit);

    const result = await query(
      `SELECT e.id, e.sensor_id, s.name AS sensor_name, s.mac AS sensor_mac,
              d.mac AS hub_mac, e.kind, e.value, e.channels,
              EXTRACT(EPOCH FROM e.created_at)::bigint AS ts
       FROM alert_events e
       JOIN sensors s ON s.id = e.sensor_id
       JOIN devices d ON d.id = s.device_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY e.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
