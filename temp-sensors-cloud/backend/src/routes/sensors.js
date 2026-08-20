'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth, isSuperadminUnscoped } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { publishSensorRemove, pushSyncToHub } = require('../mqtt');
const { audit } = require('../audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/sensors — list sensor nodes scoped by org
router.get('/', async (req, res) => {
  try {
    let result;
    // Join the latest reading for each sensor so the app gets current
    // temp, hum, rssi, battery, and lastUpdate on initial load.
    const latestReadingJoin = `
      LEFT JOIN LATERAL (
        SELECT r.temp, r.hum, r.rssi, r.battery, r.recorded_at
        FROM readings r
        WHERE r.sensor_id = s.id
        ORDER BY r.recorded_at DESC
        LIMIT 1
      ) lr ON TRUE`;

    if (isSuperadminUnscoped(req)) {
      result = await query(
        `SELECT s.id, s.device_id, s.mac, s.name, s.paired_at, s.active,
                s.fw_version, s.cfg_ver, s.probe_error, s.probe_error_at,
                d.mac AS hub_mac, d.name AS hub_name, d.org_id,
                lr.temp, lr.hum, lr.rssi, lr.battery,
                EXTRACT(EPOCH FROM lr.recorded_at)::bigint AS "lastUpdate"
         FROM sensors s
         JOIN devices d ON d.id = s.device_id
         ${latestReadingJoin}
         WHERE s.active = TRUE
         ORDER BY s.paired_at DESC`
      );
    } else if (req.orgId) {
      result = await query(
        `SELECT s.id, s.device_id, s.mac, s.name, s.paired_at, s.active,
                s.fw_version, s.cfg_ver, s.probe_error, s.probe_error_at,
                d.mac AS hub_mac, d.name AS hub_name,
                lr.temp, lr.hum, lr.rssi, lr.battery,
                EXTRACT(EPOCH FROM lr.recorded_at)::bigint AS "lastUpdate"
         FROM sensors s
         JOIN devices d ON d.id = s.device_id
         ${latestReadingJoin}
         WHERE s.active = TRUE AND d.org_id = $1
         ORDER BY s.paired_at DESC`,
        [req.orgId]
      );
    } else {
      result = { rows: [] };
    }
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/sensors/:id — rename a sensor (with ownership check)
router.put('/:id', requirePermission('editor'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid sensor id' });
  }
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  // Ownership check for non-superadmin
  if (!isSuperadminUnscoped(req) && req.orgId) {
    const check = await query(
      'SELECT 1 FROM sensors s JOIN devices d ON d.id = s.device_id WHERE s.id = $1 AND d.org_id = $2',
      [id, req.orgId]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Sensor not found' });
  }

  try {
    const result = await query(
      'UPDATE sensors SET name = $1 WHERE id = $2 RETURNING id, mac, name',
      [name.trim().slice(0, 64), id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Sensor not found' });
    await audit({ req, action: 'sensor.rename', targetType: 'sensor', targetId: id, details: { name: name.trim() } });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/sensors/:id — remove a sensor and all its readings, notify hub via MQTT
router.delete('/:id', requirePermission('editor'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid sensor id' });
  }
  try {
    // Fetch hub MAC before deleting so we can publish the MQTT remove message
    const lookup = await query(
      'SELECT s.mac AS sensor_mac, d.mac AS hub_mac, d.org_id FROM sensors s JOIN devices d ON d.id = s.device_id WHERE s.id = $1',
      [id]
    );
    if (lookup.rows.length === 0) return res.status(404).json({ error: 'Sensor not found' });
    const { sensor_mac, hub_mac, org_id } = lookup.rows[0];

    // Ownership check for non-superadmin
    if (!isSuperadminUnscoped(req) && req.orgId && org_id !== req.orgId) {
      return res.status(404).json({ error: 'Sensor not found' });
    }

    // Delete all readings first, then soft-delete the sensor row.
    // Soft-delete (active = FALSE) prevents the upsert in handleSensorData
    // from re-activating the sensor if a stale data frame arrives later.
    await query('DELETE FROM readings WHERE sensor_id = $1', [id]);
    await query('UPDATE sensors SET active = FALSE WHERE id = $1', [id]);

    // Push the updated (reduced) sensor list to the hub via the proven sync topic.
    // The hub runs applySyncFromCloud which removes any sensor no longer in the list.
    // publishSensorRemove is kept as a belt-and-suspenders fire-and-forget alongside.
    publishSensorRemove(hub_mac, sensor_mac);
    await pushSyncToHub(hub_mac);

    await audit({ req, action: 'sensor.delete', targetType: 'sensor', targetId: id, details: { mac: sensor_mac, hub_mac } });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
