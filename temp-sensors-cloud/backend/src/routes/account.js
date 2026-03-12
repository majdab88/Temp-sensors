'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { audit } = require('../audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/account — get own profile + memberships
router.get('/', async (req, res) => {
  try {
    const userRes = await query(
      'SELECT id, username, email, role, created_at FROM users WHERE id = $1',
      [req.user.sub]
    );
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const memRes = await query(
      `SELECT m.org_id, o.name AS org_name, m.role AS org_role,
              m.can_manage_members, m.can_manage_devices,
              m.can_approve_pairing, m.can_view_readings,
              m.joined_at
       FROM memberships m
       JOIN organizations o ON o.id = m.org_id
       WHERE m.user_id = $1
       ORDER BY m.joined_at ASC`,
      [req.user.sub]
    );

    res.json({ ...userRes.rows[0], memberships: memRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/account — update own profile (username, email)
router.put('/', async (req, res) => {
  const { username, email } = req.body || {};
  const updates = [];
  const params = [];
  let idx = 1;

  if (username && typeof username === 'string' && username.trim().length >= 2) {
    updates.push(`username = $${idx++}`);
    params.push(username.trim().slice(0, 64));
  }
  if (email && typeof email === 'string') {
    const emailStr = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    updates.push(`email = $${idx++}`);
    params.push(emailStr);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Provide username or email to update' });
  }

  params.push(req.user.sub);

  try {
    const result = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}
       RETURNING id, username, email, role, created_at`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    await audit({ req, action: 'account.update', targetType: 'user', targetId: req.user.sub, details: { fields: Object.keys(req.body) } });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email or username already taken' });
    }
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/account/password — change own password
router.put('/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ error: 'newPassword must be at least 6 characters' });
  }

  try {
    const userRes = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.sub]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, userRes.rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.sub]);

    await audit({ req, action: 'account.password_change', targetType: 'user', targetId: req.user.sub });
    res.json({ message: 'Password updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
