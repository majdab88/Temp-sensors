'use strict';

const { query } = require('../db');

/**
 * Permission levels (tiered, each includes all lower levels):
 *   viewer  — read-only: view devices, sensors, readings
 *   editor  — viewer + rename/delete devices & sensors, approve/reject pairing
 *   admin   — editor + invite/remove members, full org control
 *
 * Owners always have admin-level access. Superadmins bypass all checks.
 */
const LEVELS = { viewer: 1, editor: 2, admin: 3 };

const _cache = new Map();
const CACHE_TTL = 60_000;

function cacheKey(userId, orgId) {
  return `${userId}:${orgId}`;
}

/**
 * Fetch membership for a user in an org.
 * Returns { role, permission_level } or null.
 */
async function getMemberPermissions(userId, orgId) {
  const key = cacheKey(userId, orgId);
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.value;

  const result = await query(
    'SELECT role, permission_level FROM memberships WHERE user_id = $1 AND org_id = $2',
    [userId, orgId]
  );

  const value = result.rows.length > 0 ? result.rows[0] : null;
  _cache.set(key, { value, ts: Date.now() });

  if (_cache.size > 5000) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }

  return value;
}

/**
 * Middleware factory — requires the caller to have at least `minLevel`
 * permission on the org identified by req.orgId (or req.params.id).
 *
 * @param {'viewer'|'editor'|'admin'} minLevel
 */
function requirePermission(minLevel) {
  const required = LEVELS[minLevel] || 1;

  return async (req, res, next) => {
    if (req.user.role === 'superadmin') return next();

    const orgId = req.orgId || parseInt(req.params.id, 10) || null;
    if (!orgId) {
      return res.status(403).json({ error: 'No organization context' });
    }

    const perms = await getMemberPermissions(req.user.sub, orgId);
    if (!perms) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    // Owners always have full access
    if (perms.role === 'owner') return next();

    const userLevel = LEVELS[perms.permission_level] || 1;
    if (userLevel < required) {
      return res.status(403).json({ error: `Permission denied: ${minLevel} access required` });
    }

    next();
  };
}

function clearPermissionCache(userId, orgId) {
  _cache.delete(cacheKey(userId, orgId));
}

module.exports = { requirePermission, getMemberPermissions, clearPermissionCache, LEVELS };
