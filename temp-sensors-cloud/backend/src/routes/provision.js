'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/provision/config
// Returns MQTT broker connection details for BLE provisioning.
// The hub MAC is used as the MQTT username and the api_key returned by
// POST /api/devices/register is used as the password (per-device credentials).
router.get('/config', (_req, res) => {
  const raw = process.env.MQTT_URL || '';
  let mqttHost = '';
  let mqttPort = 8883;

  try {
    const url = new URL(raw);
    mqttHost = url.hostname;
    mqttPort = url.port
      ? parseInt(url.port, 10)
      : (url.protocol === 'mqtts:' ? 8883 : 1883);
  } catch {
    // MQTT_URL not set or malformed — return empty strings so the UI can warn
  }

  res.json({ mqttHost, mqttPort });
});

module.exports = router;
