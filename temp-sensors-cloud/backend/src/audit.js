'use strict';

const { query } = require('./db');

/**
 * Record an audit log entry.
 *
 * @param {object} opts
 * @param {object} opts.req        - Express request (extracts user, orgId, IP)
 * @param {string} opts.action     - e.g. 'login', 'member.add', 'device.rename'
 * @param {string} [opts.targetType] - e.g. 'user', 'device', 'sensor', 'org'
 * @param {string|number} [opts.targetId] - ID of the affected resource
 * @param {object} [opts.details]  - Additional JSON details
 */
async function audit({ req, action, targetType, targetId, details }) {
  try {
    const userId = req?.user?.sub || null;
    const username = req?.user?.username || null;
    const orgId = req?.orgId || null;
    const ip = req?.ip || req?.connection?.remoteAddress || null;

    await query(
      `INSERT INTO audit_log (user_id, username, org_id, action, target_type, target_id, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, username, orgId, action, targetType || null, targetId != null ? String(targetId) : null, details ? JSON.stringify(details) : null, ip]
    );
  } catch (err) {
    // Audit logging should never break the main request
    console.error('Audit log error:', err.message);
  }
}

module.exports = { audit };
