'use strict';

const { query } = require('../db');

// Everyone who should be notified about a device: the owning org's owner, its
// members, and any superadmin (superadmins see everything but aren't org
// members, so they're included explicitly). Used by the health monitor.
//
// Push tokens only for now. WhatsApp recipients (users.phone) land with the
// WhatsApp PR — add phone lookups here once that column exists.

const IDS_BY_SENSOR = `
  SELECT o.owner_id FROM sensors s JOIN devices d ON d.id = s.device_id JOIN organizations o ON o.id = d.org_id WHERE s.id = $1
  UNION
  SELECT m.user_id  FROM sensors s JOIN devices d ON d.id = s.device_id JOIN memberships m ON m.org_id = d.org_id WHERE s.id = $1
  UNION
  SELECT id FROM users WHERE role = 'superadmin'`;

const IDS_BY_HUB = `
  SELECT o.owner_id FROM devices d JOIN organizations o ON o.id = d.org_id WHERE d.mac = $1
  UNION
  SELECT m.user_id  FROM devices d JOIN memberships m ON m.org_id = d.org_id WHERE d.mac = $1
  UNION
  SELECT id FROM users WHERE role = 'superadmin'`;

async function pushTokens(idsSql, param) {
  const res = await query(
    `SELECT DISTINCT pt.token FROM push_tokens pt WHERE pt.user_id IN (${idsSql})`,
    [param]
  );
  return res.rows.map((r) => r.token);
}

module.exports = {
  pushTokensForSensor: (sensorId) => pushTokens(IDS_BY_SENSOR, sensorId),
  pushTokensForHub:    (hubMac)   => pushTokens(IDS_BY_HUB, hubMac),
};
