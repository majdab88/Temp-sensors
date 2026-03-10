-- ============================================================
-- Migration: Add multi-user / multi-org support
-- Run manually on existing deployments:
--   docker exec -i postgres psql -U tempsensors -d tempsensors < postgres/02-add-users.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(64) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(12) DEFAULT 'owner' CHECK (role IN ('superadmin', 'owner', 'member')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organizations (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(128) NOT NULL,
  owner_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS organizations_owner_id_idx ON organizations (owner_id);

CREATE TABLE IF NOT EXISTS memberships (
  id        SERIAL PRIMARY KEY,
  user_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id    INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role      VARCHAR(10) DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS memberships_user_id_idx ON memberships (user_id);
CREATE INDEX IF NOT EXISTS memberships_org_id_idx ON memberships (org_id);

ALTER TABLE devices ADD COLUMN IF NOT EXISTS org_id INT REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS devices_org_id_idx ON devices (org_id);
