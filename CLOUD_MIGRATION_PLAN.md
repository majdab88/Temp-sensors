# Cloud Migration Plan — Temp-sensors System

## Goal

Migrate from a fully local system to a custom, self-hosted cloud solution that provides:

- Remote dashboard accessible from anywhere (not just the local network)
- Cloud-controlled pairing management (approve/reject from a web UI)
- Time-series data logging with historical charts
- **App-based BLE provisioning** — end user provisions WiFi credentials from a
  mobile app with no IP addresses, no captive portals, and no network switching

---

## Current vs Target Architecture

### Current

```
[Sensor 1..N]  ──ESP-NOW──►  [Hub ESP32-C6]  ──LAN──►  Browser (local only)
                               WiFiManager AP (first boot)
```

### Target

```
[Phone App]  ──BLE──►  [Hub ESP32-C6]  ──MQTT/TLS──►  [Cloud Server]
(provisioning)           ││                       ┌────────┼────────┐
                         ││ ESP-NOW            [Mosquitto][Backend][PostgreSQL]
                         ▼▼                                │
                   [Sensor 1..N]                     [Web Dashboard]
                                                      (browser, anywhere)
```

Sensors never connect to the internet. All cloud communication goes through the
hub only. BLE is used only during the initial setup; after provisioning the
hub operates over WiFi exclusively.

---

## Technology Stack

### Cloud + Firmware

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Device–cloud protocol | MQTT over TLS (port 8883) | Low overhead, bidirectional, perfect for IoT |
| MQTT broker | Eclipse Mosquitto | Lightweight, battle-tested, Docker-friendly |
| Backend | Node.js 20 + Express | Good MQTT/WS/SQL libs; shares JS knowledge with frontend |
| Real-time push | Socket.IO (WebSocket) | Live dashboard updates without polling |
| Database | PostgreSQL 16 | Solid relational DB; TimescaleDB extension optional |
| Frontend | React 18 + Vite + Chart.js | SPA, easy charts, same language as backend |
| Containers | Docker + Docker Compose | Reproducible deployment on any VPS |
| Reverse proxy / TLS | Nginx + Let's Encrypt | HTTPS + WSS |
| Master MQTT lib | PubSubClient (Arduino) | Mature ESP32 MQTT client |
| Master TLS lib | WiFiClientSecure (built-in) | No extra hardware |

### Mobile Provisioning App

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | React Native + Expo | Cross-platform (iOS + Android); shares React knowledge with web dashboard |
| BLE | `react-native-ble-plx` | Most widely used RN BLE library; works with Expo dev client |
| HTTP | `axios` | REST calls to cloud backend for device registration + API key fetch |
| Hub BLE lib | **NimBLE-Arduino** | Replaces WiFiManager; much lighter than Bluedroid (~50 KB vs ~300 KB RAM) |

> **Alternative app framework:** Flutter + `flutter_blue_plus` is equally viable
> if you prefer Dart. Choose based on team familiarity.

---

## BLE Provisioning Protocol

The master advertises a custom GATT service while in provisioning mode.

### Device Advertisement Name

```
TempHub-AABBCC    (last 3 octets of MAC, uppercase)
```

This lets the app list multiple devices unambiguously and lets the user identify
which physical unit they are setting up.

### GATT Service

| Item | Value |
|------|-------|
| Service UUID | `4fafc201-1fb5-459e-8fcc-c5c9c331914b` |
| Security | BLE bonding required before any write (prevents rogue devices from pushing credentials) |

### Characteristics

| Name | UUID | Properties | Payload |
|------|------|------------|---------|
| `PROV_WIFI` | `beb5483e-36e1-4688-b7f5-ea07361b26a8` | Write | `{"ssid":"...","pass":"..."}` |
| `PROV_CLOUD` | `1c95d5e3-d8f7-413a-bf3d-7a2e5d7be87e` | Write | `{"host":"...","port":8883,"user":"...","pass":"..."}` |
| `PROV_STATUS` | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | Read + Notify | `{"state":"idle"\|"connecting"\|"connected"\|"failed","detail":"..."}` |
| `PROV_NETWORKS` | `d5913036-2d8a-41ee-85b9-4e361aa5c8a3` | Write + Notify | Write any byte to trigger scan; notifies with `{"networks":[{"ssid":"...","rssi":-45,"enc":3},...]}` |

