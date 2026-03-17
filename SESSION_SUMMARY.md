# Session Summary — Temp-sensors Project

> Last updated: 2026-03-15
> Use this file at the start of a new Claude Code session to get up to speed instantly.

---

## Project in One Sentence

Wireless temperature/humidity monitoring system: XIAO ESP32-C6 sensor nodes → ESP-NOW → ESP32-C6 hub → MQTT/TLS → self-hosted cloud → React web dashboard + React Native mobile app.

---

## Current State of the Repository

### What's Done and Merged to `main`

| Area | Status |
|------|--------|
| ESP32 hub firmware (`hub/`) | Done — ESP-NOW receive, local web dashboard, WiFiManager (to be replaced) |
| ESP32 sensor firmware (`sensor/`) | Done — SHT40, deep sleep, pairing, encrypted ESP-NOW |
| ESP32 sensor firmware (`sensor-ntc/`) | Done — NTC thermistor variant, same protocol |
| Cloud backend (`temp-sensors-cloud/backend/`) | Done — Node.js + Express + Socket.IO + PostgreSQL + Mosquitto MQTT bridge |
| Cloud frontend (`temp-sensors-cloud/frontend/`) | Done — React web dashboard (live grid, history charts, pairing, devices) |
| Docker Compose stack (`temp-sensors-cloud/docker-compose.yml`) | Done — mosquitto, postgres, backend, frontend, nginx |
| React Native mobile app (`temp-sensors-app/`) | Done — multi-user, role-based UI, BLE provisioning flow, live dashboard |
| Multi-user / org accounts | Done (merged via `claude/multi-user-accounts-X1YrL`) |
| Superadmin view with org impersonation | Done (latest commit on current branch, not yet merged) |

### Current Branch

`claude/design-mobile-app-s0Jo1` — contains 13 commits not yet merged to `main`:

```
7182181 Add superadmin view with org impersonation, role-based navigation
0ab7f95 Align app with cloud dashboard: role-based UI, correct field names, pairing flow
da3138a Fix sensor detail crash (recorded_at) and request BLE permissions at runtime
5f28a17 Fix crash: guard sensor fields that are undefined before first Socket.IO update
3ccd6db Fix login: use accessToken/refreshToken from backend response
9328fed Show actual network error message in login failure dialog
3ae177b Add splash backgroundColor to fix Android resource linking error
8cbc683 Add react-native-reanimated dependency required by victory-native 36.x
868045b Fix EAS build issues: remove missing assets, add expo-font, pin typescript
24cfee4 Pin victory-native to 36.9.2 for React 18 compatibility
4afb480 Hardcode API URL to majdtemp32.duckdns.org
3f92772 Add EAS build config and .gitignore for mobile app
1627746 Add React Native mobile app (Expo) — temp-sensors-app
```

These changes need a PR to `main` when ready.

---

## Repository Structure (actual, as of now)

```
Temp-sensors/
├── hub/                        # PlatformIO — hub firmware (ESP-NOW + local web)
│   ├── platformio.ini
│   └── src/main.cpp
├── sensor/                     # PlatformIO — SHT40 sensor node
│   ├── platformio.ini
│   └── src/main.cpp
├── sensor-ntc/                 # PlatformIO — NTC thermistor sensor node
│   ├── platformio.ini
│   └── src/main.cpp
├── temp-sensors-cloud/         # Self-hosted cloud stack
│   ├── docker-compose.yml
│   ├── backend/                # Node.js + Express + Socket.IO + MQTT bridge
│   ├── frontend/               # React 18 + Vite web dashboard
│   ├── mosquitto/              # MQTT broker config
│   ├── nginx/                  # Reverse proxy + TLS
│   └── postgres/               # DB init scripts
├── temp-sensors-app/           # React Native + Expo mobile app
│   ├── app.json
│   ├── eas.json
│   ├── package.json
│   └── src/
│       ├── App.tsx
│       ├── navigation/AppNavigator.tsx
│       └── screens/
│           ├── LoginScreen.tsx
│           ├── DashboardScreen.tsx
│           ├── AddDeviceScreen.tsx      # BLE provisioning
│           ├── SensorDetailScreen.tsx
│           ├── DevicesScreen.tsx
│           ├── PairingScreen.tsx
│           ├── UsersScreen.tsx
│           ├── OrganizationsScreen.tsx
│           ├── AuditLogScreen.tsx
│           └── AccountScreen.tsx
├── BattDebug/                  # Battery debugging utilities
├── ble-provision.html          # Standalone BLE provisioning test page
├── Temp32_hub.ino              # Original Arduino IDE source (reference only)
├── Temp32_sensor.ino           # Original Arduino IDE source (reference only)
├── CLOUD_MIGRATION_PLAN.md     # Full architecture plan (very detailed)
├── CLAUDE.md                   # AI assistant guide (read this first!)
├── README.md                   # Placeholder
└── SESSION_SUMMARY.md          # This file
```

