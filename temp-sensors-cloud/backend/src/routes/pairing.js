'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publishPairingResponse } = require('../mqtt');

const router = express.Router();
router.use(requireAuth);

// GET /api/pairing/requests?status=pending|approved|rejected
router.get('/requests', async (req, res) => {
  const { status } = req.query;
  const VALID_STATUSES = ['pending', 'approved', 'rejected'];

  const params = [];
  let where = '';

  if (status) {
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status must be pending, approved, or rejected' });
    }
    where = 'WHERE pr.status = $1';
    params.push(status);
  }

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
router.post('/requests/:id/approve', (req, res) => resolveRequest(req, res, true));

// POST /api/pairing/requests/:id/reject
router.post('/requests/:id/reject', (req, res) => resolveRequest(req, res, false));

async function resolveRequest(req, res, approved) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid pairing request id' });
  }

  const resolvedBy = req.user?.sub || 'admin';

  try {
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

    // Publish the decision to the hub via MQTT
    const devRes = await query('SELECT mac FROM devices WHERE id = $1', [row.device_id]);
    if (devRes.rows.length > 0) {
      publishPairingResponse(devRes.rows[0].mac, row.slave_mac, approved);
    }

    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
}

module.exports = router;
