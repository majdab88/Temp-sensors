'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/provision/config
// Returns the MQTT broker address the ESP32 hub should connect to.
// Uses MQTT_HUB_URL (the external TLS URL, e.g. mqtts://yourdomain.com:8883)
// which is distinct from MQTT_URL (the internal Docker-network URL used by the backend).
router.get('/config', (_req, res) => {
  const raw = process.env.MQTT_HUB_URL || '';
  let mqttHost = '';
  let mqttPort = 8883;

  try {
    const url = new URL(raw);
    mqttHost = url.hostname;
    mqttPort = url.port
      ? parseInt(url.port, 10)
      : (url.protocol === 'mqtts:' ? 8883 : 1883);
  } catch {
    // MQTT_HUB_URL not set or malformed — UI will show a warning
  }

  res.json({
    mqttHost,
    mqttPort,
    // Shared MQTT credentials for hub devices.
    // All hubs use the same user/pass; the hub MAC in the topic path identifies each device.
    mqttUser: process.env.MQTT_HUB_USER || '',
    mqttPass: process.env.MQTT_HUB_PASS || '',
  });
});

module.exports = router;
