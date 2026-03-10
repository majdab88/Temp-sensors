'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const { query } = require('../db');
const { requireAuth, requireSuperadmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireSuperadmin);

// GET /api/users — list all users with org info
router.get('/', async (_req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.username, u.role, u.created_at,
              COALESCE(json_agg(
                json_build_object('org_id', o.id, 'org_name', o.name)
              ) FILTER (WHERE o.id IS NOT NULL), '[]') AS organizations
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
       LEFT JOIN organizations o ON o.id = m.org_id
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/users — create a new owner (+ auto-create their org)
router.post('/', async (req, res) => {
  const { username, password, role, orgName } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (typeof username !== 'string' || username.trim().length < 2) {
    return res.status(400).json({ error: 'username must be at least 2 characters' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }

  const validRoles = ['owner', 'member'];
  const userRole = validRoles.includes(role) ? role : 'owner';

  try {
    const hash = await bcrypt.hash(password, 12);
    const userRes = await query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, created_at',
      [username.trim(), hash, userRole]
    );
    const user = userRes.rows[0];

    // Auto-create an organization for new owners
    if (userRole === 'owner') {
      const name = orgName || `${username.trim()}'s System`;
      const orgRes = await query(
        'INSERT INTO organizations (name, owner_id) VALUES ($1, $2) RETURNING id, name',
        [name, user.id]
      );
      const org = orgRes.rows[0];
      // Add owner as a member of their own org
      await query(
        'INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3)',
        [user.id, org.id, 'owner']
      );
      user.organization = org;
    }

    res.status(201).json(user);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already taken' });
    }
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/users/:id — update user (username, role, password)
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const { username, password, role } = req.body || {};
  const updates = [];
  const params = [];
  let paramIdx = 1;

  if (username && typeof username === 'string' && username.trim().length >= 2) {
    updates.push(`username = $${paramIdx++}`);
    params.push(username.trim());
  }
  if (role && ['owner', 'member'].includes(role)) {
    updates.push(`role = $${paramIdx++}`);
    params.push(role);
  }
  if (password && typeof password === 'string' && password.length >= 6) {
    const hash = await bcrypt.hash(password, 12);
    updates.push(`password_hash = $${paramIdx++}`);
    params.push(hash);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  params.push(id);

  try {
    const result = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIdx} AND role != 'superadmin'
       RETURNING id, username, role, created_at`,
      params
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found or cannot modify superadmin' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already taken' });
    }
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/users/:id — delete user (cascades org memberships; devices become unowned)
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  try {
    const result = await query(
      "DELETE FROM users WHERE id = $1 AND role != 'superadmin' RETURNING id",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found or cannot delete superadmin' });
    }
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
