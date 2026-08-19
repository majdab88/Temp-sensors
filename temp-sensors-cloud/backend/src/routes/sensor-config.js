'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth, requireSuperadmin } = require('../middleware/auth');
const { audit } = require('../audit');
const { publishSensorConfig } = require('../mqtt');

const router = express.Router();
router.use(requireAuth);

// Calibration and reporting cadence affect the integrity of the temperature
// record, so this is superadmin-only rather than an org-level permission.
router.use(requireSuperadmin);

// These must match the clamps compiled into the sensor. The device enforces its
// own limits regardless — this copy exists to give a useful error instead of a
// silent rejection that only shows up as "still pending" an hour later.
const LIMITS = {
  sleep_secs:  { min: 300,  max: 3600 },
  temp_offset: { min: -10,  max: 10   },
  temp_gain:   { min: 0.9,  max: 1.1  },
};

function validate(body) {
  const out = {};
  for (const [key, { min, max }] of Object.entries(LIMITS)) {
    const v = Number(body[key]);
    if (!Number.isFinite(v)) return { error: `${key} is required and must be a number` };
    if (v < min || v > max) {
      return { error: `${key} must be between ${min} and ${max} (got ${v})` };
    }
    out[key] = v;
  }
  out.sleep_secs = Math.round(out.sleep_secs);
  return { value: out };
}

// GET /api/sensor-config/:id — desired vs applied, plus recent changes
router.get('/:id', async (req, res) => {
  try {
    const r = await query(
      `SELECT s.id, s.mac, s.name, s.cfg_ver AS applied_cfg_ver,
              s.cfg_desired_ver, s.cfg_sleep_secs, s.cfg_temp_offset,
              s.cfg_temp_gain, s.cfg_updated_at, s.cfg_applied_at,
              d.mac AS hub_mac
         FROM sensors s JOIN devices d ON d.id = s.device_id
        WHERE s.id = $1`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Sensor not found' });

    const events = await query(
      `SELECT cfg_ver, sleep_secs, temp_offset, temp_gain, changed_at, applied_at
         FROM sensor_config_events WHERE sensor_id = $1
        ORDER BY changed_at DESC LIMIT 20`,
      [req.params.id]
    );

    const row = r.rows[0];
    res.json({
      ...row,
      // Pending until the node itself echoes the version back.
      pending: (row.cfg_desired_ver || 0) !== (row.applied_cfg_ver || 0),
      limits: LIMITS,
      history: events.rows,
    });
  } catch (err) {
    console.error('Get sensor config error:', err.message);
    res.status(500).json({ error: 'Failed to load sensor config' });
  }
});

// PUT /api/sensor-config/:id — queue a new configuration
router.put('/:id', async (req, res) => {
  const { error, value } = validate(req.body || {});
  if (error) return res.status(400).json({ error });

  try {
    const r = await query(
      `SELECT s.id, s.mac, s.name, s.cfg_desired_ver, s.cfg_sleep_secs,
              s.cfg_temp_offset, s.cfg_temp_gain, d.mac AS hub_mac
         FROM sensors s JOIN devices d ON d.id = s.device_id
        WHERE s.id = $1 AND s.active = TRUE`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Sensor not found' });
    const s = r.rows[0];

    // Monotonic, so the sensor can tell a new instruction from a replayed one.
    const nextVer = (s.cfg_desired_ver || 0) + 1;

    await query(
      `UPDATE sensors
          SET cfg_desired_ver = $1, cfg_sleep_secs = $2, cfg_temp_offset = $3,
              cfg_temp_gain = $4, cfg_updated_at = NOW(), cfg_applied_at = NULL
        WHERE id = $5`,
      [nextVer, value.sleep_secs, value.temp_offset, value.temp_gain, s.id]
    );

    // Recorded even before it lands: a calibration change shifts every later
    // reading, and a step in the history has to stay explicable months on.
    await query(
      `INSERT INTO sensor_config_events
         (sensor_id, cfg_ver, sleep_secs, temp_offset, temp_gain, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [s.id, nextVer, value.sleep_secs, value.temp_offset, value.temp_gain,
       req.user.sub || null]
    );

    publishSensorConfig(s.hub_mac, {
      sensor_mac:  s.mac,
      cfg_ver:     nextVer,
      sleep_secs:  value.sleep_secs,
      temp_offset: value.temp_offset,
      temp_gain:   value.temp_gain,
    });

    await audit({
      req,
      action: 'sensor.config',
      targetType: 'sensor',
      targetId: s.id,
      details: {
        sensor_mac: s.mac, cfg_ver: nextVer,
        from: { sleep_secs: s.cfg_sleep_secs, temp_offset: s.cfg_temp_offset,
                temp_gain: s.cfg_temp_gain },
        to: value,
      },
    });

    res.json({
      queued: true,
      cfg_ver: nextVer,
      ...value,
      // Delivery waits for the node to wake; the old interval still governs
      // that, since the new one only takes effect once the change lands.
      applies_within_secs: s.cfg_sleep_secs || 900,
    });
  } catch (err) {
    console.error('Set sensor config error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to queue config' });
  }
});

module.exports = router;
