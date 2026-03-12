'use strict';

const { query } = require('../db');

/**
 * Cache of user permissions per org — avoids repeated DB queries within a
 * single request lifecycle. Keyed by `${userId}:${orgId}`.
 */
const _cache = new Map();
const CACHE_TTL = 60_000; // 1 minute

function cacheKey(userId, orgId) {
  return `${userId}:${orgId}`;
}

/**
 * Fetch membership permissions for a user in an org.
 * Returns { role, can_manage_members, can_manage_devices, can_approve_pairing, can_view_readings }
 * or null if the user is not a member.
 */
async function getMemberPermissions(userId, orgId) {
  const key = cacheKey(userId, orgId);
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.value;

  const result = await query(
    `SELECT role, can_manage_members, can_manage_devices,
            can_approve_pairing, can_view_readings
     FROM memberships WHERE user_id = $1 AND org_id = $2`,
    [userId, orgId]
  );

  const value = result.rows.length > 0 ? result.rows[0] : null;
  _cache.set(key, { value, ts: Date.now() });

  // Prevent unbounded growth
  if (_cache.size > 5000) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }

  return value;
}

/**
 * Middleware factory — requires the caller to have a specific permission
 * on the org identified by req.orgId (or req.params.id for org routes).
 *
 * Superadmins always pass. Owners always pass (backward compatible).
 *
 * @param {string} permission - one of: can_manage_members, can_manage_devices,
 *                              can_approve_pairing, can_view_readings
 */
function requirePermission(permission) {
  return async (req, res, next) => {
    // Superadmin bypasses all permission checks
    if (req.user.role === 'superadmin') return next();

    const orgId = req.orgId || parseInt(req.params.id, 10) || null;
    if (!orgId) {
      return res.status(403).json({ error: 'No organization context' });
    }

    const perms = await getMemberPermissions(req.user.sub, orgId);
    if (!perms) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    // Owners always have all permissions
    if (perms.role === 'owner') return next();

    if (!perms[permission]) {
      return res.status(403).json({ error: `Permission denied: ${permission} required` });
    }

    next();
  };
}

/**
 * Clear cached permissions for a user/org pair (e.g. after updating permissions).
 */
function clearPermissionCache(userId, orgId) {
  _cache.delete(cacheKey(userId, orgId));
}

module.exports = { requirePermission, getMemberPermissions, clearPermissionCache };
