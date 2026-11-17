'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth, isSuperadminUnscoped } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { publishSensorRemove, pushSyncToHub, publishLiveRequest } = require('../mqtt');
const { closeExcursion, resetSensor } = require('../alerts');
const { audit } = require('../audit');
const { batteryPct, BATTERY_TYPES } = require('../battery');

const router = express.Router();
router.use(requireAuth);

// The org a sensor lookup must be restricted to: null for an unscoped
// superadmin, otherwise the caller's org (requirePermission guarantees one).
const scopeOrg = (req) => (isSuperadminUnscoped(req) ? null : req.orgId);

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
                s.fw_version, s.fw_reported_at, s.cfg_ver, s.probe_error, s.probe_error_at,
                s.ota_state, s.ota_version, s.ota_pct, s.ota_error, s.ota_updated_at,
                s.live_until, s.live_interval_s, s.live_requested_at, s.cfg_sleep_secs, s.battery_type,
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
                s.fw_version, s.fw_reported_at, s.cfg_ver, s.probe_error, s.probe_error_at,
                s.ota_state, s.ota_version, s.ota_pct, s.ota_error, s.ota_updated_at,
                s.live_until, s.live_interval_s, s.live_requested_at, s.cfg_sleep_secs, s.battery_type,
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

// PUT /api/sensors/:id/battery-type — which cells are in the holder. Picks the
// table the percentage is computed from (see battery.js), and recomputes the
// stored percentage of every reading that carries voltages, so the card and
// the history agree with the new type straight away rather than from the next
// reading on.
router.put('/:id/battery-type', requirePermission('editor'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid sensor id' });
  }
  const { type } = req.body || {};
  if (!BATTERY_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${BATTERY_TYPES.join(', ')}` });
  }

  if (!isSuperadminUnscoped(req) && req.orgId) {
    const check = await query(
      'SELECT 1 FROM sensors s JOIN devices d ON d.id = s.device_id WHERE s.id = $1 AND d.org_id = $2',
      [id, req.orgId]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Sensor not found' });
  }

  try {
    const result = await query(
      'UPDATE sensors SET battery_type = $1 WHERE id = $2 RETURNING id',
      [type, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Sensor not found' });

    const rows = (await query(
      `SELECT id, bat_mv, bat_load_mv FROM readings
       WHERE sensor_id = $1 AND (bat_mv IS NOT NULL OR bat_load_mv IS NOT NULL)`,
      [id]
    )).rows;
    const ids = [], pcts = [];
    for (const r of rows) {
      const pct = batteryPct(type, { restMv: r.bat_mv, loadMv: r.bat_load_mv });
      if (pct != null) { ids.push(r.id); pcts.push(pct); }
    }
    if (ids.length) {
      await query(
        `UPDATE readings r SET battery = v.pct
         FROM unnest($1::bigint[], $2::smallint[]) AS v(id, pct)
         WHERE r.id = v.id`,
        [ids, pcts]
      );
    }

    const latest = (await query(
      'SELECT battery FROM readings WHERE sensor_id = $1 ORDER BY recorded_at DESC LIMIT 1',
      [id]
    )).rows[0];
    await audit({ req, action: 'sensor.battery_type', targetType: 'sensor', targetId: id, details: { type } });
    res.json({ id, battery_type: type, battery: latest ? latest.battery : null, recomputed: ids.length });
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
    // Its readings are dropped from now on, so nothing would ever close a
    // breach that was open at this moment: it would show as ongoing forever
    // and keep sending "still unacknowledged" reminders.
    await closeExcursion(id);
    resetSensor(id);

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

// POST /api/sensors/:id/live — ask a node to stay awake and report repeatedly
//
// A sleeping sensor cannot be woken on demand: its radio is off, and listening
// often enough to matter would cost most of the battery. This instead extends a
// wake it was going to have anyway, so the answer arrives within one reporting
// interval rather than instantly.
//
// The node does not stay awake for the session -- it keeps deep-sleeping
// between readings, just for less time. Five minutes awake costs about 3.3 mAh;
// the same five minutes as ten short wakes costs about 0.4 mAh.
router.post('/:id/live', requirePermission('editor'), async (req, res) => {
  const duration = Math.min(Math.max(parseInt(req.body?.duration_s, 10) || 300, 60), 300);
  // Each live reading is a full wake -- boot, read, transmit, sleep -- costing
  // a second or two. Intervals near that spend the session on overhead rather
  // than on readings, which is what the floor is protecting.
  const interval = Math.min(Math.max(parseInt(req.body?.interval_s, 10) || 30, 20), 120);

  try {
    const r = await query(
      `SELECT s.id, s.mac, s.name, s.cfg_sleep_secs, d.mac AS hub_mac
         FROM sensors s JOIN devices d ON d.id = s.device_id
        WHERE s.id = $1 AND s.active = TRUE
          AND ($2::int IS NULL OR d.org_id = $2)`,
      [parseInt(req.params.id, 10) || 0, scopeOrg(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Sensor not found' });
    const s2 = r.rows[0];

    publishLiveRequest(s2.hub_mac, s2.mac, duration, interval);
    await query('UPDATE sensors SET live_requested_at = NOW() WHERE id = $1', [s2.id]);

    await audit({
      req, action: 'sensor.live', targetType: 'sensor', targetId: s2.id,
      details: { sensor_mac: s2.mac, duration_s: duration, interval_s: interval },
    });

    res.json({
      requested: true,
      duration_s: duration,
      interval_s: interval,
      // The node picks this up on its next wake, so that is the wait.
      starts_within_secs: s2.cfg_sleep_secs || 900,
    });
  } catch (err) {
    console.error('Live request error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to request live mode' });
  }
});

// DELETE /api/sensors/:id/live — end a live burst early
//
// Sent as a live request with duration 0. The node is awake and reporting every
// few seconds while live, so unlike a start this is delivered almost at once.
router.delete('/:id/live', requirePermission('editor'), async (req, res) => {
  try {
    const r = await query(
      `SELECT s.id, s.mac, d.mac AS hub_mac
         FROM sensors s JOIN devices d ON d.id = s.device_id
        WHERE s.id = $1 AND s.active = TRUE
          AND ($2::int IS NULL OR d.org_id = $2)`,
      [parseInt(req.params.id, 10) || 0, scopeOrg(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Sensor not found' });
    const s2 = r.rows[0];

    publishLiveRequest(s2.hub_mac, s2.mac, 0, 0);
    // Cleared here rather than waiting for the hub to confirm: if the node is
    // already asleep no confirmation is coming, and the card should not keep
    // claiming it is live.
    await query(
      'UPDATE sensors SET live_until = NULL, live_requested_at = NULL WHERE id = $1',
      [s2.id]
    );

    await audit({
      req, action: 'sensor.live.stop', targetType: 'sensor', targetId: s2.id,
      details: { sensor_mac: s2.mac },
    });

    res.json({ stopped: true });
  } catch (err) {
    console.error('Live stop error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to stop live mode' });
  }
});

module.exports = router;
