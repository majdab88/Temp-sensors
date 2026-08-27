'use strict';

const mqtt = require('mqtt');
const { query } = require('./db');
const { evaluateReading } = require('./alerts');
const health = require('./health');

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
      'sensors/+/ota/status',        // hub OTA progress
      'sensors/+/config/state',      // sensor config applied / pending
      'sensors/+/sensor-ota/status', // sensor firmware transfer progress
      'sensors/+/live/state',        // hub confirms a live request reached the node
      'sensors/+/pairing/request',
      'sensors/+/pairing/status',   // hub acks pairing mode enable/disable
      'sensors/+/sync/request',
      'sensors/+/sensor/deleted',   // hub notifies cloud after a local-dashboard delete
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
  } else if (parts[2] === 'pairing' && parts[3] === 'status') {
    handlePairingModeStatus(hubMac, data);
  } else if (parts[2] === 'sync' && parts[3] === 'request') {
    await handleSyncRequest(hubMac);
  } else if (parts[2] === 'sensor' && parts[3] === 'deleted') {
    await handleSensorDeleted(hubMac, data);
  } else if (parts[2] === 'ota' && parts[3] === 'status') {
    await handleOtaStatus(hubMac, data);
  } else if (parts[2] === 'config' && parts[3] === 'state') {
    await handleConfigState(hubMac, data);
  } else if (parts[2] === 'sensor-ota' && parts[3] === 'status') {
    await handleSensorOtaStatus(hubMac, data);
  } else if (parts[2] === 'live' && parts[3] === 'state') {
    await handleLiveState(hubMac, data);
  }
}

