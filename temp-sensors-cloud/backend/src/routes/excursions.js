'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth, isSuperadminUnscoped } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { audit } = require('../audit');

const router = express.Router();
router.use(requireAuth);

// Build the org scope + optional filters for excursion queries.
function buildWhere(req) {
  const where = [];
  const params = [];
  if (!isSuperadminUnscoped(req)) {
    if (!req.orgId) return null;
    params.push(req.orgId);
    where.push(`d.org_id = $${params.length}`);
  }
  if (req.query.sensor_id) {
    params.push(parseInt(req.query.sensor_id, 10));
    where.push(`e.sensor_id = $${params.length}`);
  }
  if (req.query.active === 'true') where.push('e.ended_at IS NULL');
  if (req.query.unacked === 'true') where.push('e.ack_at IS NULL');
  if (req.query.from) {
    params.push(new Date(req.query.from));
    where.push(`e.started_at >= $${params.length}`);
  }
  if (req.query.to) {
    params.push(new Date(req.query.to));
    where.push(`e.started_at <= $${params.length}`);
  }
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

const SELECT = `
  SELECT e.id, e.sensor_id, s.name AS sensor_name, s.mac AS sensor_mac,
         d.name AS hub_name, d.mac AS hub_mac,
         e.kind, e.peak_value, e.limit_value,
         e.started_at, e.ended_at, e.ack_at, e.ack_by, e.ack_note,
         EXTRACT(EPOCH FROM (COALESCE(e.ended_at, NOW()) - e.started_at))::bigint AS duration_s
  FROM excursions e
  JOIN sensors s ON s.id = e.sensor_id
  JOIN devices d ON d.id = s.device_id`;

// GET /api/excursions — list, org-scoped, filterable
//   ?active=true  ?unacked=true  ?sensor_id=  ?from=  ?to=  ?limit=
router.get('/', async (req, res) => {
  const scope = buildWhere(req);
  if (!scope) return res.json([]);
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  scope.params.push(limit);
  try {
    const result = await query(
      `${SELECT} ${scope.clause} ORDER BY e.started_at DESC LIMIT $${scope.params.length}`,
      scope.params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/excursions/export.csv — same filters, streamed as CSV
router.get('/export.csv', async (req, res) => {
  const scope = buildWhere(req);
  if (!scope) return res.status(204).end();
  try {
    const result = await query(`${SELECT} ${scope.clause} ORDER BY e.started_at DESC LIMIT 10000`, scope.params);
    const head = ['sensor', 'hub', 'kind', 'started_at', 'ended_at', 'duration_min', 'peak_c', 'limit_c', 'acknowledged_at', 'acknowledged_by', 'note'];
    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [head.join(',')];
    for (const r of result.rows) {
      lines.push([
        r.sensor_name || r.sensor_mac, r.hub_name || r.hub_mac, r.kind,
        r.started_at ? r.started_at.toISOString() : '',
        r.ended_at ? r.ended_at.toISOString() : '',
        (r.duration_s / 60).toFixed(1),
        r.peak_value ?? '', r.limit_value ?? '',
        r.ack_at ? r.ack_at.toISOString() : '', r.ack_by ?? '', r.ack_note ?? '',
      ].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="excursions-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/excursions/:id — one excursion + the readings spanning its window
// (padded 30 min either side) so the UI can chart the breach in context.
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid excursion id' });

  const orgFilter = isSuperadminUnscoped(req) ? '' : 'AND d.org_id = $2';
  const params = isSuperadminUnscoped(req) ? [id] : [id, req.orgId];
  if (!isSuperadminUnscoped(req) && !req.orgId) return res.status(403).json({ error: 'No organization context' });

  try {
    const exRes = await query(`${SELECT} WHERE e.id = $1 ${orgFilter}`, params);
    const ex = exRes.rows[0];
    if (!ex) return res.status(404).json({ error: 'Excursion not found' });

    const PAD_MS = 30 * 60 * 1000;
    const from = new Date(new Date(ex.started_at).getTime() - PAD_MS);
    const to   = new Date((ex.ended_at ? new Date(ex.ended_at).getTime() : Date.now()) + PAD_MS);
    const rdRes = await query(
      `SELECT recorded_at, temp, hum FROM readings
       WHERE sensor_id = $1 AND recorded_at >= $2 AND recorded_at <= $3
       ORDER BY recorded_at ASC LIMIT 2000`,
      [ex.sensor_id, from, to]
    );

    res.json({ excursion: ex, readings: rdRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/excursions/:id/ack — acknowledge an excursion
router.post('/:id/ack', requirePermission('editor'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid excursion id' });
  const note = (req.body?.note ?? '').toString().slice(0, 500) || null;
  const who = req.user?.email || req.user?.username || 'unknown';

  try {
    // Ownership check for non-superadmins
    if (!isSuperadminUnscoped(req)) {
      if (!req.orgId) return res.status(403).json({ error: 'No organization context' });
      const chk = await query(
        `SELECT 1 FROM excursions e JOIN sensors s ON s.id = e.sensor_id JOIN devices d ON d.id = s.device_id
         WHERE e.id = $1 AND d.org_id = $2`,
        [id, req.orgId]
      );
      if (chk.rows.length === 0) return res.status(404).json({ error: 'Excursion not found' });
    }

    const result = await query(
      `UPDATE excursions SET ack_at = NOW(), ack_by = $2, ack_note = $3
       WHERE id = $1 AND ack_at IS NULL
       RETURNING id, ack_at, ack_by`,
      [id, who, note]
    );
    if (result.rows.length === 0) {
      // Already acknowledged (or not found) — return current state idempotently
      const cur = await query('SELECT id, ack_at, ack_by FROM excursions WHERE id = $1', [id]);
      if (cur.rows.length === 0) return res.status(404).json({ error: 'Excursion not found' });
      return res.json(cur.rows[0]);
    }
    await audit({ req, action: 'excursion.ack', targetType: 'excursion', targetId: id });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
