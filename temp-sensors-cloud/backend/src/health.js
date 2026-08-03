'use strict';

// Device health monitor: pushes notifications when a sensor's battery runs low
// or when a sensor / hub goes offline (and when they recover). The dashboards
// derive the same state from live data for display; this module exists so users
// are alerted even with no dashboard open.
//
// Thresholds are per-org (health_settings table), editable on the Alerts page;
// an org with no row uses DEFAULTS. Battery level is a % the sensor derives from
// the L91 pack voltage: Low < 22 % (~2.5 V), recover >= 30 % (~2.65 V).

const { query } = require('./db');
const { sendPush } = require('./notify/push');
const { pushTokensForSensor, pushTokensForHub } = require('./notify/recipients');

const BATTERY_LOW_PCT = 22;
const BATTERY_OK_PCT  = 30;
const CHECK_INTERVAL_MS   = 60 * 1000;
const SETTINGS_REFRESH_MS = 5 * 60 * 1000;

const DEFAULTS = {
  sensor_offline_enabled: true,
  sensor_offline_minutes: 45,
  hub_offline_enabled: true,
  hub_offline_minutes: 10,
  low_battery_enabled: true,
};

let _io;

// mac -> { sensorId, name, hubMac, lastSeenMs, offline, batteryLow }
const sensorState = new Map();
// hubMac -> { name, online, offlineSinceMs, notifiedOffline }
const hubState = new Map();
// orgId -> settings row
let settingsCache = new Map();
// hubMac(upper) -> orgId
let hubOrg = new Map();

function initHealth(io) {
  _io = io;
}

// ── Per-org settings ───────────────────────────────────────────────────────
function settingsForOrg(orgId) {
  return (orgId != null && settingsCache.get(orgId)) || DEFAULTS;
}
function settingsForHub(hubMac) {
  return settingsForOrg(hubMac ? hubOrg.get(hubMac.toUpperCase()) : null);
}

// Reload settings + the hub→org map. Called at boot, on a timer, and by the
// settings route after a save so changes take effect immediately.
async function reloadSettings() {
  try {
    const s = await query('SELECT * FROM health_settings');
    const next = new Map();
    for (const r of s.rows) next.set(r.org_id, r);
    settingsCache = next;

    const d = await query('SELECT mac, org_id FROM devices');
    const nextOrg = new Map();
    for (const r of d.rows) nextOrg.set(r.mac.toUpperCase(), r.org_id);
    hubOrg = nextOrg;
  } catch (err) {
    console.error('[health] settings load error:', err.message);
  }
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

  const cfg = settingsForHub(hubMac);

  if (st.offline) {
    st.offline = false;
    if (cfg.sensor_offline_enabled) {
      await notifySensor(st, 'online', '✅ Sensor back online', `${st.name} is reporting again`);
    }
  }

  if (cfg.low_battery_enabled && battery != null && battery !== 255) {
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
    if (hst.notifiedOffline && settingsForHub(mac).hub_offline_enabled) {
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
    const cfg = settingsForHub(st.hubMac);
    if (!cfg.sensor_offline_enabled) continue;
    const thresholdMs = cfg.sensor_offline_minutes * 60 * 1000;
    if (!st.offline && st.lastSeenMs && now - st.lastSeenMs > thresholdMs) {
      st.offline = true;
      notifySensor(st, 'offline', '⚠️ Sensor offline', `${st.name} hasn't reported in over ${cfg.sensor_offline_minutes} min`);
    }
  }

  for (const [mac, hst] of hubState.entries()) {
    const cfg = settingsForOrg(hubOrg.get(mac));
    if (!cfg.hub_offline_enabled) continue;
    const graceMs = cfg.hub_offline_minutes * 60 * 1000;
    if (!hst.online && !hst.notifiedOffline && hst.offlineSinceMs && now - hst.offlineSinceMs > graceMs) {
      hst.notifiedOffline = true;
      notifyHub(hst, mac, 'offline', '⚠️ Hub offline', `${hst.name} has been offline for over ${cfg.hub_offline_minutes} min`);
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
      const cfg = settingsForHub(row.hub_mac);
      const thresholdMs = cfg.sensor_offline_minutes * 60 * 1000;
      sensorState.set(row.mac.toUpperCase(), {
        sensorId: row.id,
        mac: row.mac.toUpperCase(),
        name: row.name,
        hubMac: row.hub_mac,
        lastSeenMs: lastMs,
        offline: lastMs ? now - lastMs > thresholdMs : true,
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
  reloadSettings()
    .then(seedHealth)
    .finally(() => {
      setInterval(checkOffline, CHECK_INTERVAL_MS);
      setInterval(reloadSettings, SETTINGS_REFRESH_MS);
    });
}

module.exports = { startHealthMonitor, onReading, onHubStatus, initHealth, checkOffline, reloadSettings };
