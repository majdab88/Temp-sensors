# CLAUDE.md — AI Assistant Guide for Temp-sensors

This file provides guidance for AI assistants (Claude, Copilot, etc.) working in this repository. It documents the current project state, intended conventions, and development workflows.

---

## Project Overview

**Repository:** `Temp-sensors`
**Owner:** majdab88
**Hardware:** XIAO ESP32-C6 (master + slave nodes)
**Sensor:** Sensirion SHT40 (±0.2°C, high-precision temperature & humidity)
**Protocol:** ESP-NOW (peer-to-peer, no router required for sensor communication)

This is a wireless temperature/humidity monitoring system. One **master** station receives sensor data via ESP-NOW, serves a live web dashboard, and connects to WiFi. Up to 10 **slave** sensor nodes wake from deep sleep, read the SHT40, transmit to the master, and go back to sleep.

---

## Repository Structure

```
Temp-sensors/
├── Temp32_master.ino   # Master station firmware (receiver + web dashboard)
├── Temp32_slave.ino    # Slave sensor node firmware (SHT40 + deep sleep)
├── README.md           # Project title placeholder
└── CLAUDE.md           # This file
```

---

## Architecture

```
[Slave Node 1]  ──ESP-NOW──┐
[Slave Node 2]  ──ESP-NOW──┤──► [Master (ESP32-C6)] ──WiFi──► Web Browser
       ...                 │         (web dashboard)
[Slave Node N]  ──ESP-NOW──┘         (JSON API)
```

### Master (`Temp32_master.ino`)
- Connects to WiFi via **WiFiManager** (captive portal AP on first boot).
- Receives sensor data via **ESP-NOW** (encrypted with shared PMK/LMK).
- Serves an HTML dashboard at `http://<IP>/` (auto-refreshes every 10 s).
- Serves a JSON API at `http://<IP>/api/sensors`.
- Tracks up to **10 sensors** by MAC address; marks sensors offline after 10 min.
- Syncs time via **NTP** (`pool.ntp.org`, UTC+2).
- After pairing, upgrades each slave peer from unencrypted broadcast to encrypted (LMK) via `esp_now_mod_peer()`.
- Hold BOOT button (GPIO 9) for 3 s to erase WiFi credentials and restart.

### Slave (`Temp32_slave.ino`)
- Wakes from **deep sleep**, reads the SHT40, sends data to master, sleeps again.
- Sleep interval: `SLEEP_TIME` (default 20 s; use 300+ for production).
- Persists master MAC address in **NVS** (`Preferences`) across reboots.
- **Pairing mode**: broadcast → master replies → slave saves MAC → restart.
- Hold BOOT button (GPIO 9) for 3 s to erase pairing and enter pairing mode.
  - The BOOT button is also configured as a **deep sleep GPIO wake source** (`esp_deep_sleep_enable_gpio_wakeup`), so holding it during deep sleep wakes the device and triggers `checkFactoryReset()` without needing to catch the brief awake window at startup.
- Retries transmission up to `MAX_RETRIES` (5) times before sleeping.
- Properly deinits ESP-NOW and WiFi before deep sleep (required on ESP32-C6 RISC-V to avoid illegal instruction crash, `MCAUSE: 0x18`).
- Data-mode peer registered as **encrypted** (`peerInfo.encrypt = true` + LMK).

### Message Protocol
```c
typedef struct struct_message {
  uint8_t msgType;  // MSG_PAIRING (1) or MSG_DATA (2)
  float temp;
  float hum;
} struct_message;
```

---

## Hardware Pin Definitions

### Master (XIAO ESP32-C6)
| Pin | GPIO | Function |
|-----|------|----------|
| BOOT button | 9 | WiFi reset (hold 3 s) |
| Built-in LED | 15 | Blinks on pairing |

