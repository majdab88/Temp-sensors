'use strict';

// Per-hub MQTT accounts.
//
// Every hub used to log in to the broker with one shared username and password,
// readable by any dashboard user, with read/write on every hub's topics. Now
// each registered hub has its own account: username = its MAC without colons,
// password = devices.api_key, allowed only under sensors/<its MAC>/.
//
// The broker is configured from a file in a volume shared with the mosquitto
// container. mosquitto/entrypoint.sh watches it, rebuilds the broker's password
// file and ACL from it, and signals mosquitto to reload. Rewriting the file is
// therefore how a hub is added (registration), re-keyed (re-registration
// rotates api_key) or locked out (deletion). A hub that is connected when its
// account goes keeps its session until it next reconnects.

const fs   = require('fs');
const path = require('path');
const { query } = require('./db');

const ACCOUNTS_FILE = process.env.MQTT_HUB_ACCOUNTS_FILE || '/data/mqtt-hubs/hubs';

// A colon cannot appear in a mosquitto username: its password file is
// "user:hash", split at the first colon.
function hubMqttUser(mac) {
  return mac.toUpperCase().replace(/:/g, '');
}

const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
const KEY_RE = /^[0-9a-f]{64}$/;

let writing = Promise.resolve();

/** Rewrite the accounts file from the devices table. Serialised. */
function writeHubAccounts() {
  writing = writing.then(async () => {
    const r = await query('SELECT mac, api_key FROM devices ORDER BY mac');
    // Validated rather than trusted: the file is parsed by a shell script, so a
    // value with a space or newline in it would corrupt every entry after it.
    const lines = r.rows
      .filter((d) => MAC_RE.test(d.mac) && KEY_RE.test(d.api_key))
      .map((d) => `${hubMqttUser(d.mac)} ${d.api_key} ${d.mac}\n`);
    fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
    const tmp = `${ACCOUNTS_FILE}.tmp`;
    fs.writeFileSync(tmp, lines.join(''), { mode: 0o600 });
    fs.renameSync(tmp, ACCOUNTS_FILE);   // the watcher never sees a half-written file
    console.log(`MQTT hub accounts written: ${lines.length}`);
  }).catch((err) => console.error('MQTT hub accounts write failed:', err.message));
  return writing;
}

module.exports = { hubMqttUser, writeHubAccounts };
