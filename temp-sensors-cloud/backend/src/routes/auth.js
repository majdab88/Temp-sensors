'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const { audit } = require('../audit');
const { currentUser, signSession } = require('../middleware/auth');

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
      'SELECT id, username, email, password_hash, role, token_version FROM users WHERE email = $1',
      [login]
    );
    if (result.rows.length === 0) {
      result = await query(
        'SELECT id, username, email, password_hash, role, token_version FROM users WHERE username = $1',
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

    const payload = await sessionPayload(user, null);
    const { accessToken, refreshToken } = signSession(payload);

    await audit({ req: { ...req, user: payload, orgId: payload.orgId }, action: 'auth.login', targetType: 'user', targetId: user.id });
    res.json({ accessToken, refreshToken });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// What a token says about its user, read from the database. preferOrgId keeps
// a refreshed session in the org it was in, while the user still belongs to it.
async function sessionPayload(user, preferOrgId) {
  let orgId = null;
  let permissionLevel = null;
  if (user.role !== 'superadmin') {
    const orgRes = await query(
      `SELECT org_id, permission_level FROM memberships WHERE user_id = $1
        ORDER BY (org_id = $2) DESC, org_id LIMIT 1`,
      [user.id, preferOrgId]
    );
    if (orgRes.rows.length > 0) {
      orgId = orgRes.rows[0].org_id;
      permissionLevel = orgRes.rows[0].permission_level;
    }
  }
  return {
    sub: user.id, username: user.username, email: user.email || null,
    role: user.role, orgId, permissionLevel, tv: user.token_version,
  };
}

// POST /api/auth/refresh
//
// Re-reads the user instead of re-signing the old token's claims. It used to
// copy them, so a deleted user, a changed password or a demotion made no
// difference for the 7-day life of a refresh token.
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken is required' });
  }
  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
  try {
    if (!(await currentUser(decoded, true))) {
      return res.status(401).json({ error: 'Session has ended' });
    }
    const r = await query(
      'SELECT id, username, email, role, token_version FROM users WHERE id = $1',
      [decoded.sub]
    );
    if (r.rows.length === 0) return res.status(401).json({ error: 'Session has ended' });
    const payload = await sessionPayload(r.rows[0], decoded.orgId ?? null);
    res.json({ accessToken: signSession(payload).accessToken });
  } catch (err) {
    console.error('Refresh error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
