# Cloud Migration Plan — Temp-sensors System

## Goal

Migrate from a fully local system to a custom, self-hosted cloud solution that provides:

- Remote dashboard accessible from anywhere (not just the local network)
- Cloud-controlled pairing management (approve/reject from a web UI)
- Time-series data logging with historical charts
- WiFi provisioning via captive-portal AP (unchanged from current behaviour)

---

## Current vs Target Architecture

### Current

```
[Slave 1..N]  ──ESP-NOW──►  [Master ESP32-C6]  ──LAN──►  Browser (local only)
                               (local web server)
```

### Target

```
[Slave 1..N]  ──ESP-NOW──►  [Master ESP32-C6]
                               │  WiFiManager AP (unchanged, first boot only)
                               │  MQTT/TLS (new)
                               ▼
                         [Cloud Server]
                    ┌──────────┼──────────┐
              [Mosquitto]  [Backend]  [PostgreSQL]
                               │
                         [Dashboard]  ◄── Browser (anywhere)
```

Slaves never connect to the internet. All cloud communication goes through the master only.

---

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Device protocol | MQTT over TLS (port 8883) | Low overhead, bidirectional, perfect for IoT; master can receive commands |
| MQTT broker | Eclipse Mosquitto | Lightweight, battle-tested, Docker-friendly |
| Backend | Node.js 20 + Express | Wide ESP32 community examples; good MQTT/WS/SQL libs |
| Real-time push | Socket.IO (WebSocket) | Live dashboard updates without polling |
| Database | PostgreSQL 16 | Relational, solid; TimescaleDB extension optional for time-series queries |
| Frontend | React 18 + Vite + Chart.js | SPA, easy chart integration |
| Containers | Docker + Docker Compose | Reproducible deployment on any VPS |
| Reverse proxy / TLS | Nginx + Let's Encrypt | HTTPS for dashboard, WSS for Socket.IO |
| Master MQTT lib | PubSubClient (Arduino) | Mature, well-documented ESP32 MQTT client |
| Master TLS lib | WiFiClientSecure (built-in) | No new hardware required |

---

## Database Schema

```sql
-- Master devices (one row per physical master ESP32)
CREATE TABLE devices (
  id           SERIAL PRIMARY KEY,
  mac          VARCHAR(17) UNIQUE NOT NULL,   -- master MAC, e.g. "AA:BB:CC:DD:EE:FF"
  name         VARCHAR(64),
  api_key      VARCHAR(64) UNIQUE NOT NULL,   -- MQTT password / API credential
  registered_at TIMESTAMPTZ DEFAULT NOW()
);

-- Slave sensors paired to a master
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
  temp        FLOAT,          -- degrees C; NULL if read error
  hum         FLOAT,          -- %; NULL if read error
  battery     SMALLINT,       -- 0-100; 255 = read error
  rssi        SMALLINT,       -- dBm
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ON readings (sensor_id, recorded_at DESC);
-- Optional TimescaleDB: SELECT create_hypertable('readings', 'recorded_at');

-- Pending/resolved pairing requests
CREATE TABLE pairing_requests (
  id           SERIAL PRIMARY KEY,
  device_id    INT REFERENCES devices(id),
  slave_mac    VARCHAR(17) NOT NULL,
  status       VARCHAR(10) DEFAULT 'pending', -- pending | approved | rejected
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  VARCHAR(64)   -- dashboard user who acted
);
```

---

## MQTT Topic Structure

| Topic | Direction | Payload (JSON) | Description |
|-------|-----------|----------------|-------------|
| `sensors/{master_mac}/data` | Master → Cloud | `{slave_mac, temp, hum, battery, rssi, ts}` | Sensor reading |
| `sensors/{master_mac}/status` | Master → Cloud | `{online, ip, firmware, ts}` | Online/offline (also used as LWT) |
| `sensors/{master_mac}/pairing/request` | Master → Cloud | `{slave_mac, ts}` | New slave pairing request |
| `sensors/{master_mac}/pairing/response` | Cloud → Master | `{slave_mac, approved}` | Dashboard decision |
| `sensors/{master_mac}/command` | Cloud → Master | `{cmd, params}` | Reserved for future commands |

