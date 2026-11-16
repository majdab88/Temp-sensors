-- ============================================================
-- Migration: revocable sessions
-- Run manually on existing deployments:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < postgres/18-token-version.sql
-- ============================================================
--
-- Tokens carry the user's token_version and are honoured only while it matches.
-- Bumping it (password change, admin password reset) ends every session the
-- user has. Before this, a deleted user or a stolen token kept working for the
-- 7-day life of a refresh token.
--
-- Apply BEFORE deploying the backend that reads it: without the column every
-- login and every authenticated request fails.

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
