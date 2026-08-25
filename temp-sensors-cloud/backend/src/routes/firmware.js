'use strict';

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs/promises');
const path    = require('path');
const { query } = require('../db');
const { requireAuth, requireSuperadmin } = require('../middleware/auth');
const { audit } = require('../audit');
const { publishOtaCommand, publishSensorOtaCommand } = require('../mqtt');

const router = express.Router();
router.use(requireAuth);

// Firmware is fleet-wide infrastructure, not org data — superadmin only.
router.use(requireSuperadmin);

const FIRMWARE_DIR = process.env.FIRMWARE_DIR || '/data/firmware';

// Deliberately plain HTTP: the hub verifies the image signature on-device and
// does not authenticate TLS certificates anyway, so HTTPS would only cost it a
// second concurrent TLS session alongside MQTT. See tools/firmware-signing/.
const FIRMWARE_BASE_URL = process.env.FIRMWARE_BASE_URL || '';

const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const MAC_RE     = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;

// Hub-side buffers: otaUrl[192], otaVersion[16], otaSigB64[160]. Reject anything
// that would be silently truncated on the device rather than shipping a command
// the hub cannot act on.
const MAX_URL_LEN = 191;
const MAX_SIG_LEN = 159;

function imageUrl(sha256) {
  return `${FIRMWARE_BASE_URL.replace(/\/+$/, '')}/firmware/${sha256}.bin`;
}

// Optional upload-time signature check. The public key is not secret, so
// keeping it here is safe and catches a signature/binary mismatch at upload
// instead of on a hub that then refuses to install.
function verifyUploadSignature(image, signatureB64) {
  let pem = process.env.FW_PUBLIC_KEY_PEM;
  if (!pem) return { checked: false, valid: null };

  // A PEM is multi-line and Docker Compose .env files cannot hold multi-line
  // values, so the practical way to configure this is a single line with
  // escaped newlines. Accept either form rather than making the operator care.
  pem = pem.trim().replace(/\\n/g, '\n');
  try {
    const ok = crypto
      .createVerify('SHA256')
      .update(image)
      .verify(pem, Buffer.from(signatureB64, 'base64'));
    return { checked: true, valid: ok };
  } catch (err) {
    console.error('Signature check error:', err.message);
    return { checked: true, valid: false };
  }
}

