-- Live mode visibility.
--
-- A live request could be sent but never observed: the dashboard knew it had
-- asked, and nothing more. These columns separate the two states that matter to
-- someone watching a card -- "asked, waiting for the node to wake" and "the node
-- is awake and reporting now" -- so the UI can show which one it is.

ALTER TABLE sensors ADD COLUMN IF NOT EXISTS live_requested_at TIMESTAMPTZ;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS live_until        TIMESTAMPTZ;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS live_interval_s   INTEGER;
