-- ============================================================
-- Migration: Add permission levels and audit logging
-- Run manually on existing deployments:
--   docker exec -i postgres psql -U tempsensors -d tempsensors < postgres/03-permissions-audit.sql
-- ============================================================

-- Replace boolean permission columns with a single tiered level:
--   viewer  = read-only (view devices, sensors, readings)
--   editor  = viewer + rename/delete devices & sensors, approve/reject pairing
--   admin   = editor + invite/remove members, full org control
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS permission_level VARCHAR(10) DEFAULT 'viewer'
  CHECK (permission_level IN ('viewer', 'editor', 'admin'));

-- Migrate existing boolean permissions to the new level
-- Members with can_manage_members → admin
-- Members with can_manage_devices or can_approve_pairing → editor
-- Everyone else → viewer (already the default)
UPDATE memberships SET permission_level = 'admin'
  WHERE role = 'member' AND can_manage_members = TRUE;
UPDATE memberships SET permission_level = 'editor'
  WHERE role = 'member' AND permission_level = 'viewer'
    AND (can_manage_devices = TRUE OR can_approve_pairing = TRUE);

-- Owners get admin level
UPDATE memberships SET permission_level = 'admin' WHERE role = 'owner';

-- Drop old boolean columns
ALTER TABLE memberships DROP COLUMN IF EXISTS can_manage_members;
ALTER TABLE memberships DROP COLUMN IF EXISTS can_manage_devices;
ALTER TABLE memberships DROP COLUMN IF EXISTS can_approve_pairing;
ALTER TABLE memberships DROP COLUMN IF EXISTS can_view_readings;

-- Audit log — tracks user actions for accountability
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  username    VARCHAR(64),
  org_id      INT REFERENCES organizations(id) ON DELETE SET NULL,
  action      VARCHAR(64) NOT NULL,
  target_type VARCHAR(32),
  target_id   VARCHAR(64),
  details     JSONB,
  ip          VARCHAR(45),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_org_id_idx ON audit_log (org_id);
CREATE INDEX IF NOT EXISTS audit_log_user_id_idx ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action);
