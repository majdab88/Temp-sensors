'use strict';

const jwt = require('jsonwebtoken');
const { query } = require('../db');
const { getMemberPermissions } = require('./permissions');

// A signature alone used to be enough: a deleted user, a changed password or a
// stolen token kept working until the token expired, and the refresh endpoint
// re-signed whatever an old token said for 7 days. Every token now carries the
// user's token_version ("tv"), and is honoured only while it still matches the
// database. Bumping the version ends every session the user has.
//
// Checked on every request, cached briefly so a page load does not cost one
// query per API call. A revocation therefore takes effect within SESSION_TTL_MS
// at most -- immediately in this process, which clears the cache entry.
const SESSION_TTL_MS = 60_000;
const _sessions = new Map();   // user id -> { row, ts }

async function loadUser(userId, fresh = false) {
  const cached = _sessions.get(userId);
  if (!fresh && cached && Date.now() - cached.ts < SESSION_TTL_MS) return cached.row;
  const r = await query('SELECT role, token_version FROM users WHERE id = $1', [userId]);
  const row = r.rows[0] || null;
  _sessions.set(userId, { row, ts: Date.now() });
  if (_sessions.size > 5000) _sessions.delete(_sessions.keys().next().value);
  return row;
}

/**
 * The user's current row if a token for them is still valid, else null.
 * Tokens issued before token_version existed carry no "tv" and count as 0,
 * the column's default, so deploying this logs nobody out.
 */
async function currentUser(decoded, fresh = false) {
  const row = await loadUser(decoded.sub, fresh);
  if (!row) return null;                                  // user deleted
  if ((decoded.tv ?? 0) !== row.token_version) return null;  // session revoked
  return row;
}

/** End every session the user has, including the caller's own. */
async function revokeSessions(userId) {
  const r = await query(
    'UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version',
    [userId]
  );
  _sessions.delete(userId);
  return r.rows[0]?.token_version ?? null;
}

function signSession(payload) {
  return {
    accessToken:  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' }),
    refreshToken: jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' }),
  };
}

/**
 * Middleware — requires a valid Bearer JWT in the Authorization header whose
 * session has not been revoked. Sets req.user to the decoded payload, with the
 * role taken from the database rather than the token.
 *
 * Superadmin impersonation: if the X-Org-Id header is present and the user
 * is a superadmin, req.orgId is set to the target org. Otherwise req.orgId
 * comes from the JWT, and only while the user is still a member of that org:
 * many read routes scope by req.orgId alone, so a removed member's token would
 * otherwise keep showing that org's data until it expired.
 */
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  let decoded;
  try {
    decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    const row = await currentUser(decoded);
    if (!row) return res.status(401).json({ error: 'Session has ended' });
    req.user = { ...decoded, role: row.role };

    // Superadmin can impersonate any org via X-Org-Id header
    const impOrgId = req.headers['x-org-id'];
    if (impOrgId && row.role === 'superadmin') {
      req.orgId = parseInt(impOrgId, 10) || null;
      req.impersonating = true;
    } else {
      req.orgId = null;
      if (decoded.orgId && row.role !== 'superadmin' &&
          await getMemberPermissions(decoded.sub, decoded.orgId)) {
        req.orgId = decoded.orgId;
      }
      req.impersonating = false;
    }
    next();
  } catch (err) {
    console.error('Auth check failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
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

module.exports = {
  requireAuth, requireSuperadmin, requireOwner, isSuperadminUnscoped,
  currentUser, revokeSessions, signSession,
};
