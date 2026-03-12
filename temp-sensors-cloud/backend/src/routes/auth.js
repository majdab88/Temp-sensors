'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const { audit } = require('../audit');

const router = express.Router();

// 10 attempts per minute per IP on the login endpoint
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
});

// POST /api/auth/login
// Accepts { email, password } for owners/members, or { username, password } for superadmin.
router.post('/login', loginLimiter, async (req, res) => {
  const { email, username, password } = req.body || {};
  const login = email || username;
  if (!login || !password) {
    return res.status(400).json({ error: 'email (or username) and password are required' });
  }

  try {
    // Try email first (owners/members), then fall back to username (superadmin)
    let result = await query(
      'SELECT id, username, email, password_hash, role FROM users WHERE email = $1',
      [login]
    );
    if (result.rows.length === 0) {
      result = await query(
        'SELECT id, username, email, password_hash, role FROM users WHERE username = $1',
        [login]
      );
    }
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // For owners/members, find their org(s)
    let orgId = null;
    let permissionLevel = null;
    if (user.role !== 'superadmin') {
      const orgRes = await query(
        'SELECT org_id, permission_level FROM memberships WHERE user_id = $1 LIMIT 1',
        [user.id]
      );
      if (orgRes.rows.length > 0) {
        orgId = orgRes.rows[0].org_id;
        permissionLevel = orgRes.rows[0].permission_level;
      }
    }

    const payload = {
      sub: user.id, username: user.username, email: user.email || null,
      role: user.role, orgId, permissionLevel,
    };

    const accessToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });

    await audit({ req: { ...req, user: payload, orgId }, action: 'auth.login', targetType: 'user', targetId: user.id });
    res.json({ accessToken, refreshToken });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken is required' });
  }
  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const accessToken = jwt.sign(
      { sub: decoded.sub, username: decoded.username, email: decoded.email || null, role: decoded.role, orgId: decoded.orgId, permissionLevel: decoded.permissionLevel },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    res.json({ accessToken });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

module.exports = router;