All topics use the master's MAC as a namespace so multiple masters can coexist.

---

## REST API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Dashboard login → returns JWT |
| GET | `/api/devices` | List registered masters |
| POST | `/api/devices/register` | Register a new master (generates API key) |
| GET | `/api/sensors` | List all sensors (all masters) |
| PUT | `/api/sensors/:id` | Rename a sensor |
| DELETE | `/api/sensors/:id` | Remove a sensor |
| GET | `/api/sensors/:id/readings` | Historical readings (`?from=&to=&limit=`) |
| GET | `/api/sensors/:id/readings/latest` | Most recent reading |
| GET | `/api/pairing/requests?status=pending` | List pairing requests |
| POST | `/api/pairing/requests/:id/approve` | Approve a pairing request |
| POST | `/api/pairing/requests/:id/reject` | Reject a pairing request |

---

## Cloud Project Folder Structure

```
temp-sensors-cloud/
├── docker-compose.yml
├── nginx/
│   └── nginx.conf                  # Reverse proxy, HTTPS redirect, WebSocket passthrough
├── mosquitto/
│   ├── mosquitto.conf              # TLS, auth, ACL
│   └── passwd                      # Hashed broker credentials
├── backend/
│   ├── package.json
│   └── src/
│       ├── index.js                # Express server + Socket.IO init
│       ├── mqtt.js                 # MQTT bridge: subscribe, persist, forward to WS
│       ├── db.js                   # PostgreSQL pool + query helpers
│       ├── routes/
│       │   ├── auth.js
│       │   ├── devices.js
│       │   ├── sensors.js
│       │   ├── readings.js
│       │   └── pairing.js
│       └── middleware/
│           └── auth.js             # JWT validation middleware
└── frontend/
    ├── package.json
    └── src/
        ├── App.jsx
        ├── pages/
        │   ├── Dashboard.jsx       # Live sensor grid (Socket.IO)
        │   ├── History.jsx         # Per-sensor chart (Chart.js)
        │   ├── Pairing.jsx         # Pending requests, approve/reject
        │   └── Devices.jsx         # Master management
        └── components/
            ├── SensorCard.jsx
            ├── ReadingChart.jsx
            └── PairingPanel.jsx
```

---

## Firmware Changes — Master (`Temp32_master.ino`)

### New Libraries

| Library | Purpose |
|---------|---------|
| `PubSubClient` | MQTT client |
| `WiFiClientSecure` | TLS socket (built-in) |

### New NVS Keys (stored via `Preferences`)

| Key (namespace: `cloud`) | Type | Description |
|--------------------------|------|-------------|
| `mqtt_host` | String | MQTT broker hostname / IP |
| `mqtt_port` | Int | Default 8883 |
| `mqtt_user` | String | Device MQTT username (= master MAC) |
| `mqtt_pass` | String | Device API key from cloud registration |

### Behaviour Changes

1. **WiFi provisioning** — unchanged. WiFiManager captive portal.

   Optional enhancement: add custom parameters to the WiFiManager portal for
   MQTT host, MQTT user, MQTT password so the device is fully provisioned
   in a single step without a separate `/provision` call.

2. **After WiFi connects** — load MQTT credentials from NVS, connect to broker
   with TLS, subscribe to `sensors/{mac}/pairing/response` and
   `sensors/{mac}/command`.

3. **On sensor data received from slave** — publish to
   `sensors/{mac}/data` in addition to updating local memory / local dashboard.

4. **On pairing request received from slave**:
   - If cloud connected: publish to `sensors/{mac}/pairing/request`,
     start 60-second timer waiting for a `pairing/response` message.
   - If cloud disconnected: fall back to auto-accept (current behaviour)
     to avoid stranding sensors when internet is unavailable.

5. **On `pairing/response` received from cloud**:
   - `approved = true`: complete the ESP-NOW handshake (same as today).
   - `approved = false`: do not register the peer; slave retries on next boot.

