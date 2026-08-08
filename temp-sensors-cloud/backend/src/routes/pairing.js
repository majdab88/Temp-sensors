'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth, isSuperadminUnscoped } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { publishPairingResponse, publishPairingEnable, publishSensorRemove } = require('../mqtt');
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
      const normMac      = row.slave_mac.toUpperCase();
      const defaultName  = 'TempSens-' + normMac.replace(/:/g, '').slice(-6);
      const newDeviceId  = row.device_id;

      // A physical sensor talks to exactly one hub, so it must be active under
      // exactly one device — otherwise it shows up duplicated on the dashboard.
      // If this sensor was already paired to a different hub in the same org,
      // migrate it here instead of creating a second row.
      const newOrgRes = await query('SELECT org_id FROM devices WHERE id = $1', [newDeviceId]);
      const newOrgId  = newOrgRes.rows[0]?.org_id ?? null;

      // Any active rows for this MAC under a *different* hub.
      const priorRes = await query(
        `SELECT s.id, d.mac AS hub_mac, d.org_id
         FROM sensors s JOIN devices d ON d.id = s.device_id
         WHERE s.mac = $1 AND s.device_id <> $2 AND s.active = TRUE`,
        [normMac, newDeviceId]
      );

      // Does a row already exist under the new hub (e.g. from an earlier data frame)?
      const existingNew = await query(
        'SELECT id FROM sensors WHERE device_id = $1 AND mac = $2',
        [newDeviceId, normMac]
      );

      let migrated = false;
      for (const prior of priorRes.rows) {
        // Never touch a sensor owned by a different org.
        if (newOrgId !== null && prior.org_id !== newOrgId) continue;

        // Tell the old hub to drop it from its NVS/peer table immediately.
        // (Its next sync would remove it too, but this is prompt.)
        try { publishSensorRemove(prior.hub_mac, normMac); } catch { /* offline — sync handles it */ }

        if (existingNew.rows.length === 0 && !migrated) {
          // Preserve reading history: reassign the prior row to the new hub.
          // Safe from the UNIQUE(device_id, mac) constraint because no row
          // exists under the new hub yet.
          await query(
            'UPDATE sensors SET device_id = $1, active = TRUE WHERE id = $2',
            [newDeviceId, prior.id]
          );
          migrated = true;
        } else {
          // A row already exists under the new hub (or we already migrated one)
          // — retire the leftover so it stops showing as a duplicate.
          await query('UPDATE sensors SET active = FALSE WHERE id = $1', [prior.id]);
        }
      }

      if (migrated) {
        await audit({ req, action: 'sensor.migrate', targetType: 'sensor', targetId: id, details: { slave_mac: normMac, to_device_id: newDeviceId } });
      } else {
        // Brand-new sensor, or its prior hub is in another org: insert if new,
        // re-activate if it was previously soft-deleted.
        await query(
          `INSERT INTO sensors (device_id, mac, name, active)
           VALUES ($1, $2, $3, TRUE)
           ON CONFLICT (device_id, mac) DO UPDATE SET active = TRUE, name = COALESCE(sensors.name, EXCLUDED.name)`,
          [newDeviceId, normMac, defaultName]
        );
      }
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

// POST /api/pairing/enable — tell a hub to enter or exit pairing mode
router.post('/enable', requirePermission('editor'), async (req, res) => {
  const { hub_mac, enable } = req.body || {};
  if (!hub_mac || typeof enable !== 'boolean') {
    return res.status(400).json({ error: 'hub_mac (string) and enable (boolean) are required' });
  }

  const mac = String(hub_mac).toUpperCase();

  // Verify device exists and belongs to user's org
  const params = [mac];
  const conditions = ['d.mac = $1'];
  if (!isSuperadminUnscoped(req) && req.orgId) {
    conditions.push(`d.org_id = $${params.length + 1}`);
    params.push(req.orgId);
  }

  try {
    const devRes = await query(
      `SELECT id FROM devices d WHERE ${conditions.join(' AND ')}`, params
    );
    if (devRes.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    publishPairingEnable(mac, enable);
    await audit({ req, action: enable ? 'pairing.enable' : 'pairing.disable', targetType: 'device', targetId: devRes.rows[0].id, details: { hub_mac: mac } });
    res.json({ ok: true, hub_mac: mac, pairing_mode: enable });
  } catch (err) {
    res.status(502).json({ error: 'Failed to send command to hub: ' + err.message });
  }
});

module.exports = router;
