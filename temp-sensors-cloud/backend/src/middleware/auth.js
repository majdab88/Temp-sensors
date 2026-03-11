'use strict';

const jwt = require('jsonwebtoken');

/**
 * Middleware — requires a valid Bearer JWT in the Authorization header.
 * Sets req.user to the decoded payload on success.
 *
 * Superadmin impersonation: if the X-Org-Id header is present and the user
 * is a superadmin, req.orgId is set to the target org. Otherwise req.orgId
 * comes from the JWT.
 */
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  const token = auth.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    // Superadmin can impersonate any org via X-Org-Id header
    const impOrgId = req.headers['x-org-id'];
    if (impOrgId && decoded.role === 'superadmin') {
      req.orgId = parseInt(impOrgId, 10) || null;
      req.impersonating = true;
    } else {
      req.orgId = decoded.orgId || null;
      req.impersonating = false;
    }

    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Middleware — requires the user to be a superadmin. Must follow requireAuth.
 */
function requireSuperadmin(req, res, next) {
  if (req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin access required' });
  }
  next();
}

/**
 * Middleware — requires the user to be at least an owner in their org (or superadmin).
 */
function requireOwner(req, res, next) {
  if (req.user.role === 'superadmin') return next();
  if (req.user.role === 'owner') return next();
  return res.status(403).json({ error: 'Owner access required' });
}

/**
 * Returns true if the user is a superadmin and NOT impersonating an org.
 * Used to decide whether to return all data (unscoped) or org-scoped data.
 */
function isSuperadminUnscoped(req) {
  return req.user.role === 'superadmin' && !req.impersonating;
}

module.exports = { requireAuth, requireSuperadmin, requireOwner, isSuperadminUnscoped };