---

## Mobile App Summary

**Framework:** React Native + Expo
**API URL:** `https://majdtemp32.duckdns.org` (hardcoded in `src/services/api.ts`)
**Auth:** JWT — `accessToken` / `refreshToken` stored via Expo SecureStore
**Real-time:** Socket.IO client for live sensor updates
**BLE:** `react-native-ble-plx` for hub provisioning (AddDeviceScreen)
**Charts:** `victory-native` pinned to `36.9.2` (React 18 compatible)

### Roles in the App

| Role | Access |
|------|--------|
| `user` | Dashboard, sensor history |
| `admin` | + Devices, Pairing, Users, Account |
| `superadmin` | + Organizations, Audit Log, org impersonation |

### Key Fixes Applied This Branch

- Crash on `SensorDetailScreen` when `recorded_at` was undefined
- Crash when sensor fields undefined before first Socket.IO update
- Login broken — backend returns `accessToken`/`refreshToken` (not `token`)
- BLE permissions not requested at runtime on Android 12+
- Android build errors: missing assets, missing `expo-font`, TypeScript version
- `victory-native` 40.x incompatible with React 18 → pinned to 36.9.2
- `react-native-reanimated` missing (required by victory-native)
- Splash screen `backgroundColor` missing (Android resource link error)
- EAS build config (`eas.json`) added
- API URL hardcoded to avoid env-var issues in EAS builds

---

## Cloud Backend Summary

**Stack:** Node.js 20 + Express + Socket.IO + PostgreSQL + Mosquitto MQTT
**Deployment:** Docker Compose on a VPS
**Domain:** `majdtemp32.duckdns.org`
**TLS:** Nginx + Let's Encrypt

### Key API Endpoints

```
POST /api/auth/login           → { accessToken, refreshToken }
GET  /api/sensors              → list sensors (with latest reading)
GET  /api/sensors/:id/readings → historical readings
POST /api/devices/register     → register hub, returns API key (used by BLE flow)
GET  /api/pairing/requests     → pending pairing requests
POST /api/pairing/requests/:id/approve
POST /api/pairing/requests/:id/reject
GET  /api/users                → (admin) list users
GET  /api/organizations        → (superadmin) list orgs
```

---

## ESP32 Firmware Summary

- **Hub** — receives ESP-NOW from sensors, publishes to MQTT, local web server at `http://<IP>/`
- **Sensors** — wake from deep sleep, read SHT40 (or NTC), send via ESP-NOW, sleep 15 min
- **Encryption** — PMK + LMK (must match on all devices; replace placeholder keys before production)
- **Deep sleep quirk** — always call `esp_now_deinit()` + `esp_wifi_stop()` before `esp_deep_sleep_start()` on C6 (avoids `MCAUSE: 0x18` crash)
- **Reset** — hub: hold BOOT (GPIO9) 3s; sensor: hold D0 (GPIO0) 3s

**Hub firmware migration status:** WiFiManager still present. BLE provisioning (NimBLE-Arduino) + MQTT (PubSubClient) are planned but not yet implemented in `hub/src/main.cpp`. See `CLOUD_MIGRATION_PLAN.md` Phase 4 for the full plan.

---

## What's Left / Open Work

| Item | Notes |
|------|-------|
| Merge `claude/design-mobile-app-s0Jo1` → `main` | 13 commits ready; needs PR review |
| Hub firmware: replace WiFiManager with NimBLE-Arduino BLE provisioning | Phase 4 in `CLOUD_MIGRATION_PLAN.md` |
| Hub firmware: add MQTT uplink (PubSubClient) | Phase 4 in `CLOUD_MIGRATION_PLAN.md` |
| Mobile app: App Store / Play Store submission | TestFlight / internal track first |
| Data retention policy | 90-day rolling window recommended |
| PMK / LMK keys | **Must be replaced** before production deployment |

---

## Branch Strategy Reminder

- Always develop on a `claude/<session-id>` branch
- Push with: `git push -u origin claude/<session-id>`
- Never push to `main` directly
- Open a PR for review before merging

---

## Quick Start for New Session

1. Read `CLAUDE.md` — contains all hardware pins, constants, conventions.
2. Read `CLOUD_MIGRATION_PLAN.md` — full architecture, phases, and open decisions.
3. Check `git log --oneline -10` to see recent work.
4. The current feature branch is `claude/design-mobile-app-s0Jo1`.
5. The live API is at `https://majdtemp32.duckdns.org`.