6. **Last Will and Testament (LWT)** — configure Mosquitto LWT on connect:
   `sensors/{mac}/status` with payload `{online: false}` so the cloud marks
   the device offline automatically if MQTT drops.

7. **Local web server** — kept as-is. It remains useful as a LAN fallback
   when internet is unavailable.

### New local endpoint

`POST /provision`
Accepts JSON body `{mqtt_host, mqtt_port, mqtt_user, mqtt_pass}`, writes to NVS,
responds 200, restarts. Allows post-deployment reconfiguration without
reflashing.

---

## Firmware Changes — Slave (`Temp32_slave.ino`)

**No changes required.** The slave communicates only via ESP-NOW to the master.
All cloud interaction is the master's responsibility.

---

## WiFi AP Provisioning Flow (Unchanged)

```
First boot:
  1. Master creates AP "Temp-sensor-Master" (password: 12345678)
  2. User connects a phone or laptop to that AP
  3. WiFiManager captive portal opens automatically
  4. User enters WiFi SSID + password
     (+ optionally MQTT host/user/pass via custom portal params)
  5. Master saves credentials to NVS, restarts, connects to WiFi + cloud
```

---

## Cloud-Controlled Pairing Flow

```
Slave            Master             Cloud Backend     Dashboard
  │                │                     │                │
  │─── ESP-NOW ───►│                     │                │
  │  MSG_PAIRING   │                     │                │
  │                │─── MQTT publish ───►│                │
  │                │   pairing/request   │                │
  │                │                     │── WebSocket ──►│
  │                │                     │  show pending  │
  │                │                     │                │
  │                │                     │◄── approve ────│
  │                │◄── MQTT subscribe ──│                │
  │                │   pairing/response  │                │
  │                │   {approved: true}  │                │
  │◄─── ESP-NOW ───│                     │                │
  │  MSG_PAIRING   │                     │                │
  │  (confirm)     │                     │                │
```

- If no response arrives within **60 seconds**, the master auto-rejects.
- The slave will retry pairing on its next wake cycle.
- If the cloud is unreachable, the master falls back to auto-accept.

---

## Security Checklist

| Item | Implementation |
|------|---------------|
| Transport encryption | MQTT over TLS (port 8883); HTTPS for dashboard and API |
| MQTT authentication | Per-device username + password; ACL restricts each device to its own topics |
| API authentication | JWT (1 h access token, 7 d refresh token) for dashboard |
| HTTPS certificate | Let's Encrypt via Certbot, auto-renewed |
| XSS prevention | Sensor names sanitised before rendering; React escapes by default |
| SQL injection | Parameterised queries only (no raw string concatenation) |
| Rate limiting | 60 req/min per IP on login endpoint; 600 req/min on other endpoints |
| Secret management | `.env` file excluded from git; never commit API keys or WiFi credentials |
| Database isolation | PostgreSQL not exposed outside Docker network |
| PMK/LMK keys | Unchanged; must be replaced before production (see CLAUDE.md) |

---

## Migration Phases

### Phase 1 — Cloud Infrastructure

1. Provision a VPS (1 GB RAM minimum; Hetzner/DigitalOcean/Linode all work).
2. Install Docker and Docker Compose.
3. Write `docker-compose.yml` with services: `mosquitto`, `postgres`, `backend`, `frontend` (Nginx).
4. Configure Mosquitto:
   - TLS with Let's Encrypt certificate.
   - Password file with one entry per master device.
   - ACL file restricting each device to `sensors/{its_mac}/#`.
5. Point a domain to the VPS; obtain Let's Encrypt certificate.
6. Initialise the PostgreSQL schema.

**Deliverable:** `docker-compose.yml`, `mosquitto/`, Postgres init SQL, bare Nginx config.

---

### Phase 2 — Backend API