`enc` values map to `wifi_auth_mode_t`: `0` = open (no password), non-zero = secured (WPA/WPA2/WPA3).
Results are sorted by RSSI descending and capped at the top 10 networks to stay within the 512-byte BLE MTU.

The master notifies `PROV_STATUS` as it progresses so the app can show a live
status indicator without polling.

### Provisioning State Machine (firmware)

```
[Boot]
  │
  ├─ WiFi creds in NVS? ──Yes──► Connect to WiFi ──► Normal operation
  │
  └─ No ──► Start BLE advertising ("TempHub-AABBCC")
                │
                ├─ App writes PROV_WIFI ──► save SSID+pass to NVS
                ├─ App writes PROV_CLOUD ──► save MQTT creds to NVS
                └─ Notify PROV_STATUS "connecting"
                         │
                         ├─ WiFi OK + MQTT OK ──► Notify "connected" ──► stop BLE ──► Normal
                         └─ Failure ──► Notify "failed" ──► keep advertising
```

**BOOT button held 3 s** at any time: erase WiFi + cloud NVS keys → restart →
device re-enters BLE provisioning mode. This is the reset / re-provisioning path
for end users.

---

## Mobile App — Provisioning + Monitoring

The app serves two purposes: initial device provisioning (BLE) and ongoing
remote monitoring / pairing control (cloud REST + WebSocket).

### Screens

| Screen | Description |
|--------|-------------|
| **Login** | Authenticate to the cloud backend; JWT stored securely |
| **Home / Dashboard** | Live sensor grid for all paired sensors (Socket.IO) |
| **Add Device** | BLE scan → select device → enter WiFi creds → auto-fetch MQTT creds from cloud → push via BLE → show progress |
| **Sensor History** | Chart.js line chart for a selected sensor (24 h / 7 d / 30 d) |
| **Pairing Requests** | Pending sensor pairing requests; Approve / Reject |
| **Settings** | Rename sensors, remove devices, account |

### Add Device Flow (end-user perspective)

```
1. Tap "Add Device"
2. App scans BLE → shows list of nearby "TempHub-XXXXXX" devices
3. User taps the correct device
4. App prompts: "Enter your WiFi network name and password"
5. User types SSID + password → taps "Connect"
6. App calls backend: POST /api/devices/register → receives MQTT API key
7. App writes PROV_WIFI then PROV_CLOUD to device via BLE
8. App subscribes to PROV_STATUS notifications
9. Progress bar: "Connecting to WiFi..." → "Connecting to cloud..." → "Done!"
10. App navigates to Home; device appears online
```

The user never sees an IP address, never switches WiFi networks, never
types a URL.

### App Project Structure

```
temp-sensors-app/
├── app.json                        # Expo config
├── package.json
└── src/
    ├── App.tsx
    ├── navigation/
    │   └── AppNavigator.tsx
    ├── screens/
    │   ├── LoginScreen.tsx
    │   ├── DashboardScreen.tsx
    │   ├── AddDeviceScreen.tsx     # BLE scan + provisioning flow (hub)
    │   ├── HistoryScreen.tsx
    │   ├── PairingScreen.tsx
    │   └── SettingsScreen.tsx
    ├── services/
    │   ├── ble.ts                  # react-native-ble-plx wrapper; scan, connect, write, notify
    │   ├── api.ts                  # axios wrapper for cloud REST calls
    │   └── socket.ts               # Socket.IO client for live updates
    └── components/
        ├── SensorCard.tsx
        ├── ReadingChart.tsx
        └── PairingCard.tsx
```

---

## Database Schema

```sql
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
  temp        FLOAT,        -- °C; NULL if read error
  hum         FLOAT,        -- %; NULL if read error
  battery     SMALLINT,     -- 0–100; 255 = read error
  rssi        SMALLINT,     -- dBm
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ON readings (sensor_id, recorded_at DESC);
-- Optional: SELECT create_hypertable('readings', 'recorded_at');  -- TimescaleDB

-- Pending/resolved pairing requests
CREATE TABLE pairing_requests (
  id           SERIAL PRIMARY KEY,
  device_id    INT REFERENCES devices(id),
  slave_mac    VARCHAR(17) NOT NULL,
  status       VARCHAR(10) DEFAULT 'pending',  -- pending | approved | rejected
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  VARCHAR(64)
);
```

---

## MQTT Topic Structure

