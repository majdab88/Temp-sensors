'use strict';

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs/promises');
const path    = require('path');
const { query } = require('../db');
const { requireAuth, requireSuperadmin } = require('../middleware/auth');
const { audit } = require('../audit');
const { publishOtaCommand } = require('../mqtt');

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
  const pem = process.env.FW_PUBLIC_KEY_PEM;
  if (!pem) return { checked: false, valid: null };
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

      const result = await query(
        `INSERT INTO firmware_images (device_kind, version, size, sha256, signature, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (sha256) DO UPDATE
           SET version = EXCLUDED.version,
               signature = EXCLUDED.signature,
               notes = EXCLUDED.notes
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
  const { hub_mac } = req.body || {};
  if (!hub_mac || !MAC_RE.test(hub_mac)) {
    return res.status(400).json({ error: 'hub_mac must be a MAC address' });
  }

  try {
    const fwRes = await query(
      'SELECT id, device_kind, version, sha256, signature FROM firmware_images WHERE id = $1',
      [req.params.id]
    );
    if (fwRes.rows.length === 0) return res.status(404).json({ error: 'Firmware not found' });
    const fw = fwRes.rows[0];

    if (fw.device_kind !== 'hub') {
      return res.status(400).json({ error: 'Only hub images can be staged (sensor OTA is not implemented)' });
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
