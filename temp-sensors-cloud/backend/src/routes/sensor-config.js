'use strict';

const express = require('express');
const crypto  = require('crypto');
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
// Deliberately loose on A/B/C. The deployed fit is a restricted cold-range one
// (A=2.535e-3, B=3.01e-5, C=7.23e-7) and looks nothing like textbook values, so
// a tight window would reject a legitimate recalibration. The sensor performs
// the real check: it verifies the coefficients actually produce a falling NTC
// curve across the deployment range before accepting them.
const LIMITS = {
  sleep_secs: { min: 300,   max: 3600  },
  // Magnitude only. Textbook sign conventions do not hold for restricted-range
  // fits: a real cold-range fit measured on this hardware has a negative B
  // (A=5.678e-3, B=-4.038e-4, C=1.919e-6) and a positive-only bound rejected it.
  // The sensor's falling-curve check is what actually validates a fit.
  sh_a:       { min: -1e-1, max: 1e-1 },
  sh_b:       { min: -1e-1, max: 1e-1 },
  sh_c:       { min: -1e-1, max: 1e-1 },
  // Wide on purpose: the divider resistor is a design choice, and raising it is
  // how a low-side board buys back cold headroom before the ADC saturates.
  r_series:   { min: 1000,  max: 1000000 },
};

// cfg_ver is a fingerprint of the values, not a counter.
//
// The sensor has to echo *something* back for "did this land?" to be answerable
// by evidence rather than assumption — but that something may as well be derived
// from the settings themselves. Two useful properties fall out: re-sending an
// identical config is naturally a no-op, and reverting to an earlier one is just
// another value change rather than a version that has to move forwards.
//
// 0 is reserved to mean "no config has ever been applied", so it is never used
// as a fingerprint.
function fingerprint(v) {
  const canonical = [v.sleep_secs, v.sh_a, v.sh_b, v.sh_c, v.r_series].join('|');
  const fp = crypto.createHash('sha256').update(canonical).digest().readUInt16BE(0);
  return fp === 0 ? 1 : fp;
}

function sameValues(a, b) {
  return Number(a.cfg_sleep_secs) === b.sleep_secs &&
         Number(a.cfg_sh_a)       === b.sh_a &&
         Number(a.cfg_sh_b)       === b.sh_b &&
         Number(a.cfg_sh_c)       === b.sh_c &&
         Number(a.cfg_r_series)   === b.r_series;
}

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
              s.cfg_desired_ver, s.cfg_sleep_secs, s.cfg_sh_a, s.cfg_sh_b,
              s.cfg_sh_c, s.cfg_r_series, s.cfg_updated_at, s.cfg_applied_at,
              d.mac AS hub_mac
         FROM sensors s JOIN devices d ON d.id = s.device_id
        WHERE s.id = $1`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Sensor not found' });

    const events = await query(
      `SELECT cfg_ver, sleep_secs, sh_a, sh_b, sh_c, r_series, changed_at, applied_at
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
              s.cfg_sh_a, s.cfg_sh_b, s.cfg_sh_c, s.cfg_r_series, d.mac AS hub_mac
         FROM sensors s JOIN devices d ON d.id = s.device_id
        WHERE s.id = $1 AND s.active = TRUE`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Sensor not found' });
    const s = r.rows[0];

    if (sameValues(s, value)) {
      return res.json({ queued: false, unchanged: true, cfg_ver: s.cfg_desired_ver });
    }

    let nextVer = fingerprint(value);
    // A 16-bit fingerprint can in principle collide with the version already
    // applied, which would make a real change look like it had already landed.
    // Nudging past it costs nothing and removes the failure entirely.
    if (nextVer === (s.cfg_desired_ver || 0)) nextVer = (nextVer % 65535) + 1;

    await query(
      `UPDATE sensors
          SET cfg_desired_ver = $1, cfg_sleep_secs = $2, cfg_sh_a = $3,
              cfg_sh_b = $4, cfg_sh_c = $5, cfg_r_series = $6,
              cfg_updated_at = NOW(), cfg_applied_at = NULL
        WHERE id = $7`,
      [nextVer, value.sleep_secs, value.sh_a, value.sh_b, value.sh_c,
       value.r_series, s.id]
    );

    // Recorded even before it lands: a calibration change shifts every later
    // reading, and a step in the history has to stay explicable months on.
    await query(
      `INSERT INTO sensor_config_events
         (sensor_id, cfg_ver, sleep_secs, sh_a, sh_b, sh_c, r_series, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [s.id, nextVer, value.sleep_secs, value.sh_a, value.sh_b, value.sh_c,
       value.r_series, req.user.sub || null]
    );

    publishSensorConfig(s.hub_mac, {
      sensor_mac: s.mac,
      cfg_ver:    nextVer,
      sleep_secs: value.sleep_secs,
      sh_a:       value.sh_a,
      sh_b:       value.sh_b,
      sh_c:       value.sh_c,
      r_series:   value.r_series,
    });

    await audit({
      req,
      action: 'sensor.config',
      targetType: 'sensor',
      targetId: s.id,
      details: {
        sensor_mac: s.mac, cfg_ver: nextVer,
        from: { sleep_secs: s.cfg_sleep_secs, sh_a: s.cfg_sh_a, sh_b: s.cfg_sh_b,
                sh_c: s.cfg_sh_c, r_series: s.cfg_r_series },
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