| Topic | Direction | Payload (JSON) | Description |
|-------|-----------|----------------|-------------|
| `sensors/{hub_mac}/data` | Hub → Cloud | `{sensor_mac, temp, hum, battery, rssi, ts}` | Sensor reading |
| `sensors/{hub_mac}/status` | Hub → Cloud | `{online, ip, ts}` | Online/offline + LWT |
| `sensors/{hub_mac}/pairing/request` | Hub → Cloud | `{sensor_mac}` | New sensor pairing request |
| `sensors/{hub_mac}/pairing/response` | Cloud → Hub | `{sensor_mac, approved}` | Dashboard/app decision |
| `sensors/{hub_mac}/sync/request` | Hub → Cloud | `{sensors:[{mac, name}, …]}` | Hub reports its local list on every MQTT connect; cloud diffs and replies |
| `sensors/{hub_mac}/sync` | Cloud → Hub | `{sensors:[{mac, name}, …]}` | Cloud pushes authoritative list; hub adds/removes/renames to match |
| `sensors/{hub_mac}/sensor/remove` | Cloud → Hub | `{sensor_mac}` | Cloud removes one sensor; hub deletes from memory, peer table, and NVS |
| `sensors/{hub_mac}/sensor/rename` | Cloud → Hub | `{sensor_mac, name}` | Cloud renames a sensor; hub updates memory and NVS |
| `sensors/{hub_mac}/sensor/renamed` | Hub → Cloud | `{sensor_mac, name}` | Hub notifies cloud of a rename made via the local web dashboard |
| `sensors/{hub_mac}/sensor/deleted` | Hub → Cloud | `{sensor_mac}` | Hub notifies cloud of a deletion made via the local web dashboard |
| `sensors/{hub_mac}/command` | Cloud → Hub | `{cmd, params}` | Reserved for future commands |

---

## REST API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | App/dashboard login → JWT |
| GET | `/api/devices` | List registered hubs |
| POST | `/api/devices/register` | Register new hub; returns generated API key (called by app during BLE provisioning) |
| GET | `/api/sensors` | List all sensors |
| PUT | `/api/sensors/:id` | Rename sensor |
| DELETE | `/api/sensors/:id` | Remove sensor |
| GET | `/api/sensors/:id/readings` | Historical readings (`?from=&to=&limit=`) |
| GET | `/api/sensors/:id/readings/latest` | Most recent reading |
| GET | `/api/pairing/requests?status=pending` | List pairing requests |
| POST | `/api/pairing/requests/:id/approve` | Approve pairing |
| POST | `/api/pairing/requests/:id/reject` | Reject pairing |

---

## Cloud Project Folder Structure

```
temp-sensors-cloud/
├── docker-compose.yml
├── nginx/
│   └── nginx.conf                  # Reverse proxy, HTTPS, WebSocket passthrough
├── mosquitto/
│   ├── mosquitto.conf              # TLS, per-device auth, ACL
│   └── passwd                      # Hashed broker credentials
├── backend/
│   ├── package.json
│   └── src/
│       ├── index.js                # Express + Socket.IO
│       ├── mqtt.js                 # MQTT bridge: subscribe → persist → WS push
│       ├── db.js                   # PostgreSQL pool + query helpers
│       ├── routes/
│       │   ├── auth.js
│       │   ├── devices.js
│       │   ├── sensors.js
│       │   ├── readings.js
│       │   └── pairing.js
│       └── middleware/
│           └── auth.js             # JWT validation
└── frontend/                       # Web dashboard (admin / power users)
    ├── package.json
    └── src/
        ├── App.jsx
        ├── pages/
        │   ├── Dashboard.jsx
        │   ├── History.jsx
        │   ├── Pairing.jsx
        │   └── Devices.jsx
        └── components/
            ├── SensorCard.jsx
            ├── ReadingChart.jsx
            └── PairingPanel.jsx
```

---

## Firmware Changes — Master (`Temp32_master.ino`)

### Libraries Changed

| Change | Library | Notes |
|--------|---------|-------|
| **Remove** | `WiFiManager` | Replaced by BLE provisioning |
| **Add** | `NimBLE-Arduino` | BLE GATT server for provisioning; install via Arduino Library Manager |
| **Add** | `PubSubClient` | MQTT client; install via Arduino Library Manager |
| Add | `WiFiClientSecure` | TLS socket; already built into ESP32 core |
| Add | `ESPmDNS` | `http://temp-master.local/` for LAN fallback; built into ESP32 core |

### NVS Keys

