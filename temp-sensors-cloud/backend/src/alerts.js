'use strict';

const { query } = require('./db');
const { sendPush } = require('./notify/push');

// Channels the schema/UI knows about. Only 'dashboard' is delivered in phase 1;
// 'push' and 'whatsapp' are wired in later phases. Rules may already request them
// — the dispatcher silently skips channels it can't deliver yet.
const KNOWN_CHANNELS = ['dashboard', 'push', 'whatsapp'];

let _io;

// sensorId -> { breached: bool, kind: 'high'|'low'|null, lastNotifyMs: number }
const alertState = new Map();

// sensorId -> { value: rule|null, ts: number } — short-lived rule cache
const ruleCache = new Map();
const RULE_TTL = 60_000;

/**
 * @param {import('socket.io').Server} io
 */
function initAlerts(io) {
  _io = io;
}

async function getRule(sensorId) {
  const cached = ruleCache.get(sensorId);
  if (cached && Date.now() - cached.ts < RULE_TTL) return cached.value;
  const res = await query(
    'SELECT * FROM alert_rules WHERE sensor_id = $1 AND enabled = TRUE',
    [sensorId]
  );
  const value = res.rows[0] || null;
  ruleCache.set(sensorId, { value, ts: Date.now() });
  return value;
}

/**
 * Seed (once per sensor per process) the in-memory alert state from the last
 * recorded event, so a backend restart doesn't re-fire an already-open breach.
 */
async function getState(sensorId) {
  const existing = alertState.get(sensorId);
  if (existing) return existing;

  const res = await query(
    'SELECT kind FROM alert_events WHERE sensor_id = $1 ORDER BY created_at DESC LIMIT 1',
    [sensorId]
  );
  const last = res.rows[0];
  const breached = !!(last && last.kind !== 'recovered');

  // Re-attach to the open excursion so a restart keeps tracking the same episode.
  let excursionId = null;
  if (breached) {
    const ex = await query(
      'SELECT id FROM excursions WHERE sensor_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
      [sensorId]
    );
    excursionId = ex.rows[0]?.id ?? null;
  }

  const state = breached
    ? { breached: true, kind: last.kind, lastNotifyMs: Date.now(), excursionId }
    : { breached: false, kind: null, lastNotifyMs: 0, excursionId: null };
  alertState.set(sensorId, state);
  return state;
}

