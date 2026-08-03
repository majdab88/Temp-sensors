'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth, isSuperadminUnscoped } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { reloadSettings } = require('../health');
const { audit } = require('../audit');

const router = express.Router();
router.use(requireAuth);

const DEFAULTS = {
  sensor_offline_enabled: true,
  sensor_offline_minutes: 45,
  hub_offline_enabled: true,
  hub_offline_minutes: 10,
  low_battery_enabled: true,
};

// GET /api/health/settings — the caller's org health-alert settings (or defaults)
router.get('/settings', async (req, res) => {
  if (isSuperadminUnscoped(req) || !req.orgId) {
    return res.json({ ...DEFAULTS, org_id: null });
  }
  try {
    const r = await query('SELECT * FROM health_settings WHERE org_id = $1', [req.orgId]);
    res.json(r.rows[0] || { ...DEFAULTS, org_id: req.orgId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/health/settings — update the org's health-alert settings
router.put('/settings', requirePermission('editor'), async (req, res) => {
  if (!req.orgId) return res.status(400).json({ error: 'No organization context' });
  const b = req.body || {};

  const sMin = parseInt(b.sensor_offline_minutes, 10);
  const hMin = parseInt(b.hub_offline_minutes, 10);
  if (!Number.isInteger(sMin) || sMin < 5 || sMin > 1440) {
    return res.status(400).json({ error: 'sensor_offline_minutes must be between 5 and 1440' });
  }
  if (!Number.isInteger(hMin) || hMin < 1 || hMin > 1440) {
    return res.status(400).json({ error: 'hub_offline_minutes must be between 1 and 1440' });
  }

  try {
    const r = await query(
      `INSERT INTO health_settings
         (org_id, sensor_offline_enabled, sensor_offline_minutes, hub_offline_enabled, hub_offline_minutes, low_battery_enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id) DO UPDATE SET
         sensor_offline_enabled = EXCLUDED.sensor_offline_enabled,
         sensor_offline_minutes = EXCLUDED.sensor_offline_minutes,
         hub_offline_enabled    = EXCLUDED.hub_offline_enabled,
         hub_offline_minutes    = EXCLUDED.hub_offline_minutes,
         low_battery_enabled    = EXCLUDED.low_battery_enabled,
         updated_at             = NOW()
       RETURNING *`,
      [req.orgId, !!b.sensor_offline_enabled, sMin, !!b.hub_offline_enabled, hMin, !!b.low_battery_enabled]
    );
    await reloadSettings(); // apply immediately
    await audit({ req, action: 'health.settings.set', targetType: 'org', targetId: req.orgId });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
