'use strict';

const mqtt = require('mqtt');
const { query } = require('./db');

let client;
let _io;

// In-memory cache of the last known status for each hub.
// Keyed by uppercase MAC. Used to replay status to clients that join after
// the broker's retained message has already been processed.
const hubStatusCache = new Map();

/**
 * Connect to the MQTT broker and subscribe to all sensor topics.
 * @param {import('socket.io').Server} io
 */
function initMqtt(io) {
  _io = io;

  client = mqtt.connect(process.env.MQTT_URL, {
    username: process.env.MQTT_BACKEND_USER,
    password: process.env.MQTT_BACKEND_PASS,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  });

  client.on('connect', () => {
    console.log('MQTT connected to', process.env.MQTT_URL);
    client.subscribe([
      'sensors/+/data',
      'sensors/+/status',
      'sensors/+/pairing/request',
    ], (err) => {
      if (err) console.error('MQTT subscribe error:', err.message);
    });
  });

  client.on('reconnect', () => console.log('MQTT reconnecting...'));
  client.on('error', (err) => console.error('MQTT error:', err.message));

  client.on('message', (topic, payload) => {
    handleMessage(topic, payload.toString()).catch((err) => {
      console.error(`MQTT handler error [${topic}]:`, err.message);
    });
  });
}

async function handleMessage(topic, payload) {
  const parts = topic.split('/');
  // Expected forms:
  //   sensors/{hub_mac}/data
  //   sensors/{hub_mac}/status
  //   sensors/{hub_mac}/pairing/request
  if (parts[0] !== 'sensors' || parts.length < 3) return;

  const hubMac = parts[1];

  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    console.warn(`Invalid JSON on topic ${topic}`);
    return;
  }

  if (parts[2] === 'data') {
    await handleSensorData(hubMac, data);
  } else if (parts[2] === 'status') {
    handleHubStatus(hubMac, data);
  } else if (parts[2] === 'pairing' && parts[3] === 'request') {
    await handlePairingRequest(hubMac, data);
  }
}

async function handleSensorData(hubMac, data) {
  const { sensor_mac, temp, hum, battery, rssi } = data;
  if (!sensor_mac) return;

  // Hub must be registered
  const devRes = await query('SELECT id FROM devices WHERE mac = $1', [hubMac.toUpperCase()]);
  if (devRes.rows.length === 0) return;
  const deviceId = devRes.rows[0].id;

  // Upsert sensor — auto-creates record on first data; preserves custom name
  const normMac    = sensor_mac.toUpperCase();
  const defaultName = 'TempSens-' + normMac.replace(/:/g, '').slice(-6);
  const sensorRes = await query(
    `INSERT INTO sensors (device_id, mac, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (device_id, mac) DO UPDATE SET active = TRUE
     RETURNING id`,
    [deviceId, normMac, defaultName]
  );
  const sensorId = sensorRes.rows[0].id;

  // Convert -999 sentinel values to NULL
  const tempVal = (temp === -999 || temp == null) ? null : temp;
  const humVal  = (hum  === -999 || hum  == null) ? null : hum;

  await query(
    'INSERT INTO readings (sensor_id, temp, hum, battery, rssi) VALUES ($1, $2, $3, $4, $5)',
    [sensorId, tempVal, humVal, battery ?? null, rssi ?? null]
  );

  _io.to(`hub:${hubMac.toUpperCase()}`).emit('sensorData', {
    sensor_mac: sensor_mac.toUpperCase(),
    temp: tempVal,
    hum: humVal,
    battery: battery ?? null,
    rssi: rssi ?? null,
    ts: Date.now(),
  });
}

function handleHubStatus(hubMac, data) {
  const mac = hubMac.toUpperCase();
  const payload = { hub_mac: mac, ...data };
  hubStatusCache.set(mac, payload);
  _io.to(`hub:${mac}`).emit('hubStatus', payload);
}

function getHubStatus(mac) {
  return hubStatusCache.get(mac.toUpperCase()) ?? null;
}

async function handlePairingRequest(hubMac, data) {
  const { sensor_mac } = data;
  if (!sensor_mac) return;

  const devRes = await query('SELECT id FROM devices WHERE mac = $1', [hubMac.toUpperCase()]);
  if (devRes.rows.length === 0) return;
  const deviceId = devRes.rows[0].id;

  // Ignore if there is already a pending request for this sensor
  const existing = await query(
    `SELECT id FROM pairing_requests
     WHERE device_id = $1 AND slave_mac = $2 AND status = 'pending'`,
    [deviceId, sensor_mac.toUpperCase()]
  );
  if (existing.rows.length > 0) return;

  const result = await query(
    'INSERT INTO pairing_requests (device_id, slave_mac) VALUES ($1, $2) RETURNING id',
    [deviceId, sensor_mac.toUpperCase()]
  );

  _io.to(`hub:${hubMac.toUpperCase()}`).emit('pairingRequest', {
    id: result.rows[0].id,
    hub_mac: hubMac.toUpperCase(),
    sensor_mac: sensor_mac.toUpperCase(),
    ts: Date.now(),
  });
}

/**
 * Publish a pairing approve/reject decision back to the hub.
 * Called by the pairing route handler.
 */
function publishPairingResponse(hubMac, sensorMac, approved) {
  if (!client || !client.connected) {
    throw new Error('MQTT client not connected');
  }
  const payload = JSON.stringify({ sensor_mac: sensorMac, approved });
  client.publish(`sensors/${hubMac}/pairing/response`, payload);
}

module.exports = { initMqtt, publishPairingResponse, getHubStatus };
