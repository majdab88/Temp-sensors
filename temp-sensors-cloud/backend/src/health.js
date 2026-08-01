'use strict';

// Device health monitor: pushes notifications when a sensor's battery runs low
// or when a sensor / hub goes offline (and when they recover). The dashboards
// derive the same state from live data for display; this module exists so users
// are alerted even with no dashboard open.
//
// Battery thresholds are in % (the sensor derives % from the L91 pack voltage):
//   Low  < 22 %  (~2.5 V pack)   OK (recover) >= 30 %  (~2.65 V, hysteresis)

const { query } = require('./db');
const { sendPush } = require('./notify/push');
const { pushTokensForSensor, pushTokensForHub } = require('./notify/recipients');

const SENSOR_OFFLINE_MS   = 45 * 60 * 1000;  // 3 missed 15-min wake cycles
const HUB_OFFLINE_GRACE_MS = 10 * 60 * 1000; // ignore brief hub restarts
const BATTERY_LOW_PCT = 22;
const BATTERY_OK_PCT  = 30;
const CHECK_INTERVAL_MS = 60 * 1000;

let _io;

// mac -> { sensorId, name, hubMac, lastSeenMs, offline, batteryLow }
const sensorState = new Map();
// hubMac -> { name, online, offlineSinceMs, notifiedOffline }
const hubState = new Map();

function initHealth(io) {
  _io = io;
}

// ── Notification dispatch ──────────────────────────────────────────────────
async function pushTo(getTokens, id, title, body, data) {
  try {
    const tokens = await getTokens(id);
    if (tokens.length) await sendPush(tokens, { title, body, data });
  } catch (err) {
    console.error('[health] push error:', err.message);
  }
}

function emitHealth(hubMac, payload) {
  if (_io && hubMac) _io.to(`hub:${hubMac.toUpperCase()}`).emit('health', { ...payload, ts: Date.now() });
}

async function notifySensor(st, kind, title, body) {
  emitHealth(st.hubMac, { scope: 'sensor', mac: st.mac, name: st.name, kind, message: body });
  await pushTo(pushTokensForSensor, st.sensorId, title, body, { scope: 'sensor', mac: st.mac, kind });
}

async function notifyHub(hst, mac, kind, title, body) {
  emitHealth(mac, { scope: 'hub', mac, name: hst.name, kind, message: body });
  await pushTo(pushTokensForHub, mac, title, body, { scope: 'hub', mac, kind });
}

// ── Live hooks (called from the MQTT bridge) ───────────────────────────────

// A reading arrived. Update last-seen, clear an offline flag (back online),
// and check the battery level.
async function onReading({ sensorId, sensorMac, sensorName, hubMac, battery, tsMs }) {
  const mac = sensorMac.toUpperCase();
  let st = sensorState.get(mac);
  if (!st) {
    st = { sensorId, mac, name: sensorName, hubMac, lastSeenMs: 0, offline: false, batteryLow: false };
    sensorState.set(mac, st);
  }
  st.sensorId = sensorId;
  st.name = sensorName;
  st.hubMac = hubMac;
  st.lastSeenMs = tsMs || Date.now();

  if (st.offline) {
    st.offline = false;
    await notifySensor(st, 'online', '✅ Sensor back online', `${st.name} is reporting again`);
  }

  if (battery != null && battery !== 255) {
    if (!st.batteryLow && battery < BATTERY_LOW_PCT) {
      st.batteryLow = true;
      await notifySensor(st, 'battery_low', '🔋 Low battery', `${st.name} battery is running low — replace soon`);
    } else if (st.batteryLow && battery >= BATTERY_OK_PCT) {
      st.batteryLow = false;
      await notifySensor(st, 'battery_ok', '🔋 Battery OK', `${st.name} battery was replaced`);
    }
  }
}

// Hub status from MQTT (online:true on connect, online:false via last-will).
function onHubStatus(hubMac, online) {
  const mac = hubMac.toUpperCase();
  let hst = hubState.get(mac);
  if (!hst) { hst = { name: mac, online: true, offlineSinceMs: null, notifiedOffline: false }; hubState.set(mac, hst); }

  if (online) {
    if (hst.notifiedOffline) {
      notifyHub(hst, mac, 'online', '✅ Hub back online', `${hst.name} reconnected`);
    }
    hst.online = true;
    hst.offlineSinceMs = null;
    hst.notifiedOffline = false;
  } else if (hst.online) {
    // Just dropped — start the grace timer; the interval fires the alert.
    hst.online = false;
    hst.offlineSinceMs = Date.now();
  }
}

// ── Periodic monitor ────────────────────────────────────────────────────────
function checkOffline() {
  const now = Date.now();

  for (const st of sensorState.values()) {
    if (!st.offline && st.lastSeenMs && now - st.lastSeenMs > SENSOR_OFFLINE_MS) {
      st.offline = true;
      notifySensor(st, 'offline', '⚠️ Sensor offline', `${st.name} hasn't reported in over 45 min`);
    }
  }

  for (const [mac, hst] of hubState.entries()) {
    if (!hst.online && !hst.notifiedOffline && hst.offlineSinceMs &&
        now - hst.offlineSinceMs > HUB_OFFLINE_GRACE_MS) {
      hst.notifiedOffline = true;
      notifyHub(hst, mac, 'offline', '⚠️ Hub offline', `${hst.name} has been offline for over 10 min`);
    }
  }
}

// Seed last-seen (and hub names) from the DB so offline detection survives a
// restart without blasting alerts for devices that were already offline.
async function seedHealth() {
  try {
    const sensors = await query(
      `SELECT s.id, s.mac, s.name, d.mac AS hub_mac,
              EXTRACT(EPOCH FROM MAX(r.recorded_at)) * 1000 AS last_ms
       FROM sensors s
       JOIN devices d ON d.id = s.device_id
       LEFT JOIN readings r ON r.sensor_id = s.id
       WHERE s.active = TRUE
       GROUP BY s.id, s.mac, s.name, d.mac`
    );
    const now = Date.now();
    for (const row of sensors.rows) {
      const lastMs = row.last_ms ? Number(row.last_ms) : 0;
      sensorState.set(row.mac.toUpperCase(), {
        sensorId: row.id,
        mac: row.mac.toUpperCase(),
        name: row.name,
        hubMac: row.hub_mac,
        lastSeenMs: lastMs,
        offline: lastMs ? now - lastMs > SENSOR_OFFLINE_MS : true,
        batteryLow: false,
      });
    }

    const hubs = await query('SELECT mac, name FROM devices');
    for (const row of hubs.rows) {
      const mac = row.mac.toUpperCase();
      if (!hubState.has(mac)) {
        hubState.set(mac, { name: row.name || mac, online: true, offlineSinceMs: null, notifiedOffline: false });
      } else {
        hubState.get(mac).name = row.name || mac;
      }
    }
    console.log(`[health] seeded ${sensorState.size} sensors, ${hubState.size} hubs`);
  } catch (err) {
    console.error('[health] seed error:', err.message);
  }
}

function startHealthMonitor(io) {
  initHealth(io);
  seedHealth().finally(() => {
    setInterval(checkOffline, CHECK_INTERVAL_MS);
  });
}

module.exports = { startHealthMonitor, onReading, onHubStatus, initHealth, checkOffline };
