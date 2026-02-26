'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publishSensorRemove } = require('../mqtt');

const router = express.Router();
router.use(requireAuth);

// GET /api/sensors — list all sensor nodes with their hub info
router.get('/', async (_req, res) => {
  try {
    const result = await query(
      `SELECT s.id, s.device_id, s.mac, s.name, s.paired_at, s.active,
              d.mac AS hub_mac, d.name AS hub_name
       FROM sensors s
       JOIN devices d ON d.id = s.device_id
       ORDER BY s.paired_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/sensors/:id — rename a sensor
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid sensor id' });
  }
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const result = await query(
      'UPDATE sensors SET name = $1 WHERE id = $2 RETURNING id, mac, name',
      [name.trim().slice(0, 64), id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Sensor not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/sensors/:id — remove a sensor and all its readings, notify hub via MQTT
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid sensor id' });
  }
  try {
    // Fetch hub MAC before deleting so we can publish the MQTT remove message
    const lookup = await query(
      'SELECT s.mac AS sensor_mac, d.mac AS hub_mac FROM sensors s JOIN devices d ON d.id = s.device_id WHERE s.id = $1',
      [id]
    );
    if (lookup.rows.length === 0) return res.status(404).json({ error: 'Sensor not found' });
    const { sensor_mac, hub_mac } = lookup.rows[0];

    await query('DELETE FROM sensors WHERE id = $1', [id]);

    // Tell the hub to remove the sensor from its memory, peer table, and NVS
    publishSensorRemove(hub_mac, sensor_mac);

    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
