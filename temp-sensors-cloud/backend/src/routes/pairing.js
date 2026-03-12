'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth, isSuperadminUnscoped } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { publishPairingResponse } = require('../mqtt');
const { audit } = require('../audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/pairing/requests?status=pending|approved|rejected
router.get('/requests', async (req, res) => {
  const { status } = req.query;
  const VALID_STATUSES = ['pending', 'approved', 'rejected'];

  const params = [];
  const conditions = [];
  let nextParam = 1;

  if (status) {
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status must be pending, approved, or rejected' });
    }
    conditions.push(`pr.status = $${nextParam++}`);
    params.push(status);
  }

  // Org scoping
  if (!isSuperadminUnscoped(req)) {
    if (req.orgId) {
      conditions.push(`d.org_id = $${nextParam++}`);
      params.push(req.orgId);
    } else {
      return res.json([]);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await query(
      `SELECT pr.id, pr.slave_mac, pr.status,
              pr.requested_at, pr.resolved_at, pr.resolved_by,
              d.mac AS hub_mac, d.name AS hub_name
       FROM pairing_requests pr
       JOIN devices d ON d.id = pr.device_id
       ${where}
       ORDER BY pr.requested_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/pairing/requests/:id/approve
router.post('/requests/:id/approve', requirePermission('editor'), (req, res) => resolveRequest(req, res, true));

// POST /api/pairing/requests/:id/reject
router.post('/requests/:id/reject', requirePermission('editor'), (req, res) => resolveRequest(req, res, false));

async function resolveRequest(req, res, approved) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid pairing request id' });
  }

  const resolvedBy = req.user?.username || String(req.user?.sub) || 'admin';

  try {
    // Ownership check for non-superadmin
    if (!isSuperadminUnscoped(req) && req.orgId) {
      const check = await query(
        'SELECT 1 FROM pairing_requests pr JOIN devices d ON d.id = pr.device_id WHERE pr.id = $1 AND d.org_id = $2',
        [id, req.orgId]
      );
      if (check.rows.length === 0) return res.status(404).json({ error: 'Pending pairing request not found' });
    }

    const result = await query(
      `UPDATE pairing_requests
       SET status = $1, resolved_at = NOW(), resolved_by = $2
       WHERE id = $3 AND status = 'pending'
       RETURNING id, device_id, slave_mac, status`,
      [approved ? 'approved' : 'rejected', resolvedBy, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pending pairing request not found' });
    }

    const row = result.rows[0];

    // Re-activate sensor if it was previously soft-deleted (covers the
    // "delete then factory-reset and re-pair" flow).  Must run before
    // publishPairingResponse so that when data frames arrive the upsert
    // in handleSensorData finds active = TRUE and accepts them.
    if (approved) {
      // Insert the sensor if brand-new; re-activate if it was previously soft-deleted.
      const normMac = row.slave_mac.toUpperCase();
      const defaultName = 'TempSens-' + normMac.replace(/:/g, '').slice(-6);
      await query(
        `INSERT INTO sensors (device_id, mac, name, active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (device_id, mac) DO UPDATE SET active = TRUE, name = COALESCE(sensors.name, EXCLUDED.name)`,
        [row.device_id, normMac, defaultName]
      );
    }

    // Publish the decision to the hub via MQTT
    const devRes = await query('SELECT mac FROM devices WHERE id = $1', [row.device_id]);
    if (devRes.rows.length > 0) {
      publishPairingResponse(devRes.rows[0].mac, row.slave_mac, approved);
    }

    await audit({ req, action: approved ? 'pairing.approve' : 'pairing.reject', targetType: 'pairing_request', targetId: id, details: { slave_mac: row.slave_mac } });
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
}

module.exports = router;
