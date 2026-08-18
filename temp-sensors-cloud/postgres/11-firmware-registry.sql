-- ============================================================
-- Migration: firmware registry + hub OTA state (Phase 1)
-- Run manually on existing deployments:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < postgres/11-firmware-registry.sql
-- ============================================================

-- Uploaded, signed firmware images. The binary itself lives on disk at
-- ${FIRMWARE_DIR}/<sha256>.bin and is served statically by nginx; only metadata
-- is stored here.
--
-- sha256 is computed by the backend from the uploaded bytes, never supplied by
-- the client — that removes "pasted the wrong hash" as a failure mode entirely.
-- It doubles as the storage filename, so uploading the same image twice is
-- idempotent rather than producing duplicates.
CREATE TABLE IF NOT EXISTS firmware_images (
  id          SERIAL PRIMARY KEY,
  device_kind VARCHAR(16)  NOT NULL DEFAULT 'hub',   -- 'hub' | 'sensor'
  version     VARCHAR(16)  NOT NULL,
  size        INT          NOT NULL,
  sha256      CHAR(64)     NOT NULL UNIQUE,
  signature   TEXT         NOT NULL,                 -- base64 DER ECDSA P-256
  notes       TEXT,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  created_by  INT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS firmware_images_kind_created_idx
  ON firmware_images (device_kind, created_at DESC);

-- Live OTA state per hub, driven by the hub's own ota/status messages.
-- ota_state mirrors the firmware: accepted / downloading / verifying /
-- rebooting / confirmed / failed / uptodate.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS ota_state      VARCHAR(16),
  ADD COLUMN IF NOT EXISTS ota_version    VARCHAR(16),
  ADD COLUMN IF NOT EXISTS ota_pct        INT,
  ADD COLUMN IF NOT EXISTS ota_error      TEXT,
  ADD COLUMN IF NOT EXISTS ota_updated_at TIMESTAMPTZ;