async function handleSensorData(hubMac, data) {
  const { sensor_mac, temp, hum, battery, rssi, ts, fw, cfg_ver } = data;
  if (!sensor_mac) return;

  // Hub must be registered
  const devRes = await query('SELECT id FROM devices WHERE mac = $1', [hubMac.toUpperCase()]);
  if (devRes.rows.length === 0) return;
  const deviceId = devRes.rows[0].id;

  // Upsert sensor — auto-creates record on first data; preserves custom name.
  // The WHERE clause prevents re-activating a sensor that was soft-deleted
  // (active = FALSE); those data frames are silently dropped so a deleted sensor
  // cannot re-appear via an incoming reading.
  const normMac    = sensor_mac.toUpperCase();
  const defaultName = 'TempSens-' + normMac.replace(/:/g, '').slice(-6);
  const sensorRes = await query(
    `INSERT INTO sensors (device_id, mac, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (device_id, mac) DO UPDATE
       SET active = TRUE
       WHERE sensors.active = TRUE
     RETURNING id, name`,
    [deviceId, normMac, defaultName]
  );
  if (sensorRes.rows.length === 0) return; // sensor was soft-deleted — ignore data
  const sensorId = sensorRes.rows[0].id;
  const sensorName = sensorRes.rows[0].name;

  // -999 on temp means the probe read failed (open, shorted, out of range), not
  // that the value is merely missing. Stored as NULL either way, but the
  // distinction is what lets the dashboard say "probe error" instead of quietly
  // showing a gap that looks like nothing happened.
  const probeError = (temp === -999);
  const tempVal = (temp === -999 || temp == null) ? null : temp;
  const humVal  = (hum  === -999 || hum  == null) ? null : hum;

  // Trust the hub's NTP timestamp as-is. Falls back to server time only if ts
  // is absent or unparseable.
  const hubTime    = (ts && !isNaN(Date.parse(ts))) ? new Date(ts) : null;
  const recordedAt = hubTime ?? new Date();

  await query(
    'INSERT INTO readings (sensor_id, temp, hum, battery, rssi, recorded_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [sensorId, tempVal, humVal, battery ?? null, rssi ?? null, recordedAt]
  );

  // Firmware / config version. A pre-1.0 sensor does not send these, and the
  // hub zero-fills the missing fields — "0.0.0" therefore means "not reported"
  // and is stored as NULL rather than as a real version.
  const fwVal  = (typeof fw === 'string' && fw !== '0.0.0') ? fw : null;
  const cfgVal = Number.isInteger(cfg_ver) ? cfg_ver : 0;

  // Only writes when something actually changed — this runs on every reading.
  query(
    `UPDATE sensors SET probe_error = $1, probe_error_at = CASE WHEN $1 THEN NOW() ELSE probe_error_at END
      WHERE id = $2 AND probe_error IS DISTINCT FROM $1`,
    [probeError, sensorId]
  ).catch((err) => console.error('Probe error update failed:', err.message));

  query(
    `UPDATE sensors SET fw_version = $1, cfg_ver = $2, fw_reported_at = NOW()
      WHERE id = $3
        AND (fw_version IS DISTINCT FROM $1 OR cfg_ver IS DISTINCT FROM $2)`,
    [fwVal, cfgVal, sensorId]
  ).catch((err) => console.error('Version update error:', err.message));

  // Re-send the desired config whenever what the sensor reports does not match
  // what the cloud wants.
  //
  // The config command is published once, to whichever hub the sensor happened
  // to be on at the time. Move a sensor to a different hub -- which requires a
  // factory reset, clearing its stored config -- and the new hub was never told
  // anything, so it never pushes and the change waits forever. The same applies
  // after a hub is reflashed or its NVS is cleared.
  //
  // Reconciling here means the pairing repairs itself from the only fact that is
  // reliable: what the sensor says it is running.
  {
    query(
      `SELECT cfg_desired_ver, cfg_sleep_secs, cfg_sh_a, cfg_sh_b, cfg_sh_c, cfg_r_series
         FROM sensors
        WHERE id = $1
          AND COALESCE(cfg_desired_ver, 0) <> 0
          AND COALESCE(cfg_desired_ver, 0) <> $2
          AND cfg_sleep_secs IS NOT NULL AND cfg_sh_a IS NOT NULL
          AND cfg_sh_b IS NOT NULL AND cfg_sh_c IS NOT NULL
          AND cfg_r_series IS NOT NULL`,
      [sensorId, cfgVal]
    ).then((r) => {
      if (r.rows.length === 0) return;
      const c = r.rows[0];
      publishSensorConfig(hubMac, {
        sensor_mac:  normMac,
        cfg_ver:     c.cfg_desired_ver,
        sleep_secs:  c.cfg_sleep_secs,
        sh_a:        c.cfg_sh_a,
        sh_b:        c.cfg_sh_b,
        sh_c:        c.cfg_sh_c,
        r_series:    c.cfg_r_series,
      });
    }).catch((err) => console.error('Config reconcile error:', err.message));
  }

  _io.to(`hub:${hubMac.toUpperCase()}`).emit('sensorData', {
    sensor_mac: sensor_mac.toUpperCase(),
    temp: tempVal,
    hum: humVal,
    battery: battery ?? null,
    rssi: rssi ?? null,
    probe_error: probeError,
    ts: recordedAt.getTime(),
    fw: fwVal,
    cfg_ver: cfgVal,
  });

  // Evaluate alert rules — fire-and-forget so alerting never blocks or breaks
  // reading ingestion.
  evaluateReading({
    hubMac: hubMac.toUpperCase(),
    sensorMac: normMac,
    sensorName,
    sensorId,
    temp: tempVal,
  }).catch((err) => console.error('Alert eval error:', err.message));

  // Health monitor — last-seen / back-online / low-battery. Fire-and-forget.
  health.onReading({
    sensorId,
    sensorMac: normMac,
    sensorName,
    hubMac: hubMac.toUpperCase(),
    battery: battery ?? null,
    tsMs: recordedAt.getTime(),
    probeError,
  }).catch((err) => console.error('Health eval error:', err.message));
}