// GET /api/firmware — list uploaded images, newest first
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT f.id, f.device_kind, f.version, f.size, f.sha256, f.notes,
              f.created_at, u.username AS created_by
         FROM firmware_images f
         LEFT JOIN users u ON u.id = f.created_by
        ORDER BY f.created_at DESC`
    );
    res.json(result.rows.map((r) => ({ ...r, url: imageUrl(r.sha256) })));
  } catch (err) {
    console.error('List firmware error:', err.message);
    res.status(500).json({ error: 'Failed to list firmware' });
  }
});

// POST /api/firmware?version=1.1.0&signature=<base64>&kind=hub&notes=...
// Body: the raw .bin. Raw rather than multipart so no upload dependency is
// needed; the dashboard posts the File object directly.
router.post(
  '/',
  express.raw({ type: 'application/octet-stream', limit: '8mb' }),
  async (req, res) => {
    const { version, signature, kind = 'hub', notes = '' } = req.query;

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Empty body — POST the .bin as application/octet-stream' });
    }
    if (!version || !VERSION_RE.test(version)) {
      return res.status(400).json({ error: 'version must look like 1.2.3' });
    }
    if (!signature || signature.length > MAX_SIG_LEN) {
      return res.status(400).json({ error: 'signature missing or too long' });
    }
    if (kind !== 'hub' && kind !== 'sensor') {
      return res.status(400).json({ error: "kind must be 'hub' or 'sensor'" });
    }
    if (!FIRMWARE_BASE_URL) {
      return res.status(500).json({ error: 'FIRMWARE_BASE_URL is not configured' });
    }

    const image  = req.body;
    const sha256 = crypto.createHash('sha256').update(image).digest('hex');

    // The image states its own version through a marker embedded at build time.
    // Without this the registry simply believes whatever version the uploader
    // types, and a stale or wrong binary can be published under a label it does
    // not match — which has happened twice, each time only surfacing after a hub
    // had downloaded the whole 1.6 MB and rebooted into the wrong firmware.
    //
    // esp_app_desc_t is not usable here: under Arduino it carries the core's own
    // build info (arduino-lib-builder), not ours.
    // Each build carries a marker naming what it is and which version. Two
    // things get checked with it, and the second matters more:
    //
    //   1. the image agrees with the version it is being uploaded as
    //   2. a hub image is not being uploaded as sensor firmware, or vice versa
    //
    // The second is the dangerous mix-up. A hub image on a sensor would give it
    // the wrong pins and no deep sleep, and on a v2 board recovering that needs
    // the enclosure opened and an ESP-PROG attached.
    const TAGS = { hub: 'TEMPHUB_FW=', sensor: 'TEMPSENS_FW=' };
    const wrongKind = kind === 'hub' ? 'sensor' : 'hub';

    if (image.indexOf(TAGS[wrongKind]) !== -1) {
      return res.status(400).json({
        error: `This is ${wrongKind} firmware, but you are uploading it as a ` +
               `${kind} image. Check which .bin you picked.`,
      });
    }

    const TAG = TAGS[kind];
    const tagAt = image.indexOf(TAG);
    if (tagAt !== -1) {
      const embedded = image
        .subarray(tagAt + TAG.length, tagAt + TAG.length + 16)
        .toString('latin1')
        .split('\0')[0]
        .trim();
      if (embedded && embedded !== version) {
        return res.status(400).json({
          error: `This image reports version ${embedded}, but you are uploading it ` +
                 `as ${version}. Rebuild after bumping FW_PATCH, or correct the version field.`,
        });
      }
    }

    if (imageUrl(sha256).length > MAX_URL_LEN) {
      return res.status(500).json({ error: 'FIRMWARE_BASE_URL too long for the hub URL buffer' });
    }

    const sig = verifyUploadSignature(image, signature);
    if (sig.checked && !sig.valid) {
      return res.status(400).json({
        error: 'Signature does not match this image — re-run tools/firmware-signing/sign.js',
      });
    }

    try {
      await fs.mkdir(FIRMWARE_DIR, { recursive: true });
      // Content-addressed, so re-uploading the same bytes is idempotent.
      await fs.writeFile(path.join(FIRMWARE_DIR, `${sha256}.bin`), image);

      // Re-uploading identical bytes is a harmless no-op, but uploading them
      // under a *different* version or signature must not silently rewrite the
      // existing entry. That is how a mislabelled upload once replaced a
      // known-good image's signature with one that did not match its own bytes,
      // leaving the registry serving an image no hub would accept.
      // The mirror of the check below: different bytes must not claim a version
      // that already exists. Forgetting to bump FW_PATCH puts a second, distinct
      // image into the registry under a label that is already taken, and every
      // device then reports a version that no longer identifies what it runs.
      const clash = await query(
        'SELECT id, sha256 FROM firmware_images WHERE version = $1 AND device_kind = $2 AND sha256 <> $3',
        [version, kind, sha256]
      );
      if (clash.rows.length > 0) {
        return res.status(409).json({
          error: `Version ${version} already exists as a different image ` +
                 `(${clash.rows[0].sha256.slice(0, 12)}…). Bump the version and rebuild, ` +
                 `or delete that entry if you meant to replace it.`,
        });
      }

      const existing = await query(
        'SELECT id, version, signature FROM firmware_images WHERE sha256 = $1',
        [sha256]
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.version !== version || row.signature !== signature) {
          return res.status(409).json({
            error: `These exact bytes are already registered as version ${row.version}. ` +
                   `Re-uploading them as ${version} would relabel that entry. ` +
                   `Delete it first if that is really what you want, or check you picked the right .bin.`,
          });
        }
        await query('UPDATE firmware_images SET notes = $1 WHERE id = $2',
                    [notes || null, row.id]);
      }

      const result = await query(
        `INSERT INTO firmware_images (device_kind, version, size, sha256, signature, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (sha256) DO UPDATE SET notes = EXCLUDED.notes
         RETURNING id, device_kind, version, size, sha256, notes, created_at`,
        [kind, version, image.length, sha256, signature, notes || null, req.user.sub || null]
      );

      const row = result.rows[0];
      await audit({
        req,
        action: 'firmware.upload',
        targetType: 'firmware',
        targetId: row.id,
        details: { version, kind, sha256, size: image.length, signature_verified: sig.valid },
      });

      res.status(201).json({ ...row, url: imageUrl(sha256), signature_verified: sig.valid });
    } catch (err) {
      console.error('Upload firmware error:', err.message);
      res.status(500).json({ error: 'Failed to store firmware' });
    }
  }
);

// POST /api/firmware/:id/stage — tell one hub to install this image
router.post('/:id/stage', async (req, res) => {
  // Which address is required depends on what kind of image this is, so the
  // check cannot happen until the image has been looked up. Validating hub_mac
  // up front rejected every sensor stage before it was ever considered.
  const { hub_mac } = req.body || {};

  try {
    const fwRes = await query(
      'SELECT id, device_kind, version, sha256, signature FROM firmware_images WHERE id = $1',
      [req.params.id]
    );
    if (fwRes.rows.length === 0) return res.status(404).json({ error: 'Firmware not found' });
    const fw = fwRes.rows[0];

    // A sensor image is relayed by its hub rather than fetched directly, so the
    // command is addressed to the hub with the sensor named inside it.
    if (fw.device_kind === 'sensor') {
      const sensorMac = (req.body.sensor_mac || '').toUpperCase();
      if (!MAC_RE.test(sensorMac)) {
        return res.status(400).json({ error: 'sensor_mac is required for a sensor image' });
      }
      const sRes = await query(
        `SELECT s.id, s.mac, s.fw_version, d.mac AS hub_mac
           FROM sensors s JOIN devices d ON d.id = s.device_id
          WHERE s.mac = $1 AND s.active = TRUE`,
        [sensorMac]
      );
      if (sRes.rows.length === 0) return res.status(404).json({ error: 'Sensor not found' });
      const sensor = sRes.rows[0];

      publishSensorOtaCommand(sensor.hub_mac, {
        sensor_mac: sensor.mac,
        url: imageUrl(fw.sha256),
        version: fw.version,
        sha256: fw.sha256,
        signature: fw.signature,
      });

      await query(
        `UPDATE sensors
            SET ota_state = 'staged', ota_version = $1, ota_pct = 0,
                ota_error = NULL, ota_updated_at = NOW()
          WHERE id = $2`,
        [fw.version, sensor.id]
      );

      await audit({
        req, action: 'firmware.stage', targetType: 'sensor', targetId: sensor.id,
        details: { sensor_mac: sensor.mac, hub_mac: sensor.hub_mac,
                   version: fw.version, from_version: sensor.fw_version },
      });

      // Delivery waits for someone to press the button on the node -- a sensor
      // only listens for an offer on a button-press wake.
      return res.json({ staged: true, sensor_mac: sensor.mac, version: fw.version,
                        needs_button: true });
    }

    if (!hub_mac || !MAC_RE.test(hub_mac)) {
      return res.status(400).json({ error: 'hub_mac must be a MAC address' });
    }
    const mac = hub_mac.toUpperCase();
    const devRes = await query('SELECT id, fw_version FROM devices WHERE mac = $1', [mac]);
    if (devRes.rows.length === 0) return res.status(404).json({ error: 'Hub not registered' });

    publishOtaCommand(mac, {
      url: imageUrl(fw.sha256),
      version: fw.version,
      sha256: fw.sha256,
      signature: fw.signature,
    });

    // Optimistic local state; the hub overwrites it from ota/status within
    // seconds if it is online, and it stays "staged" if it never answers.
    await query(
      `UPDATE devices
          SET ota_state = 'staged', ota_version = $1, ota_pct = 0,
              ota_error = NULL, ota_updated_at = NOW()
        WHERE mac = $2`,
      [fw.version, mac]
    );

    await audit({
      req,
      action: 'firmware.stage',
      targetType: 'device',
      targetId: devRes.rows[0].id,
      details: { hub_mac: mac, version: fw.version, from_version: devRes.rows[0].fw_version },
    });

    res.json({ staged: true, hub_mac: mac, version: fw.version });
  } catch (err) {
    console.error('Stage firmware error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to stage firmware' });
  }
});

// DELETE /api/firmware/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM firmware_images WHERE id = $1 RETURNING sha256, version',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Firmware not found' });

    const { sha256, version } = result.rows[0];
    // Best-effort: a missing file must not block removing the record.
    await fs.unlink(path.join(FIRMWARE_DIR, `${sha256}.bin`)).catch(() => {});

    await audit({
      req,
      action: 'firmware.delete',
      targetType: 'firmware',
      targetId: req.params.id,
      details: { version, sha256 },
    });

    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete firmware error:', err.message);
    res.status(500).json({ error: 'Failed to delete firmware' });
  }
});

module.exports = router;
