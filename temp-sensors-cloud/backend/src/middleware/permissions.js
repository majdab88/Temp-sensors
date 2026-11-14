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
 * permission on their own org (req.orgId, from the JWT).
 *
 * Resource routes (/api/sensors/:id, ...) use this, and must still check that
 * the resource belongs to req.orgId. Routes that act on the org named in the
 * URL use requireOrgPermission instead.
 *
 * There is deliberately no fallback to req.params.id. There used to be, and two
 * different things went wrong because of it: on the org routes the check ran
 * against the caller's own org while the route acted on the org in the URL (so
 * an admin of org A could add themselves to org B), and on resource routes a
 * user with no org had a sensor or device id read as an org id.
 *
 * @param {'viewer'|'editor'|'admin'} minLevel
 */
function requirePermission(minLevel) {
  return checkPermission(minLevel, (req) => req.orgId || null);
}

/**
 * Middleware factory — requires `minLevel` on the org named by req.params.id,
 * for the /api/organizations/:id/... routes that act on that org.
 *
 * @param {'viewer'|'editor'|'admin'} minLevel
 */
function requireOrgPermission(minLevel) {
  return checkPermission(minLevel, (req) => {
    const id = parseInt(req.params.id, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  });
}

function checkPermission(minLevel, resolveOrgId) {
  const required = LEVELS[minLevel] || 1;

  return async (req, res, next) => {
    if (req.user.role === 'superadmin') return next();

    const orgId = resolveOrgId(req);
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

module.exports = { requirePermission, requireOrgPermission, getMemberPermissions, clearPermissionCache, LEVELS };