function handleHubStatus(hubMac, data) {
  const mac = hubMac.toUpperCase();
  const payload = { hub_mac: mac, ...data };
  hubStatusCache.set(mac, payload);
  _io.to(`hub:${mac}`).emit('hubStatus', payload);
  if (typeof data.online === 'boolean') health.onHubStatus(mac, data.online);

  // Hub firmware version, sent on every MQTT connect. Absent on hubs still
  // running pre-1.0 firmware — leave the stored value untouched in that case
  // rather than overwriting a known version with NULL.
  if (typeof data.fw === 'string' && data.fw) {
    query(
      `UPDATE devices SET fw_version = $1, fw_reported_at = NOW()
        WHERE mac = $2 AND fw_version IS DISTINCT FROM $1`,
      [data.fw, mac]
    ).catch((err) => console.error('Hub version update error:', err.message));
  }
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
 * Hub locally deleted a sensor via its web dashboard and has already removed it
 * from its own NVS/peer table.  Soft-delete the row in the DB so the next
 * sync/request response does NOT include the sensor and the hub won't re-add it.
 */
async function handleSensorDeleted(hubMac, data) {
  const { sensor_mac } = data;
  if (!sensor_mac) return;

  const mac = hubMac.toUpperCase();
  const normSensorMac = sensor_mac.toUpperCase();

  const result = await query(
    `UPDATE sensors SET active = FALSE
     WHERE mac = $1
       AND device_id = (SELECT id FROM devices WHERE mac = $2)
       AND active = TRUE
     RETURNING mac`,
    [normSensorMac, mac]
  );

  if (result.rows.length > 0) {
    console.log(`[MQTT] Hub ${mac} locally deleted sensor ${normSensorMac} — marked inactive in DB`);
  }
}

/**
 * Respond to a hub's sync/request with the authoritative sensor list from the DB.
 * Hub publishes its local list on every MQTT connect; we reply with the DB truth
 * so the hub can add/remove/rename sensors to match.
 */
async function handleSyncRequest(hubMac) {
  if (!client || !client.connected) return;
  const mac = hubMac.toUpperCase();
  const devRes = await query('SELECT id FROM devices WHERE mac = $1', [mac]);
  if (devRes.rows.length === 0) return;
  const deviceId = devRes.rows[0].id;

  // A hub asks to sync on every MQTT connect, which is also the moment it may
  // have forgotten things: a reflash or an NVS erase leaves it holding no
  // pending configuration while the cloud still believes one is in flight.
  // Re-sending here costs one small retained message per unconfigured sensor
  // and removes a whole class of "the change never arrived" states.
  query(
    `SELECT mac, cfg_desired_ver, cfg_sleep_secs, cfg_sh_a, cfg_sh_b, cfg_sh_c, cfg_r_series
       FROM sensors
      WHERE device_id = $1 AND active = TRUE
        AND COALESCE(cfg_desired_ver, 0) <> 0
        AND COALESCE(cfg_desired_ver, 0) <> COALESCE(cfg_ver, 0)
        AND cfg_sleep_secs IS NOT NULL AND cfg_sh_a IS NOT NULL
        AND cfg_sh_b IS NOT NULL AND cfg_sh_c IS NOT NULL
        AND cfg_r_series IS NOT NULL`,
    [deviceId]
  ).then((r) => {
    for (const c of r.rows) {
      publishSensorConfig(mac, {
        sensor_mac:  c.mac,
        cfg_ver:     c.cfg_desired_ver,
        sleep_secs:  c.cfg_sleep_secs,
        sh_a:        c.cfg_sh_a,
        sh_b:        c.cfg_sh_b,
        sh_c:        c.cfg_sh_c,
        r_series:    c.cfg_r_series,
      });
    }
  }).catch((err) => console.error('Config resync error:', err.message));

  const sensorRes = await query(
    'SELECT mac, name FROM sensors WHERE device_id = $1 AND active = TRUE',
    [deviceId]
  );

  const payload = JSON.stringify({ sensors: sensorRes.rows });
  // retain: true so the hub receives the current authoritative list the moment
  // it subscribes — even if it was offline when the delete/rename was triggered.
  client.publish(`sensors/${mac}/sync`, payload, { retain: true });
  console.log(`[Sync] Pushed retained sync to ${mac} with ${sensorRes.rows.length} sensor(s)`);
}

/**
 * Forward hub's pairing mode status to connected dashboard clients.
 */
function handlePairingModeStatus(hubMac, data) {
  const mac = hubMac.toUpperCase();
  _io.to(`hub:${mac}`).emit('pairingModeStatus', {
    hub_mac: mac,
    pairing_mode: !!data.pairing_mode,
  });
}

/**
 * Stage a firmware image on a hub.
 *
 * The hub verifies the SHA-256 and the ECDSA signature on-device before making
 * the new slot bootable, so this command is not a trusted channel — it only
 * tells the hub where to look.
 */
function publishOtaCommand(hubMac, { url, version, sha256, signature }) {
  if (!client || !client.connected) {
    throw new Error('MQTT client not connected');
  }
  const payload = JSON.stringify({ url, version, sha256, sig: signature });
  // Retained, so a hub that is offline right now picks the command up when it
  // reconnects instead of silently missing it. Safe against loops because the
  // hub refuses a command matching its running version — once updated it just
  // answers "uptodate". handleOtaStatus clears the retained message once the
  // update lands, so it does not linger forever.
  client.publish(`sensors/${hubMac.toUpperCase()}/ota/command`, payload, { retain: true });
}

/**
 * Drop the retained OTA command for a hub, so it is not replayed on every
 * future reconnect. An empty retained payload deletes it at the broker.
 */
function clearRetainedOtaCommand(hubMac) {
  if (!client || !client.connected) return;
  client.publish(`sensors/${hubMac.toUpperCase()}/ota/command`, '', { retain: true });
}

/**
 * Record OTA progress reported by a hub and forward it to dashboard clients.
 */
async function handleOtaStatus(hubMac, data) {
  const mac = hubMac.toUpperCase();
  const state = typeof data.state === 'string' ? data.state.slice(0, 16) : null;
  const version = typeof data.version === 'string' ? data.version.slice(0, 16) : null;
  const pct = Number.isInteger(data.pct) ? data.pct : null;
  const error = typeof data.error === 'string' ? data.error : null;

  _io.to(`hub:${mac}`).emit('otaStatus', {
    hub_mac: mac, state, version, pct, error, fw: data.fw ?? null,
  });

  try {
    await query(
      `UPDATE devices
          SET ota_state = $1, ota_version = $2, ota_pct = $3,
              ota_error = $4, ota_updated_at = NOW()
        WHERE mac = $5`,
      [state, version, pct, error, mac]
    );

    // Drop the retained command once it has reached any terminal state.
    //
    // 'failed' matters as much as success here. A command that failed
    // verification will fail identically every time, but retained messages are
    // redelivered on every resubscribe — so leaving it in place made the hub
    // re-download the same rejected image forever, and kept ota_state
    // permanently non-terminal, which disabled its Install button and blocked
    // every subsequent update.
    if (state === 'confirmed' || state === 'uptodate' || state === 'failed') {
      clearRetainedOtaCommand(mac);
    }

    // "confirmed" means the new image booted, reached the cloud, and cancelled
    // its own rollback — the only point at which the update is truly done.
    if (state === 'confirmed' && data.fw) {
      await query(
        `UPDATE devices SET fw_version = $1, fw_reported_at = NOW() WHERE mac = $2`,
        [data.fw, mac]
      );
    }
  } catch (err) {
    console.error('OTA status update error:', err.message);
  }
}

/**
 * Ask a sensor to stay awake and report repeatedly on its next wake.
 *
 * Not retained: this is only useful while someone is watching, and a request
 * that surfaced hours later would drain the node for nobody. If the sensor does
 * not wake within the window, the request is simply dropped.
 */
function publishLiveRequest(hubMac, sensorMac, durationS, intervalS) {
  if (!client || !client.connected) throw new Error('MQTT client not connected');
  client.publish(`sensors/${hubMac.toUpperCase()}/live/request`,
                 JSON.stringify({ sensor_mac: sensorMac.toUpperCase(),
                                  duration_s: durationS, interval_s: intervalS }));
}

/**
 * Stage a firmware image on a sensor, addressed to its hub.
 *
 * Retained, because delivery waits for a button press on the node -- which may
 * be days away. The hub holds it and offers it on every contact until the
 * sensor takes it or reports that it already has that version.
 */
// One retained topic per sensor. Each is staged and installed independently,
// and a shared topic retains only the last thing written to it -- so staging a
// second sensor discarded the first the moment the hub restarted.
const sensorOtaTopic = (hubMac, sensorMac) =>
  `sensors/${hubMac.toUpperCase()}/sensor-ota/command/${String(sensorMac).toUpperCase().replace(/:/g, '')}`;

// Cancel a staged image: an empty retained message both drops it from the
// broker and tells the hub to free the slot holding it.
function clearSensorOtaCommand(hubMac, sensorMac) {
  if (!client || !client.connected) throw new Error('MQTT client not connected');
  client.publish(sensorOtaTopic(hubMac, sensorMac), '', { retain: true });
}

function publishSensorOtaCommand(hubMac, cmd) {
  if (!client || !client.connected) throw new Error('MQTT client not connected');
  client.publish(sensorOtaTopic(hubMac, cmd.sensor_mac),
                 JSON.stringify({ ...cmd, sig: cmd.signature }), { retain: true });
}

/**
 * Record how a sensor firmware transfer is going.
 */
// The hub reports a live request reaching the node. Until it does, the sensor
// is still asleep and the dashboard can only say the request is queued -- which
// is a different thing from the sensor being awake, and the distinction is the
// whole point of the indicator.
async function handleLiveState(hubMac, data) {
  const mac = (data.sensor_mac || '').toUpperCase();
  if (!mac) return;
  const started  = data.state === 'started';
  const duration = Number.isInteger(data.duration_s) ? data.duration_s : 0;
  const interval = Number.isInteger(data.interval_s) ? data.interval_s : null;

  try {
    const r = await query(
      `UPDATE sensors
          SET live_until       = CASE WHEN $1 THEN NOW() + ($2 || ' seconds')::interval
                                      ELSE NULL END,
              live_interval_s  = CASE WHEN $1 THEN $3 ELSE NULL END,
              live_requested_at = NULL
        WHERE mac = $4
        RETURNING id, live_until, live_interval_s`,
      [started, String(duration), interval, mac]
    );
    if (r.rows.length === 0) return;

    _io.to(`hub:${hubMac.toUpperCase()}`).emit('liveState', {
      hub_mac: hubMac.toUpperCase(), sensor_mac: mac,
      state: started ? 'started' : 'stopped',
      live_until: r.rows[0].live_until,
      interval_s: r.rows[0].live_interval_s,
    });
  } catch (err) {
    console.error('Live state error:', err.message);
  }

}

async function handleSensorOtaStatus(hubMac, data) {
  const mac = (data.sensor_mac || '').toUpperCase();
  if (!mac) return;
  const state = typeof data.state === 'string' ? data.state.slice(0, 16) : null;
  const pct   = Number.isInteger(data.pct) ? data.pct : null;
  const error = typeof data.error === 'string' ? data.error : null;

  _io.to(`hub:${hubMac.toUpperCase()}`).emit('sensorOtaStatus', {
    hub_mac: hubMac.toUpperCase(), sensor_mac: mac,
    state, pct, error, version: data.version ?? null,
  });

  try {
    await query(
      `UPDATE sensors SET ota_state = $1, ota_version = $2, ota_pct = $3,
                          ota_error = $4, ota_updated_at = NOW()
        WHERE mac = $5`,
      [state, data.version ?? null, pct, error, mac]
    );
    // The retained command is what survives a hub reboot -- staging otherwise
    // lives only in the hub's RAM, and clearing it too eagerly leaves the
    // dashboard showing an image staged on a hub that no longer has it.
    //
    // So clear it only when retrying is pointless: the image installed, or the
    // node rejected the image itself and would reject it identically next time.
    // A transfer that never finished is not that -- a missed button press, a
    // node that stopped acknowledging, an unreachable image all succeed on a
    // second attempt, which is exactly when the command needs to still be there.
    const PERMANENT = [
      'sha256 mismatch', 'signature invalid', 'not a valid image',
      'image too large', 'no usable partition',
    ];
    const settled =
      state === 'installed' ||
      (state === 'failed'   && PERMANENT.includes(error)) ||
      (state === 'declined' && error === 'already on this version');

    if (settled) {
      client.publish(sensorOtaTopic(hubMac, mac), '', { retain: true });
    }
  } catch (err) {
    console.error('Sensor OTA status error:', err.message);
  }
}

/**
 * Push a sensor's desired configuration to its hub.
 *
 * Retained, like the OTA command: the hub may be offline, and more importantly
 * the change has to survive until the sensor next wakes — which can be a full
 * reporting interval away. The hub clears its own pending flag once the node
 * echoes the new cfg_ver back.
 */
function publishSensorConfig(hubMac, cfg) {
  if (!client || !client.connected) {
    throw new Error('MQTT client not connected');
  }
  client.publish(`sensors/${hubMac.toUpperCase()}/config/set`,
                 JSON.stringify(cfg), { retain: true });
}

/**
 * Record what a sensor is actually running. applied_cfg_ver comes from the node
 * itself, so this is evidence rather than assumption.
 */
async function handleConfigState(hubMac, data) {
  const mac = (data.sensor_mac || '').toUpperCase();
  if (!mac) return;

  const applied = Number.isInteger(data.applied_cfg_ver) ? data.applied_cfg_ver : null;
  const desired = Number.isInteger(data.desired_cfg_ver) ? data.desired_cfg_ver : null;
  const landed  = applied !== null && desired !== null && applied === desired;

  _io.to(`hub:${hubMac.toUpperCase()}`).emit('sensorConfigState', {
    hub_mac: hubMac.toUpperCase(), sensor_mac: mac,
    applied_cfg_ver: applied, desired_cfg_ver: desired,
    pending: !!data.pending, sleep_secs: data.sleep_secs ?? null,
    sh_a: data.sh_a ?? null, sh_b: data.sh_b ?? null,
    sh_c: data.sh_c ?? null, r_series: data.r_series ?? null,
  });

  try {
    if (landed) {
      const r = await query(
        `UPDATE sensors SET cfg_applied_at = NOW()
          WHERE mac = $1 AND (cfg_applied_at IS NULL OR cfg_ver IS DISTINCT FROM $2)
        RETURNING id`,
        [mac, applied]
      );
      if (r.rows.length > 0) {
        await query(
          `UPDATE sensor_config_events SET applied_at = NOW()
            WHERE sensor_id = $1 AND cfg_ver = $2 AND applied_at IS NULL`,
          [r.rows[0].id, applied]
        );
      }
      // Config has landed; stop replaying it to the hub on every reconnect.
      client.publish(`sensors/${hubMac.toUpperCase()}/config/set`, '', { retain: true });
    }
  } catch (err) {
    console.error('Config state update error:', err.message);
  }
}

/**
 * Tell a hub to enable or disable pairing mode.
 * Called by the pairing route handler.
 */
function publishPairingEnable(hubMac, enable) {
  if (!client || !client.connected) {
    throw new Error('MQTT client not connected');
  }
  const payload = JSON.stringify({ enable });
  client.publish(`sensors/${hubMac}/pairing/enable`, payload);
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

/**
 * Tell a hub to remove a sensor from its local memory, peer table, and NVS.
 * Called by the sensors DELETE route after the DB row is removed.
 * Fire-and-forget — if the hub is offline it will receive the sync on next connect.
 */
function publishSensorRemove(hubMac, sensorMac) {
  if (!client || !client.connected) {
    console.warn(`[MQTT] publishSensorRemove: client not connected — ${sensorMac} will be removed from hub ${hubMac} on next sync/request`);
    return;
  }
  const payload = JSON.stringify({ sensor_mac: sensorMac });
  client.publish(`sensors/${hubMac}/sensor/remove`, payload);
  console.log(`[MQTT] Sent sensor/remove for ${sensorMac} to hub ${hubMac}`);
}

module.exports = { clearSensorOtaCommand, initMqtt, publishPairingResponse, publishPairingEnable, publishSensorRemove, getHubStatus, publishOtaCommand, publishSensorConfig, publishSensorOtaCommand, publishLiveRequest, pushSyncToHub: handleSyncRequest };