| Namespace | Key | Type | Written by | Description |
|-----------|-----|------|-----------|-------------|
| `wifi` | `ssid` | String | BLE provisioning | WiFi network name |
| `wifi` | `pass` | String | BLE provisioning | WiFi password |
| `cloud` | `mqtt_host` | String | BLE provisioning | MQTT broker hostname |
| `cloud` | `mqtt_port` | Int | BLE provisioning | Default 8883 |
| `cloud` | `mqtt_user` | String | BLE provisioning | Device username (= MAC) |
| `cloud` | `mqtt_pass` | String | BLE provisioning | API key from cloud |
| `sensors` | `mac0`…`mac9` | Bytes | Auto (pairing) | Saved sensor MACs |
| `sensors` | `count` | Int | Auto (pairing) | Number of saved sensors |

### Behaviour Changes

1. **Boot** — check `wifi/ssid` in NVS.
   - Not found → start NimBLE GATT server, advertise as `TempHub-AABBCC`.
   - Found → call `WiFi.begin(ssid, pass)` directly (no WiFiManager).

2. **BLE provisioning mode**:
   - Advertise GATT service with `PROV_WIFI`, `PROV_CLOUD`, `PROV_STATUS`
     characteristics.
   - On `PROV_WIFI` write: parse JSON, save `ssid` + `pass` to NVS.
   - On `PROV_CLOUD` write: parse JSON, save MQTT credentials to NVS.
     Notify `PROV_STATUS` = `"connecting"`.
   - Call `WiFi.begin()` + `connectCloud()`. On success: notify `"connected"`,
     stop BLE advertising. On failure: notify `"failed"`, keep advertising.

3. **After WiFi connects** — start mDNS (`MDNS.begin("temp-hub")`), then
   connect to MQTT broker with TLS, subscribe to
   `sensors/{mac}/pairing/response`, `sensors/{mac}/sync`,
   `sensors/{mac}/sensor/remove`, `sensors/{mac}/sensor/rename`,
   and `sensors/{mac}/command`.

4. **On sensor data received from sensor node** — publish to `sensors/{mac}/data`;
   update local in-memory store and local web server.

4a. **On MQTT connect** — publish current local sensor list to
    `sensors/{mac}/sync/request`; cloud responds on `sensors/{mac}/sync` with its
    authoritative list; hub reconciles (adds/removes/renames) to match the cloud.

5. **On pairing request received from sensor node**:
   - Cloud connected: publish to `sensors/{mac}/pairing/request`, wait up to
     60 s for `pairing/response`.
   - Cloud disconnected: fall back to auto-accept.

6. **On `pairing/response` from cloud**:
   - `approved = true`: complete ESP-NOW handshake as today.
   - `approved = false`: do not register peer; sensor retries on next boot.

7. **LWT** — set Last Will `sensors/{mac}/status` = `{online:false}` on MQTT
   connect so the cloud marks the device offline if MQTT drops unexpectedly.

8. **BOOT button held 3 s** — erase `wifi` and `cloud` NVS namespaces, restart
   → device re-enters BLE provisioning mode. (Same GPIO9 / `checkFactoryReset()`
   pattern; existing sensor reset logic is unaffected.)

9. **Local web server** — kept as-is; useful for LAN power users via
   `http://temp-hub.local/`.

---

## Firmware Changes — Sensor (`Temp32_sensor.ino`)

**No changes required.** Sensors communicate only via ESP-NOW to the hub.

---

## BLE Provisioning Flow (end-to-end)

```
Phone App               Hub ESP32                 Cloud Backend
    │                        │                         │
    │  BLE scan              │                         │
    │─────────────────────►  │ advertising             │
    │  "TempHub-AABBCC"      │ TempHub-AABBCC          │
    │                        │                         │
    │  connect + bond        │                         │
    │◄──────────────────────►│                         │
    │                        │                         │
    │  POST /devices/register│                         │
    │──────────────────────────────────────────────►   │
    │◄──────────────────────────────────────────────   │
    │  { api_key: "..." }    │                         │
    │                        │                         │
    │  write PROV_WIFI       │                         │
    │  {ssid, pass}          │                         │
    │──────────────────────► │ save to NVS             │
    │                        │                         │
    │  write PROV_CLOUD      │                         │
    │  {host,port,user,pass} │                         │
    │──────────────────────► │ save to NVS             │
    │                        │ notify "connecting"     │
    │◄──────────────────────  │                         │
    │                        │──── WiFi.begin ─────────│
    │                        │──── MQTT connect ──────►│
    │                        │                        │
    │                        │ notify "connected"      │
    │◄──────────────────────  │                         │
    │                        │                         │
    │  App shows "Done!"     │  BLE advertising stops  │
    │  Navigates to dashboard│  Normal operation       │
```

