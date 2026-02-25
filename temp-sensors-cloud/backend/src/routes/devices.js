'use strict';

const express = require('express');
const crypto  = require('crypto');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;

// GET /api/devices — list all registered hubs
router.get('/', async (_req, res) => {
  try {
    const result = await query(
      'SELECT id, mac, name, registered_at FROM devices ORDER BY registered_at DESC'
    );
    res.json(result.rows);
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

  try {
    // On re-provisioning (hub BOOT-reset), update api_key so old credentials are invalidated.
    const result = await query(
      `INSERT INTO devices (mac, name, api_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (mac) DO UPDATE
         SET name    = COALESCE(EXCLUDED.name, devices.name),
             api_key = EXCLUDED.api_key
       RETURNING id, mac, name, api_key, registered_at`,
      [normMac, name || null, apiKey]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
