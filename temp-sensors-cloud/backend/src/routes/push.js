'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Expo tokens look like ExponentPushToken[xxxxxxxx] or ExpoPushToken[xxxxxxxx]
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]+\]$/;

// POST /api/push/register — store (or refresh) the caller's Expo push token.
router.post('/register', async (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || typeof token !== 'string' || !EXPO_TOKEN_RE.test(token)) {
    return res.status(400).json({ error: 'Valid Expo push token required' });
  }
  const plat = platform === 'ios' || platform === 'android' ? platform : null;

  try {
    // Upsert on token: if this device was previously registered to another user,
    // move it to the current user.
    await query(
      `INSERT INTO push_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             platform = COALESCE(EXCLUDED.platform, push_tokens.platform),
             last_seen = NOW()`,
      [req.user.sub, token, plat]
    );
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/push/register — remove the caller's token (called on logout).
router.delete('/register', async (req, res) => {
  const { token } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token required' });
  }
  try {
    await query('DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [token, req.user.sub]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
