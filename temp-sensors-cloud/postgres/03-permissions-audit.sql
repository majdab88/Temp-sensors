-- ============================================================
-- Migration: Add granular permissions and audit logging
-- Run manually on existing deployments:
--   docker exec -i postgres psql -U tempsensors -d tempsensors < postgres/03-permissions-audit.sql
-- ============================================================

-- Granular permissions per membership
-- Each permission defaults to FALSE; owners get all TRUE on creation.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS can_manage_members  BOOLEAN DEFAULT FALSE;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS can_manage_devices  BOOLEAN DEFAULT FALSE;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS can_approve_pairing BOOLEAN DEFAULT FALSE;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS can_view_readings   BOOLEAN DEFAULT TRUE;

-- Grant all permissions to existing owners
UPDATE memberships
SET can_manage_members  = TRUE,
    can_manage_devices  = TRUE,
    can_approve_pairing = TRUE,
    can_view_readings   = TRUE
WHERE role = 'owner';

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