1. Scaffold Node.js + Express project.
2. MQTT bridge in `mqtt.js`:
   - Subscribe to `sensors/+/data`, `sensors/+/status`, `sensors/+/pairing/request`.
   - On `data`: upsert sensor row, insert reading row, emit via Socket.IO to dashboard.
   - On `pairing/request`: insert `pairing_requests` row (status = pending), emit to dashboard.
   - On `pairing/response` decision: publish to broker, update `pairing_requests` row.
3. REST routes (see endpoint table above).
4. JWT middleware for all routes except `/api/auth/login`.
5. Socket.IO room per master MAC for targeted live updates.

**Deliverable:** Working backend that persists data from MQTT and exposes REST + WebSocket.

---

### Phase 3 — Dashboard Frontend

1. React SPA with four pages:
   - **Dashboard** — live sensor grid (Socket.IO), status badges, battery bars.
   - **History** — select a sensor + time range, render a Chart.js line chart.
   - **Pairing** — list pending requests; Approve / Reject buttons that hit the REST API.
   - **Devices** — list registered masters, show online/offline, copy API key.
2. Responsive layout (mobile-friendly).
3. Login screen with JWT storage in `localStorage` (or `httpOnly` cookie).

**Deliverable:** Vite build served by Nginx container.

---

### Phase 4 — Master Firmware Update

1. Add `PubSubClient` to the Arduino sketch.
2. Add `loadCloudConfig()` helper (reads MQTT credentials from NVS).
3. Add `connectCloud()` helper (TLS connect + subscribe + LWT setup).
4. Modify `OnDataRecv` pairing branch to call `publishPairingRequest()` and
   wait on a semaphore/flag that the MQTT callback sets.
5. Add `publishSensorData()` called from the existing `updateSensor()` path.
6. Add `/provision` HTTP endpoint.
7. Optionally add WiFiManager custom parameters for MQTT credentials.

**File modified:** `Temp32_master.ino`
**New library:** `PubSubClient` (install via Arduino Library Manager).

---

### Phase 5 — Testing & Cutover

1. Flash the updated master firmware to a test device.
2. Verify sensor readings appear in the cloud database and dashboard.
3. Verify the pairing flow works end-to-end (new slave → pending in UI → approve → slave starts sending data).
4. Verify the local web server still works as LAN fallback.
5. Verify the master reconnects to MQTT automatically after a broker restart.
6. Verify LWT marks the device offline in the dashboard when the master loses power.
7. Cutover remaining master devices.

---

## What Changes vs What Stays

| Component | Status | Notes |
|-----------|--------|-------|
| Slave firmware | **Unchanged** | No internet access required |
| Master — WiFiManager AP | **Unchanged** | WiFi provisioning identical |
| Master — ESP-NOW receive | **Unchanged** | Protocol unchanged |
| Master — local web server | **Kept** | LAN fallback, no removal needed |
| Master — MQTT uplink | **New** | Requires `PubSubClient` + NVS creds |
| Master — cloud pairing gate | **Modified** | Was auto-accept; now cloud-gated with local fallback |
| Cloud backend | **New** | Node.js + PostgreSQL + Mosquitto |
| Cloud dashboard | **New** | React SPA served by Nginx |
| PMK / LMK keys | **Unchanged** | Must be rotated before production (see CLAUDE.md) |

---

## Open Decisions (Resolve Before Implementation)

| Question | Options | Recommendation |
|----------|---------|---------------|
| Cloud host | Self-hosted VPS vs AWS/GCP managed | Self-hosted VPS (most control, fixed cost) |
| Database scale | Plain PostgreSQL vs TimescaleDB | Plain PostgreSQL for now; add TimescaleDB if queries slow down after millions of rows |
| WiFiManager MQTT params | Add MQTT params to portal vs use `/provision` endpoint | Add to portal — simplest single-step setup |
| Pairing fallback policy | Auto-accept vs auto-reject when cloud unreachable | Auto-accept; avoids stranding sensors during outages |
| Dashboard auth | Single admin account vs multi-user | Single admin for V1 |
| Data retention | Keep all readings vs prune after N days | 90-day rolling window, configurable |