---

## Cloud-Controlled Pairing Flow

```
Sensor Node      Hub ESP32          Cloud Backend     App / Dashboard
  │                │                     │                │
  │─── ESP-NOW ───►│                     │                │
  │  MSG_PAIRING   │                     │                │
  │                │─── MQTT publish ───►│                │
  │                │  pairing/request    │                │
  │                │                     │── WebSocket ──►│
  │                │                     │  show pending  │
  │                │                     │                │
  │                │                     │◄── approve ────│
  │                │◄── MQTT sub ────────│                │
  │                │  pairing/response   │                │
  │                │  {approved: true}   │                │
  │◄─── ESP-NOW ───│                     │                │
  │  MSG_PAIRING   │                     │                │
  │  (confirm)     │                     │                │
```

- No cloud response within **60 s** → hub auto-rejects; sensor retries next boot.
- Cloud unreachable → hub falls back to auto-accept.

---

## Security Checklist

| Item | Implementation |
|------|----------------|
| BLE provisioning | Bonding required before writes; credentials never re-transmitted after provisioning |
| WiFi credentials at rest | Stored in ESP32 NVS (flash-encrypted if ESP32 secure boot enabled) |
| MQTT transport | TLS (port 8883) |
| MQTT authentication | Per-device username + password; ACL restricts each device to its own topics |
| App–cloud authentication | JWT (1 h access token, 7 d refresh); stored in Expo SecureStore |
| Dashboard authentication | Same JWT; `httpOnly` cookie option for web |
| HTTPS certificate | Let's Encrypt via Certbot, auto-renewed |
| XSS prevention | Sensor names sanitised before rendering; React/RN escape by default |
| SQL injection | Parameterised queries only |
| Rate limiting | 10 req/min on `/api/auth/login`; 600 req/min on other endpoints |
| Secret management | `.env` excluded from git; no credentials committed |
| Database isolation | PostgreSQL not exposed outside Docker network |
| PMK/LMK keys | Must be replaced before production deployment (see CLAUDE.md) |

---

## Migration Phases

### Phase 1 — Cloud Infrastructure

1. Provision a VPS (1 GB RAM min; Hetzner/DigitalOcean/Linode).
2. Install Docker + Docker Compose.
3. Write `docker-compose.yml`: `mosquitto`, `postgres`, `backend`, `frontend` (Nginx).
4. Configure Mosquitto: TLS cert, per-device password file, ACL.
5. Point domain to VPS; obtain Let's Encrypt certificate.
6. Initialise PostgreSQL schema.

**Deliverable:** Running `docker-compose up` brings the full stack online.

---

### Phase 2 — Backend API

1. Scaffold Node.js + Express project.
2. MQTT bridge (`mqtt.js`):
   - Subscribe `sensors/+/data`, `sensors/+/status`, `sensors/+/pairing/request`.
   - Persist to DB; emit live events via Socket.IO.
3. REST routes (see endpoint table above), including `POST /api/devices/register`
   which is called by the mobile app during BLE provisioning.
4. JWT middleware for all routes except `/api/auth/login`.
5. Socket.IO room per master MAC.

**Deliverable:** Backend persists MQTT data and serves REST + WebSocket.

---

### Phase 3 — Web Dashboard

1. React SPA:
   - **Dashboard** — live sensor grid (Socket.IO).
   - **History** — Chart.js per sensor (24 h / 7 d / 30 d).
   - **Pairing** — pending requests, approve / reject.
   - **Devices** — master list, online/offline, copy API key.
2. Mobile-responsive layout.
3. Login screen; JWT in `localStorage` or `httpOnly` cookie.

**Deliverable:** Vite build served by Nginx.

---

### Phase 4 — Master Firmware Update

