'use strict';

const { query } = require('./db');

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
  const state = last && last.kind !== 'recovered'
    ? { breached: true, kind: last.kind, lastNotifyMs: Date.now() }
    : { breached: false, kind: null, lastNotifyMs: 0 };
  alertState.set(sensorId, state);
  return state;
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
  } else if (breachKind && rule.cooldown_s > 0) {
    const sinceMs = Date.now() - state.lastNotifyMs;
    if (sinceMs >= rule.cooldown_s * 1000) {
      await fire(ctx, rule, state, breachKind); // still breached — re-notify
    }
  }
}

async function fire(ctx, rule, state, kind) {
  if (kind === 'recovered') {
    state.breached = false;
    state.kind = null;
  } else {
    state.breached = true;
    state.kind = kind;
    state.lastNotifyMs = Date.now();
  }

  const delivered = dispatch(ctx, rule, kind);

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
function dispatch(ctx, rule, kind) {
  const wanted = Array.isArray(rule.channels) && rule.channels.length
    ? rule.channels
    : ['dashboard'];
  const delivered = [];

  if (wanted.includes('dashboard') && _io) {
    _io.to(`hub:${ctx.hubMac}`).emit('alert', {
      sensor_mac: ctx.sensorMac,
      sensor_name: ctx.sensorName,
      kind,
      value: ctx.temp,
      high_limit: rule.high_limit,
      low_limit: rule.low_limit,
      message: buildMessage(ctx, rule, kind),
      ts: Date.now(),
    });
    delivered.push('dashboard');
  }

  // 'push' (phase 2) and 'whatsapp' (phase 3) are not delivered yet.

  return delivered;
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
