-- ============================================================
-- Migration: per-user WhatsApp phone number (phase 3)
-- Run manually on existing deployments:
--   docker exec -i postgres psql -U tempsensors -d tempsensors < postgres/06-user-phone.sql
-- ============================================================

-- E.164 format, e.g. +972541234567. Used as the WhatsApp recipient for alerts
-- when a rule's channels include 'whatsapp'.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