1. Remove `WiFiManager`; add `NimBLE-Arduino` and `PubSubClient` via Library Manager.
2. Add `#include <NimBLEDevice.h>`, `#include <ESPmDNS.h>`.
3. Implement `checkProvisioningMode()`: reads NVS; if no WiFi creds → starts BLE.
4. Implement GATT server with `PROV_WIFI`, `PROV_CLOUD`, `PROV_STATUS` characteristics.
5. Replace `wm.autoConnect(...)` with `WiFi.begin(ssid, pass)`.
6. Add `MDNS.begin("temp-master")` after WiFi connects.
7. Add `loadCloudConfig()` + `connectCloud()` (MQTT TLS + LWT + subscribe).
8. Add `publishSensorData()` called from `updateSensor()`.
9. Modify pairing branch in `OnDataRecv` to gate on cloud response.
10. Update BOOT-button reset path to erase `wifi` + `cloud` NVS namespaces.

**Files modified:** `Temp32_hub.ino`
**New libraries:** `NimBLE-Arduino`, `PubSubClient` (Arduino Library Manager).

---

### Phase 5 — Mobile App

1. `npx create-expo-app temp-sensors-app --template blank-typescript`.
2. Install `react-native-ble-plx`, `axios`, `socket.io-client`.
3. Build `ble.ts` service: scan, connect, bond, write characteristic, subscribe to notify.
4. Build `AddDeviceScreen`:
   - Scan BLE → list devices → user selects.
   - Prompt WiFi SSID + password.
   - Call `POST /api/devices/register` to get API key.
   - Write `PROV_WIFI` then `PROV_CLOUD`.
   - Subscribe `PROV_STATUS` → show progress → navigate on `"connected"`.
5. Build remaining screens (Dashboard, History, Pairing, Settings).
6. Submit to App Store / Play Store or distribute via TestFlight / internal track.

**Deliverable:** App provisioning flow works end-to-end on iOS and Android.

---

### Phase 6 — Testing & Cutover

1. Flash updated master firmware to a test unit.
2. Provision it using the app; verify it appears online in cloud dashboard.
3. Verify sensor readings flow from slave → master → cloud → app.
4. Verify cloud-controlled pairing flow.
5. Verify BOOT-button reset re-enters BLE provisioning mode.
6. Verify MQTT LWT marks device offline in dashboard on power loss.
7. Verify `http://temp-master.local/` works as LAN fallback.
8. Roll out to remaining master devices.

---

## What Changes vs What Stays

| Component | Status | Notes |
|-----------|--------|-------|
| Sensor firmware | **Unchanged** | No internet access required |
| Hub — WiFiManager | **Removed** | Replaced by NimBLE-Arduino provisioning |
| Hub — ESP-NOW receive | **Unchanged** | Protocol unchanged |
| Hub — local web server | **Kept** | LAN fallback via `http://temp-hub.local/` |
| Hub — BLE provisioning | **New** | NimBLE-Arduino GATT server; active only until provisioned |
| Hub — mDNS | **New** | ESPmDNS (built-in); LAN hostname after provisioning |
| Hub — MQTT uplink | **New** | PubSubClient + TLS |
| Hub — cloud pairing gate | **Modified** | Was auto-accept; now cloud-gated with local fallback |
| Hub — cloud-sync bridge | **New** | Hub always mirrors cloud DB: adds/removes/renames sensors on sync; publishes sync request on every MQTT connect |
| Cloud backend | **New** | Node.js + PostgreSQL + Mosquitto |
| Web dashboard | **New** | React SPA (admin / power users) |
| Mobile app | **New** | React Native + Expo (end users; provisioning + monitoring) |
| PMK / LMK keys | **Unchanged** | Must be rotated before production (see CLAUDE.md) |

---

## Open Decisions (Resolve Before Implementation)

| Question | Options | Recommendation |
|----------|---------|----------------|
| Cloud host | Self-hosted VPS vs AWS/GCP managed | Self-hosted VPS — most control, fixed monthly cost |
| App framework | React Native (Expo) vs Flutter | React Native — reuses React knowledge from web dashboard |
| Database scale | Plain PostgreSQL vs TimescaleDB | Plain PostgreSQL for now; add TimescaleDB if performance degrades |
| Pairing fallback | Auto-accept vs auto-reject when cloud unreachable | Auto-accept — avoids stranding sensors during outages |
| Dashboard auth | Single admin vs multi-user | Single admin for V1 |
| App distribution | App Store / Play Store vs TestFlight / internal | Internal track first; public stores after polish |
| Data retention | Keep all vs prune after N days | 90-day rolling window, configurable |
| BLE security | Just Works vs numeric comparison passkey | Numeric comparison for V1 — simple but prevents rogue writes |
