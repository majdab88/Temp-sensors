'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const { query } = require('../db');
const { requireAuth, requireSuperadmin } = require('../middleware/auth');
const { audit } = require('../audit');

const router = express.Router();
router.use(requireAuth);
router.use(requireSuperadmin);

// GET /api/users — list all users with org info
router.get('/', async (_req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.username, u.email, u.phone, u.role, u.created_at,
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
// Owners/members are identified by email; username is derived from the email local part.
router.post('/', async (req, res) => {
  const { email, password, role, orgName } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  const emailStr = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }

  const validRoles = ['owner', 'member'];
  const userRole = validRoles.includes(role) ? role : 'owner';

  // Derive a display username from the email local part
  const username = emailStr.split('@')[0].slice(0, 64);

  try {
    const hash = await bcrypt.hash(password, 12);
    // Use email as unique key; username may collide so append suffix if needed
    let userRes;
    try {
      userRes = await query(
        'INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, username, email, phone, role, created_at',
        [username, emailStr, hash, userRole]
      );
    } catch (e) {
      if (e.code === '23505' && e.constraint && e.constraint.includes('username')) {
        // Username collision — append random suffix
        const suffix = Math.random().toString(36).slice(2, 6);
        userRes = await query(
          'INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, username, email, phone, role, created_at',
          [`${username}_${suffix}`, emailStr, hash, userRole]
        );
      } else {
        throw e;
      }
    }
    const user = userRes.rows[0];

    // Auto-create an organization for new owners
    if (userRole === 'owner') {
      const name = orgName || `${username}'s System`;
      const orgRes = await query(
        'INSERT INTO organizations (name, owner_id) VALUES ($1, $2) RETURNING id, name',
        [name, user.id]
      );
      const org = orgRes.rows[0];
      // Add owner as a member of their own org (admin-level access)
      await query(
        `INSERT INTO memberships (user_id, org_id, role, permission_level)
         VALUES ($1, $2, $3, $4)`,
        [user.id, org.id, 'owner', 'admin']
      );
      user.organization = org;
    }

    await audit({ req, action: 'user.create', targetType: 'user', targetId: user.id, details: { email: emailStr, role: userRole } });
    res.status(201).json(user);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
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

  const { email, username, password, role, phone } = req.body || {};
  const updates = [];
  const params = [];
  let paramIdx = 1;

  if (email && typeof email === 'string') {
    const emailStr = email.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr)) {
      updates.push(`email = $${paramIdx++}`);
      params.push(emailStr);
    }
  }
  if (phone !== undefined) {
    const phoneStr = String(phone).trim();
    if (phoneStr !== '' && !/^\+[1-9]\d{6,14}$/.test(phoneStr)) {
      return res.status(400).json({ error: 'Phone must be in international format, e.g. +972541234567' });
    }
    updates.push(`phone = $${paramIdx++}`);
    params.push(phoneStr === '' ? null : phoneStr);
  }
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
       RETURNING id, username, email, role, created_at`,
      params
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found or cannot modify superadmin' });
    }
    await audit({ req, action: 'user.update', targetType: 'user', targetId: id, details: { fields: Object.keys(req.body) } });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email or username already taken' });
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
    await audit({ req, action: 'user.delete', targetType: 'user', targetId: id });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