### Slave (XIAO ESP32-C6)
| Pin | GPIO | Function |
|-----|------|----------|
| BOOT button | 9 | Factory reset (hold 3 s); GPIO deep sleep wake source |
| Built-in LED | 15 | Status indicator |
| SDA | 22 (D4) | SHT40 I2C data |
| SCL | 23 (D5) | SHT40 I2C clock |

SHT40 I2C address: `0x44`.

---

## Key Configuration Constants

### Master
| Constant | Value | Notes |
|----------|-------|-------|
| `MAX_SENSORS` | 10 | Maximum paired slaves |
| `NTP_SYNC_INTERVAL` | 86400000 ms | Re-sync every 24 h |
| `gmtOffset_sec` | 7200 | UTC+2 |
| `daylightOffset_sec` | 3600 | +1 h DST |
| WiFiManager AP SSID | `Temp-sensor-Master` | First-boot captive portal |
| WiFiManager AP pass | `12345678` | |

### Slave
| Constant | Value | Notes |
|----------|-------|-------|
| `SLEEP_TIME` | 20 s | Change to 300+ for production |
| `MAX_RETRIES` | 5 | TX retry attempts |
| `RETRY_DELAY_MS` | 100 ms | Delay between retries |
| `TX_TIMEOUT_MS` | 500 ms | Wait for ACK callback |
| `ESPNOW_CHANNEL` | 0 | Auto-detect channel |

### Encryption (both files)
| Item | Detail |
|------|--------|
| `PMK_KEY[16]` | Primary Master Key — must be identical on master and all slaves |
| `LMK_KEY[16]` | Local Master Key — used to encrypt unicast data frames |
| Set via | `esp_now_set_pmk(PMK_KEY)` after `esp_now_init()` |
| Data peers | Registered with `encrypt = true` and `lmk` set to `LMK_KEY` |
| Pairing | Still uses unencrypted broadcast; master upgrades peer via `esp_now_mod_peer()` immediately after sending the pairing reply |

> **Important:** Change `PMK_KEY` and `LMK_KEY` in both files to your own secret values before deploying. All devices in the same network must share the same keys.

---

## Language / Framework

| Item | Detail |
|------|--------|
| Language | C++ (Arduino framework) |
| Target MCU | Seeed XIAO ESP32-C6 |
| Arduino core | ESP32 Arduino core (Espressif) |
| Board package | `esp32` by Espressif |

### Required Libraries
| Library | Source | Used in |
|---------|--------|---------|
| `WiFi.h` | Built-in (ESP32 core) | Both |
| `esp_now.h` | Built-in (ESP32 core) | Both |
| `esp_wifi.h` | Built-in (ESP32 core) | Both |
| `esp_sleep.h` | Built-in (ESP32 core) | Slave |
| `Wire.h` | Built-in (ESP32 core) | Slave |
| `Preferences.h` | Built-in (ESP32 core) | Slave |
| `WebServer.h` | Built-in (ESP32 core) | Master |
| `time.h` | Built-in (ESP32 core) | Master |
| **WiFiManager** | Third-party (tzapu/WiFiManager) | Master |
| **SensirionI2cSht4x** | Third-party (Sensirion Arduino Core) | Slave |

Install third-party libraries via Arduino Library Manager or `platformio.ini`.

---

## Development Workflow

1. Edit firmware in Arduino IDE or PlatformIO.
2. Select board: **XIAO ESP32-C6** (or `Seeed Studio XIAO ESP32C6`).
3. Flash master first; it creates a WiFi AP (`Temp-sensor-Master`) on first boot.
4. Flash slave; it broadcasts a pairing request and saves the master's MAC.
5. After pairing, slaves deep-sleep and send readings on each wake cycle.
6. Monitor output via Serial (115200 baud).

### First-Time Setup
1. Flash master → connect to `Temp-sensor-Master` AP → enter your WiFi credentials.
2. Master prints its IP to Serial; open `http://<IP>/` in a browser.
3. Flash slave(s) → they auto-pair to the master.

