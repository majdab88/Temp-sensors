'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth, isSuperadminUnscoped } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

// mergeParams: true makes req.params.id (from the parent route) available here
const router = express.Router({ mergeParams: true });
router.use(requireAuth);

// Verify sensor belongs to the user's org (skip for unscoped superadmin)
async function checkSensorAccess(req, sensorId) {
  if (isSuperadminUnscoped(req)) return true;
  if (!req.orgId) return false;
  const check = await query(
    'SELECT 1 FROM sensors s JOIN devices d ON d.id = s.device_id WHERE s.id = $1 AND d.org_id = $2',
    [sensorId, req.orgId]
  );
  return check.rows.length > 0;
}

// GET /api/sensors/:id/readings
// Query params: from, to (ISO timestamps), limit (default 500, max 5000)
router.get('/', requirePermission('viewer'), async (req, res) => {
  const sensorId = parseInt(req.params.id, 10);
  if (!Number.isInteger(sensorId) || sensorId <= 0) {
    return res.status(400).json({ error: 'Invalid sensor id' });
  }

  if (!(await checkSensorAccess(req, sensorId))) {
    return res.status(404).json({ error: 'Sensor not found' });
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  const { from, to } = req.query;

  // Build WHERE clause dynamically; $1 = sensorId, $2 = limit
  const params = [sensorId, limit];
  let where = 'WHERE sensor_id = $1';
  let nextParam = 3;

  if (from) {
    where += ` AND recorded_at >= $${nextParam++}`;
    params.push(from);
  }
  if (to) {
    where += ` AND recorded_at <= $${nextParam++}`;
    params.push(to);
  }

  try {
    const result = await query(
      `SELECT id, temp, hum, battery, rssi, recorded_at
       FROM readings
       ${where}
       ORDER BY recorded_at DESC
       LIMIT $2`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/sensors/:id/readings/export.csv — full readings as CSV for the range
router.get('/export.csv', requirePermission('viewer'), async (req, res) => {
  const sensorId = parseInt(req.params.id, 10);
  if (!Number.isInteger(sensorId) || sensorId <= 0) return res.status(400).json({ error: 'Invalid sensor id' });
  if (!(await checkSensorAccess(req, sensorId))) return res.status(404).json({ error: 'Sensor not found' });

  const { from, to } = req.query;
  const params = [sensorId];
  let where = 'WHERE r.sensor_id = $1';
  if (from) { params.push(from); where += ` AND r.recorded_at >= $${params.length}`; }
  if (to)   { params.push(to);   where += ` AND r.recorded_at <= $${params.length}`; }

  try {
    const nameRes = await query('SELECT name, mac FROM sensors WHERE id = $1', [sensorId]);
    const label = (nameRes.rows[0]?.name || nameRes.rows[0]?.mac || `sensor-${sensorId}`).replace(/[^\w.-]+/g, '_');
    const result = await query(
      `SELECT r.recorded_at, r.temp, r.hum, r.battery, r.rssi
       FROM readings r ${where} ORDER BY r.recorded_at ASC LIMIT 50000`,
      params
    );
    const lines = ['recorded_at,temp_c,humidity_pct,battery_pct,rssi_dbm'];
    for (const r of result.rows) {
      lines.push([
        r.recorded_at.toISOString(),
        r.temp ?? '', r.hum ?? '',
        r.battery != null && r.battery !== 255 ? r.battery : '',
        r.rssi ?? '',
      ].join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${label}-readings-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/sensors/:id/readings/latest
router.get('/latest', requirePermission('viewer'), async (req, res) => {
  const sensorId = parseInt(req.params.id, 10);
  if (!Number.isInteger(sensorId) || sensorId <= 0) {
    return res.status(400).json({ error: 'Invalid sensor id' });
  }

  if (!(await checkSensorAccess(req, sensorId))) {
    return res.status(404).json({ error: 'Sensor not found' });
  }

  try {
    const result = await query(
      `SELECT id, temp, hum, battery, rssi, recorded_at
       FROM readings
       WHERE sensor_id = $1
       ORDER BY recorded_at DESC
       LIMIT 1`,
      [sensorId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No readings found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
