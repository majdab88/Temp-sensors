'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth, isSuperadminUnscoped } = require('../middleware/auth');

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
router.get('/', async (req, res) => {
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

// GET /api/sensors/:id/readings/latest
router.get('/latest', async (req, res) => {
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
