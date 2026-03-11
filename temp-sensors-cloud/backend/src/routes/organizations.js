'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const { query } = require('../db');
const { requireAuth, requireSuperadmin, requireOwner, isSuperadminUnscoped } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/organizations — list orgs (superadmin: all; owner/member: their own)
router.get('/', async (req, res) => {
  try {
    let result;
    if (isSuperadminUnscoped(req)) {
      result = await query(
        `SELECT o.id, o.name, o.owner_id, o.created_at,
                u.username AS owner_username, u.email AS owner_email,
                (SELECT COUNT(*) FROM devices d WHERE d.org_id = o.id) AS device_count,
                (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS member_count
         FROM organizations o
         JOIN users u ON u.id = o.owner_id
         ORDER BY o.created_at DESC`
      );
    } else if (req.user.role === 'superadmin' && req.impersonating) {
      result = await query(
        `SELECT o.id, o.name, o.owner_id, o.created_at,
                u.username AS owner_username, u.email AS owner_email,
                (SELECT COUNT(*) FROM devices d WHERE d.org_id = o.id) AS device_count,
                (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS member_count
         FROM organizations o
         JOIN users u ON u.id = o.owner_id
         WHERE o.id = $1`,
        [req.orgId]
      );
    } else {
      result = await query(
        `SELECT o.id, o.name, o.owner_id, o.created_at,
                u.username AS owner_username, u.email AS owner_email,
                (SELECT COUNT(*) FROM devices d WHERE d.org_id = o.id) AS device_count,
                (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS member_count
         FROM organizations o
         JOIN users u ON u.id = o.owner_id
         JOIN memberships m ON m.org_id = o.id AND m.user_id = $1
         ORDER BY o.created_at DESC`,
        [req.user.sub]
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/organizations/:id/members — list members of an org
router.get('/:id/members', async (req, res) => {
  const orgId = parseInt(req.params.id, 10);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    return res.status(400).json({ error: 'Invalid org id' });
  }

  // Access check: superadmin can see any org; others must be a member
  if (req.user.role !== 'superadmin') {
    const check = await query(
      'SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2',
      [req.user.sub, orgId]
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Not a member of this organization' });
  }

  try {
    const result = await query(
      `SELECT u.id, u.username, u.email, u.role AS user_role, m.role AS org_role, m.joined_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1
       ORDER BY m.role DESC, m.joined_at ASC`,
      [orgId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/organizations/:id/members — invite a member to an org by email
// Owner (or superadmin) creates a new member user and adds them to the org.
// If a user with that email already exists, they are added to the org directly.
router.post('/:id/members', requireOwner, async (req, res) => {
  const orgId = parseInt(req.params.id, 10);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    return res.status(400).json({ error: 'Invalid org id' });
  }

  const { email, password } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'email is required' });
  }
  const emailStr = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }

  // Access check: owner must own this org (or be superadmin)
  if (req.user.role !== 'superadmin') {
    const check = await query(
      "SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2 AND role = 'owner'",
      [req.user.sub, orgId]
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Not the owner of this organization' });
  }

  try {
    // Check if user already exists by email
    const existing = await query('SELECT id, username, email FROM users WHERE email = $1', [emailStr]);

    if (existing.rows.length > 0) {
      // Existing user — just add them to the org
      const user = existing.rows[0];
      await query(
        'INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [user.id, orgId, 'member']
      );
      return res.status(200).json({ id: user.id, email: user.email, username: user.username, org_role: 'member', note: 'Existing user added to organization' });
    }

    // New user — password required
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'password (min 6 characters) is required for new members' });
    }

    const hash = await bcrypt.hash(password, 12);
    const username = emailStr.split('@')[0].slice(0, 64);

    // Create the member user
    let userRes;
    try {
      userRes = await query(
        'INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, username, email, role, created_at',
        [username, emailStr, hash, 'member']
      );
    } catch (e) {
      if (e.code === '23505' && e.constraint && e.constraint.includes('username')) {
        const suffix = Math.random().toString(36).slice(2, 6);
        userRes = await query(
          'INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, username, email, role, created_at',
          [`${username}_${suffix}`, emailStr, hash, 'member']
        );
      } else {
        throw e;
      }
    }
    const user = userRes.rows[0];

    // Add to org
    await query(
      'INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3)',
      [user.id, orgId, 'member']
    );

    res.status(201).json({ ...user, org_role: 'member' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'User is already a member of this organization' });
    }
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/organizations/:id/members/:userId — remove a member from an org
router.delete('/:id/members/:userId', requireOwner, async (req, res) => {
  const orgId = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(orgId) || !Number.isInteger(userId)) {
    return res.status(400).json({ error: 'Invalid ids' });
  }

  // Access check: owner must own this org (or be superadmin)
  if (req.user.role !== 'superadmin') {
    const check = await query(
      "SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2 AND role = 'owner'",
      [req.user.sub, orgId]
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Not the owner of this organization' });
  }

  // Cannot remove the owner
  const memberCheck = await query(
    'SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2',
    [userId, orgId]
  );
  if (memberCheck.rows.length === 0) return res.status(404).json({ error: 'Member not found in this organization' });
  if (memberCheck.rows[0].role === 'owner') return res.status(400).json({ error: 'Cannot remove the organization owner' });

  try {
    await query('DELETE FROM memberships WHERE user_id = $1 AND org_id = $2', [userId, orgId]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/organizations/:id/devices — list devices with nested sensors
router.get('/:id/devices', async (req, res) => {
  const orgId = parseInt(req.params.id, 10);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    return res.status(400).json({ error: 'Invalid org id' });
  }

  // Access check: superadmin can see any org; others must be a member
  if (req.user.role !== 'superadmin') {
    const check = await query(
      'SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2',
      [req.user.sub, orgId]
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Not a member of this organization' });
  }

  try {
    const devResult = await query(
      `SELECT id, mac, name, registered_at
       FROM devices WHERE org_id = $1
       ORDER BY registered_at DESC`,
      [orgId]
    );
    const devices = devResult.rows;

    if (devices.length === 0) return res.json([]);

    const deviceIds = devices.map(d => d.id);
    const senResult = await query(
      `SELECT id, device_id, mac, name, active, paired_at
       FROM sensors
       WHERE device_id = ANY($1::int[]) AND active = TRUE
       ORDER BY paired_at DESC`,
      [deviceIds]
    );

    // Group sensors by device_id
    const sensorsByDevice = {};
    for (const s of senResult.rows) {
      if (!sensorsByDevice[s.device_id]) sensorsByDevice[s.device_id] = [];
      sensorsByDevice[s.device_id].push(s);
    }

    const result = devices.map(d => ({
      ...d,
      sensors: sensorsByDevice[d.id] || [],
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/organizations/:id — rename an org (owner or superadmin)
router.put('/:id', requireOwner, async (req, res) => {
  const orgId = parseInt(req.params.id, 10);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    return res.status(400).json({ error: 'Invalid org id' });
  }
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  // Access check
  if (req.user.role !== 'superadmin') {
    const check = await query(
      "SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2 AND role = 'owner'",
      [req.user.sub, orgId]
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Not the owner of this organization' });
  }

  try {
    const result = await query(
      'UPDATE organizations SET name = $1 WHERE id = $2 RETURNING id, name',
      [name.trim().slice(0, 128), orgId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Organization not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
