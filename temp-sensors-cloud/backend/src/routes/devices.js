'use strict';

const express = require('express');
const crypto  = require('crypto');
const { query } = require('../db');
const { requireAuth, requireSuperadmin, isSuperadminUnscoped } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { audit } = require('../audit');
const { getHubStatus } = require('../mqtt');

const router = express.Router();
router.use(requireAuth);

const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;

// GET /api/devices — list registered hubs (scoped by org)
router.get('/', async (req, res) => {
  try {
    let result;
    if (isSuperadminUnscoped(req)) {
      result = await query(
        `SELECT d.id, d.mac, d.name, d.org_id, d.registered_at,
                o.name AS org_name
         FROM devices d
         LEFT JOIN organizations o ON o.id = d.org_id
         ORDER BY d.registered_at DESC`
      );
    } else if (req.orgId) {
      result = await query(
        `SELECT id, mac, name, org_id, registered_at
         FROM devices WHERE org_id = $1
         ORDER BY registered_at DESC`,
        [req.orgId]
      );
    } else {
      result = { rows: [] };
    }
    // Enrich each device with cached online status from MQTT
    const rows = result.rows.map((d) => {
      const status = getHubStatus(d.mac);
      return { ...d, online: !!(status && status.online), ip: status?.ip ?? null };
    });
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/devices/register — register (or re-provision) a hub
// Called by the mobile app during BLE provisioning.
// Returns the generated api_key that the app pushes to the hub via BLE (PROV_CLOUD).
router.post('/register', async (req, res) => {
  const { mac, name } = req.body || {};

  if (!mac || !MAC_RE.test(mac)) {
    return res.status(400).json({ error: 'Valid MAC address required (format AA:BB:CC:DD:EE:FF)' });
  }

  const normMac = mac.toUpperCase();
  const apiKey  = crypto.randomBytes(32).toString('hex'); // 64-char hex string
  const orgId   = req.orgId || null;

  try {
    // On re-provisioning (hub BOOT-reset), update api_key so old credentials are invalidated.
    // Only set org_id on new devices or if previously unowned.
    const result = await query(
      `INSERT INTO devices (mac, name, api_key, org_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (mac) DO UPDATE
         SET name    = COALESCE(EXCLUDED.name, devices.name),
             api_key = EXCLUDED.api_key,
             org_id  = COALESCE(devices.org_id, EXCLUDED.org_id)
       RETURNING id, mac, name, api_key, org_id, registered_at`,
      [normMac, name || null, apiKey, orgId]
    );
    await audit({ req, action: 'device.register', targetType: 'device', targetId: result.rows[0].id, details: { mac: normMac } });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/devices/:id — rename a device
router.put('/:id', requirePermission('editor'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid device id' });
  }
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  // Ownership check for non-superadmin
  if (!isSuperadminUnscoped(req) && req.orgId) {
    const check = await query(
      'SELECT 1 FROM devices WHERE id = $1 AND org_id = $2',
      [id, req.orgId]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Device not found' });
  }

  try {
    const result = await query(
      'UPDATE devices SET name = $1 WHERE id = $2 RETURNING id, mac, name',
      [name.trim().slice(0, 64), id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Device not found' });
    await audit({ req, action: 'device.rename', targetType: 'device', targetId: id, details: { name: name.trim() } });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/devices/:id/assign — superadmin assigns a device to an org
router.put('/:id/assign', requireSuperadmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid device id' });
  }
  const { org_id } = req.body || {};

  try {
    const result = await query(
      'UPDATE devices SET org_id = $1 WHERE id = $2 RETURNING id, mac, name, org_id',
      [org_id || null, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Device not found' });
    await audit({ req, action: 'device.assign', targetType: 'device', targetId: id, details: { org_id: org_id || null } });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
