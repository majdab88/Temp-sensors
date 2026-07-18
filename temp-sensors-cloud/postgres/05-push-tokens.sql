-- ============================================================
-- Migration: Expo push notification tokens (phase 2)
-- Run manually on existing deployments:
--   docker exec -i postgres psql -U tempsensors -d tempsensors < postgres/05-push-tokens.sql
-- ============================================================

-- One row per device push token. `token` is globally unique — if the same
-- device (token) is later used by a different account, register upserts the
-- user_id so the token always points at its current owner.
CREATE TABLE IF NOT EXISTS push_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      VARCHAR(255) UNIQUE NOT NULL,   -- Expo push token: ExponentPushToken[...]
  platform   VARCHAR(10),                     -- ios | android
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS push_tokens_user_id_idx ON push_tokens (user_id);
