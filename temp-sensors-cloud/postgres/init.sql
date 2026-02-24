-- ============================================================
-- Temp-sensors Cloud — PostgreSQL Schema
-- Run automatically on first `docker compose up` via
-- /docker-entrypoint-initdb.d/01-init.sql
-- ============================================================

-- Hub devices (one row per physical hub ESP32)
CREATE TABLE devices (
  id            SERIAL PRIMARY KEY,
  mac           VARCHAR(17) UNIQUE NOT NULL,   -- e.g. "AA:BB:CC:DD:EE:FF"
  name          VARCHAR(64),
  api_key       VARCHAR(64) UNIQUE NOT NULL,   -- MQTT password + app auth token
  registered_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sensor nodes paired to a hub
CREATE TABLE sensors (
  id        SERIAL PRIMARY KEY,
  device_id INT REFERENCES devices(id) ON DELETE CASCADE,
  mac       VARCHAR(17) NOT NULL,
  name      VARCHAR(64),
  paired_at TIMESTAMPTZ DEFAULT NOW(),
  active    BOOLEAN DEFAULT TRUE,
  UNIQUE (device_id, mac)
);

-- Time-series sensor readings
CREATE TABLE readings (
  id          BIGSERIAL PRIMARY KEY,
  sensor_id   INT REFERENCES sensors(id) ON DELETE CASCADE,
  temp        FLOAT,        -- °C; NULL if read error (-999 sentinel converted to NULL by backend)
  hum         FLOAT,        -- %; NULL if read error
  battery     SMALLINT,     -- 0–100; 255 = read error
  rssi        SMALLINT,     -- dBm
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON readings (sensor_id, recorded_at DESC);
-- To enable time-series partitioning (optional, requires TimescaleDB extension):
-- SELECT create_hypertable('readings', 'recorded_at');

-- Pending/resolved pairing requests
CREATE TABLE pairing_requests (
  id           SERIAL PRIMARY KEY,
  device_id    INT REFERENCES devices(id) ON DELETE CASCADE,
  slave_mac    VARCHAR(17) NOT NULL,
  status       VARCHAR(10) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  VARCHAR(64)
);