### Resetting
- **Master WiFi:** Hold BOOT (GPIO 9) for 3 s → WiFiManager portal reopens.
- **Slave pairing:** Hold BOOT (GPIO 9) for 3 s → NVS erased → pairing mode.
  - Works even during deep sleep: `esp_deep_sleep_enable_gpio_wakeup()` is used (GPIO9 is an HP GPIO on C6 — EXT1 only supports LP GPIOs 0–7), so holding the button wakes the device and `checkFactoryReset()` handles the 3-second hold.

---

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `master` / `main` | Stable, production-ready code |
| `claude/<session-id>` | AI-assisted feature/documentation branches |

- All AI-generated changes are developed on `claude/`-prefixed branches.
- Pull requests from `claude/` branches must be reviewed before merging.

---

## Git Conventions

- **Commit messages** should be clear and imperative, e.g. `Fix deep sleep crash on ESP32-C6`.
- **Small, focused commits** — one logical change per commit.
- **No force-pushes** to `master`/`main`.
- **No committing secrets** — WiFi passwords, API keys must never be committed.

---

## Key Conventions for AI Assistants

### General
- **Read before editing.** Never propose or apply changes to files you have not yet read.
- **Minimal changes.** Only make changes that are directly requested or clearly necessary.
- **No speculative engineering.** Do not add error handling or abstractions for hypothetical requirements.
- **Delete, don't rename.** If something is unused, remove it entirely.

### ESP32 / Arduino-Specific
- The target is the **XIAO ESP32-C6 (RISC-V)**. It has known quirks vs the Xtensa-based ESP32:
  - Always call `esp_now_deinit()` and `esp_wifi_stop()` before `esp_deep_sleep_start()` (skipping causes `MCAUSE: 0x18` illegal instruction crash).
  - Add short `delay()` after GPIO init and I2C `begin()` for hardware stabilization.
  - Serial needs ~500 ms after `begin()` to stabilize on C6.
  - GPIO 50 mA delay needed at startup (`delay(50)` in `checkFactoryReset()`).
- Use `SensirionI2cSht4x` (lowercase 'c') — not `SensirionI2CSht4x`.
- Sensor error values use `-999` as a sentinel for failed reads.
- `loop()` is intentionally empty in the slave — all logic runs in `setup()` followed by deep sleep.
- GPIO9 (BOOT) is an HP GPIO on the C6 — **do not use `esp_sleep_enable_ext1_wakeup()`** (EXT1 only supports LP GPIOs 0–7 and will log `Not an RTC IO`). Use `esp_deep_sleep_enable_gpio_wakeup(1ULL << RESET_PIN, ESP_GPIO_WAKEUP_GPIO_LOW)` instead.

### Encryption
- `PMK_KEY` and `LMK_KEY` are defined in both files and **must be kept in sync**.
- Pairing uses unencrypted broadcast by design (the slave doesn't know the master's MAC yet). The master calls `esp_now_mod_peer()` after pairing to upgrade to encrypted.
- Do not change `encrypt` to `false` on data-mode peers — data is encrypted.

### Security
- Do not introduce command injection, XSS, or other OWASP Top 10 vulnerabilities in the web server HTML/JSON handlers.
- Do not commit WiFi credentials or pairing secrets.
- The hardcoded `PMK_KEY`/`LMK_KEY` are placeholder values — remind the user to replace them before production deployment.

### Style
- Follow the conventions already present in the file being edited (indentation, naming, formatting).
- Only add comments where logic is genuinely non-obvious.

---

## Updating This File

Keep `CLAUDE.md` current as the project evolves:

- Update **Repository Structure** when new files are added.
- Update **Key Configuration Constants** if defaults change.
- Update **Required Libraries** if new dependencies are added.
- Update **Hardware Pin Definitions** if a new board variant is targeted.
- Update **Encryption** section if key management strategy changes.
