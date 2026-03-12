'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth, isSuperadminUnscoped } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/audit-log?action=login&limit=50&offset=0
router.get('/', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;
  const { action } = req.query;

  const conditions = [];
  const params = [];
  let idx = 1;

  // Org scoping
  if (!isSuperadminUnscoped(req)) {
    if (req.orgId) {
      conditions.push(`a.org_id = $${idx++}`);
      params.push(req.orgId);
    } else {
      return res.json({ rows: [], total: 0 });
    }
  }

  if (action) {
    conditions.push(`a.action = $${idx++}`);
    params.push(action);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countRes = await query(`SELECT COUNT(*) FROM audit_log a ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    params.push(limit, offset);
    const result = await query(
      `SELECT a.id, a.user_id, a.username, a.org_id, a.action,
              a.target_type, a.target_id, a.details, a.ip, a.created_at
       FROM audit_log a
       ${where}
       ORDER BY a.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );

    res.json({ rows: result.rows, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