// ── Excursion records (open on breach, track peak, close on recovery) ────────
// A sensor can only be inside one excursion at a time. Without this check a
// second row was inserted whenever the in-memory state had no excursion id
// while the sensor was still breached -- which happens after every backend
// restart, and on any race between two readings. Those extra rows were never
// tracked by anything, so nothing ever closed them and they showed as ONGOING
// forever.
async function openExcursion(sensorId, kind, temp, limit) {
  const existing = await query(
    `SELECT id FROM excursions
      WHERE sensor_id = $1 AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
    [sensorId]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const r = await query(
    'INSERT INTO excursions (sensor_id, kind, peak_value, limit_value) VALUES ($1, $2, $3, $4) RETURNING id',
    [sensorId, kind, temp, limit]
  );
  return r.rows[0].id;
}

async function updateExcursionPeak(id, kind, temp) {
  const worse = kind === 'high' ? 'GREATEST' : 'LEAST';
  await query(`UPDATE excursions SET peak_value = ${worse}(peak_value, $2) WHERE id = $1`, [id, temp]);
}

// Close every open excursion for the sensor, not just the one this process is
// tracking. Orphans from an earlier process would otherwise stay ONGOING
// permanently, since nothing else ever looks at them.
async function closeExcursion(sensorId) {
  await query(
    'UPDATE excursions SET ended_at = NOW() WHERE sensor_id = $1 AND ended_at IS NULL',
    [sensorId]
  );
}

/**
 * Called by the sensors route after a rule is created/updated/deleted so the
 * next reading re-evaluates against the new limits from a clean slate.
 */
function resetSensor(sensorId) {
  ruleCache.delete(sensorId);
  alertState.delete(sensorId);
}

/**
 * Evaluate a single reading against its sensor's alert rule.
 * Fire-and-forget from the MQTT handler — must never throw into ingestion.
 *
 * @param {object} ctx
 * @param {string} ctx.hubMac      uppercase hub MAC (for the Socket.IO room)
 * @param {string} ctx.sensorMac   uppercase sensor MAC
 * @param {string} ctx.sensorName  display name
 * @param {number} ctx.sensorId
 * @param {number|null} ctx.temp   reading in °C (NULL for read errors — skipped)
 */
async function evaluateReading(ctx) {
  const { sensorId, temp } = ctx;
  if (temp == null) return; // read error — nothing to evaluate

  const rule = await getRule(sensorId);
  if (!rule) return;

  const state = await getState(sensorId);
  const high = rule.high_limit;
  const low = rule.low_limit;
  const hyst = rule.hysteresis ?? 1.0;

  let breachKind = null;
  if (high != null && temp > high) breachKind = 'high';
  else if (low != null && temp < low) breachKind = 'low';

  if (!state.breached) {
    if (breachKind) await fire(ctx, rule, state, breachKind);
    return;
  }

  // Currently breached — check for recovery (must fall a full hysteresis band
  // back inside the limit) before checking for a re-notify.
  const clearedHigh = state.kind === 'high' && (high == null || temp <= high - hyst);
  const clearedLow  = state.kind === 'low'  && (low  == null || temp >= low + hyst);

  if (clearedHigh || clearedLow) {
    await fire(ctx, rule, state, 'recovered');
  } else {
    // Still breached — keep the excursion's peak up to date.
    if (state.excursionId != null) await updateExcursionPeak(state.excursionId, state.kind, temp);
    if (breachKind && rule.cooldown_s > 0) {
      const sinceMs = Date.now() - state.lastNotifyMs;
      if (sinceMs >= rule.cooldown_s * 1000) {
        await fire(ctx, rule, state, breachKind); // still breached — re-notify
      }
    }
  }
}

async function fire(ctx, rule, state, kind) {
  if (kind === 'recovered') {
    state.breached = false;
    state.kind = null;
    await closeExcursion(ctx.sensorId);
    state.excursionId = null;
  } else {
    state.breached = true;
    state.kind = kind;
    state.lastNotifyMs = Date.now();
    // Open a new excursion only on a fresh breach, not on a cooldown re-notify.
    if (state.excursionId == null) {
      const limit = kind === 'high' ? rule.high_limit : rule.low_limit;
      state.excursionId = await openExcursion(ctx.sensorId, kind, ctx.temp, limit);
    }
  }

  ctx.excursionId = state.excursionId; // for the dashboard socket payload
  const delivered = await dispatch(ctx, rule, kind);

  await query(
    `INSERT INTO alert_events (rule_id, sensor_id, kind, value, channels)
     VALUES ($1, $2, $3, $4, $5)`,
    [rule.id, ctx.sensorId, kind, ctx.temp, delivered]
  );
}

/**
 * Deliver the alert on every configured channel we can currently handle.
 * Returns the list of channels actually delivered on (recorded on the event).
 */
async function dispatch(ctx, rule, kind) {
  const wanted = Array.isArray(rule.channels) && rule.channels.length
    ? rule.channels
    : ['dashboard'];
  const delivered = [];
  const message = buildMessage(ctx, rule, kind);

  if (wanted.includes('dashboard') && _io) {
    _io.to(`hub:${ctx.hubMac}`).emit('alert', {
      sensor_mac: ctx.sensorMac,
      sensor_name: ctx.sensorName,
      kind,
      value: ctx.temp,
      high_limit: rule.high_limit,
      low_limit: rule.low_limit,
      message,
      excursion_id: ctx.excursionId ?? null, // lets the dashboard acknowledge a live alarm without a refresh
      ts: Date.now(),
    });
    delivered.push('dashboard');
  }

  if (wanted.includes('push')) {
    try {
      const tokens = await getOrgPushTokens(ctx.sensorId);
      if (tokens.length) {
        const title = (kind === 'recovered' ? '✅ ' : '⚠️ ') + (ctx.sensorName || ctx.sensorMac);
        const { invalidTokens } = await sendPush(tokens, {
          title,
          body: message,
          data: { sensor_mac: ctx.sensorMac, kind, value: ctx.temp },
        });
        if (invalidTokens.length) {
          await query('DELETE FROM push_tokens WHERE token = ANY($1)', [invalidTokens]);
        }
        delivered.push('push');
      }
    } catch (err) {
      console.error('[push] dispatch error:', err.message);
    }
  }

  // 'whatsapp' (phase 3) is not delivered yet.

  return delivered;
}

/**
 * Collect Expo push tokens for everyone who can see a sensor: the owning org's
 * owner, all its members, and any superadmin (superadmins can see every sensor,
 * but are not org owners/members so they must be included explicitly).
 */
async function getOrgPushTokens(sensorId) {
  const res = await query(
    `SELECT DISTINCT pt.token
     FROM push_tokens pt
     WHERE pt.user_id IN (
       SELECT o.owner_id
       FROM sensors s JOIN devices d ON d.id = s.device_id JOIN organizations o ON o.id = d.org_id
       WHERE s.id = $1
       UNION
       SELECT m.user_id
       FROM sensors s JOIN devices d ON d.id = s.device_id JOIN memberships m ON m.org_id = d.org_id
       WHERE s.id = $1
       UNION
       SELECT id FROM users WHERE role = 'superadmin'
     )`,
    [sensorId]
  );
  return res.rows.map((r) => r.token);
}

function buildMessage(ctx, rule, kind) {
  return formatAlertMessage({
    name: ctx.sensorName || ctx.sensorMac,
    temp: ctx.temp,
    kind,
    high: rule.high_limit,
    low: rule.low_limit,
  });
}

/**
 * Human-readable alert text. Shared by the live dispatcher and the
 * /api/alerts/active route so the banner wording matches the socket events.
 */
function formatAlertMessage({ name, temp, kind, high, low }) {
  const t = Number(temp).toFixed(1);
  if (kind === 'high') return `⚠️ ${name} is ${t}°C — above the ${high}°C limit`;
  if (kind === 'low')  return `⚠️ ${name} is ${t}°C — below the ${low}°C limit`;
  return `✅ ${name} back to normal at ${t}°C`;
}

module.exports = { initAlerts, evaluateReading, resetSensor, formatAlertMessage, KNOWN_CHANNELS };
