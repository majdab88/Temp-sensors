# CLAUDE.md — AI Assistant Guide for Temp-sensors

This file provides guidance for AI assistants (Claude, Copilot, etc.) working in this repository. It documents the current project state, intended conventions, and development workflows.

---

## Project Overview

**Repository:** `Temp-sensors`
**Owner:** majdab88
**Hardware:** XIAO ESP32-C6 (hub + sensor nodes)
**Sensor:** Sensirion SHT40 (±0.2°C, high-precision temperature & humidity) **or** NTC thermistor probe (temperature-only variant)
**Protocol:** ESP-NOW (peer-to-peer, no router required for sensor communication)

This is a wireless temperature/humidity monitoring system. One **hub** station receives sensor data via ESP-NOW, serves a live web dashboard, and connects to WiFi. Up to 10 **sensor** nodes wake from deep sleep, read their sensor, transmit to the hub, and go back to sleep.

Two sensor node variants exist:
- **`sensor/`** — SHT40 (I2C), measures temperature + humidity
- **`sensor-ntc/`** — NTC thermistor probe (ADC), measures temperature only; `hum` field is always `-999`

---

## Repository Structure

```
Temp-sensors/
├── hub/                     # PlatformIO project — hub firmware
│   ├── platformio.ini
│   └── src/
│       └── main.cpp         # Hub firmware (receiver + web dashboard)
├── sensor/                  # PlatformIO project — sensor node firmware (SHT40)
│   ├── platformio.ini
│   └── src/
│       └── main.cpp         # Sensor node firmware (SHT40 + deep sleep)
├── sensor-ntc/              # PlatformIO project — NTC probe sensor variant
│   ├── platformio.ini
│   └── src/
│       └── main.cpp         # NTC probe firmware (ADC + Steinhart-Hart + deep sleep)
├── Temp32_hub.ino           # Original Arduino IDE source (kept for reference)
├── Temp32_sensor.ino        # Original Arduino IDE source (kept for reference)
├── tools/
│   └── firmware-signing/    # ECDSA keygen + image signing for OTA (sign.js)
├── OTA_UPDATE_PLAN.md       # Hub firmware OTA + remote sensor config plan
├── CLOUD_MIGRATION_PLAN.md  # Plan to migrate to custom cloud + BLE provisioning
├── LORAWAN_MIGRATION_PLAN.md # Optional/future: migrate ESP-NOW to LoRaWAN + ChirpStack
├── README.md                # Project title placeholder
└── CLAUDE.md                # This file
```

---

## Architecture

```
[Sensor Node 1]  ──ESP-NOW──┐
[Sensor Node 2]  ──ESP-NOW──┤──► [Hub (ESP32-C6)] ──WiFi──► Web Browser
        ...                 │       (web dashboard)
[Sensor Node N]  ──ESP-NOW──┘       (JSON API)
```

> **Planned migration:** `CLOUD_MIGRATION_PLAN.md` documents a full migration to
> a custom cloud backend with MQTT, PostgreSQL, a React web dashboard, and a
> React Native mobile app. The mobile app will replace WiFiManager with
> **BLE provisioning** (NimBLE-Arduino) so end users never need to type an IP
> address. The firmware below reflects the **current implemented state**.
>
> **Optional future migration:** `LORAWAN_MIGRATION_PLAN.md` documents a potential
> migration from ESP-NOW to LoRaWAN + ChirpStack for longer range. The hub becomes
> a single-channel LoRa gateway (ESP32-C6 + SX1262), sensors use RadioLib LoRaWAN,
> and ChirpStack handles device management. Sensors remain tied to their hub by MAC ID.

### Hub (`Temp32_hub.ino`)
- Connects to WiFi via **WiFiManager** (captive portal AP on first boot). *(Planned: replaced by BLE provisioning — see CLOUD_MIGRATION_PLAN.md)*
- Receives sensor data via **ESP-NOW** (encrypted with shared PMK/LMK).
- Serves an HTML dashboard at `http://<IP>/` (auto-refreshes every 10 s).
- Serves a JSON API at `http://<IP>/api/sensors`.
- Tracks up to **10 sensors** by MAC address; marks sensors offline after 10 min.
- Syncs time via **NTP** (`pool.ntp.org`, UTC+2).
- After pairing, upgrades each sensor peer from unencrypted broadcast to encrypted (LMK) via `esp_now_mod_peer()`.
- Hold BOOT (GPIO 9) **or** the external D0 button (GPIO 0) for 3 s to erase WiFi credentials and restart.

### Sensor (`Temp32_sensor.ino`)
- Wakes from **deep sleep**, reads the SHT40, sends data to hub, sleeps again.
- Sleep interval: `SLEEP_TIME` (default 20 s; use 300+ for production).
- Persists hub MAC address in **NVS** (`Preferences`) across reboots.
- **Pairing mode**: broadcast → hub replies → sensor saves MAC → restart.
- Hold the D0 button (GPIO 0) for 3 s to erase pairing and enter pairing mode.
  - GPIO 0 (D0) is an **LP GPIO** on the C6 and **supports deep sleep wakeup** via `esp_deep_sleep_enable_gpio_wakeup()`. Pressing the button wakes the device from sleep, after which `checkFactoryReset()` runs and detects the held press.
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

### Hub (XIAO ESP32-C6)
| Pin | GPIO | Function |
|-----|------|----------|
| BOOT button (on-module) | 9 | Reset / re-provision (hold 3 s) |
| External button | 0 (D0) | Reset / re-provision (hold 3 s) — same action as BOOT; not a strap pin |
| Built-in LED | 15 | Blinks on pairing |

### Sensor — SHT40 variant (`sensor/`, XIAO ESP32-C6)
| Pin | GPIO | Function |
|-----|------|----------|
| External button | 0 (D0) | Factory reset (hold 3 s) **and** deep sleep wakeup; LP GPIO |
| Built-in LED | 15 | Status indicator |
| Battery ADC | 2 (D2) | ADC midpoint of battery voltage divider |
| Divider enable | 1 (D1) | GND switch for battery divider (OUTPUT LOW = on; INPUT = Hi-Z during sleep) |
| SDA | 22 (D4) | SHT40 I2C data |
| SCL | 23 (D5) | SHT40 I2C clock |

SHT40 I2C address: `0x44`.

### Sensor — NTC probe variant (`sensor-ntc/`, XIAO ESP32-C6)
| Pin | GPIO | Function |
|-----|------|----------|
| External button | 0 (D0) | Factory reset (hold 3 s) **and** deep sleep wakeup; LP GPIO |
| Built-in LED | 15 | Status indicator |
| Battery ADC | 2 (D2) | ADC midpoint of battery voltage divider |
| Divider enable | 21 (D3) | GND switch for battery divider (OUTPUT LOW = on; INPUT = Hi-Z during sleep) |
| NTC ADC | 1 (D1) | ADC midpoint of NTC voltage divider |
| NTC enable | 22 (D4) | GND switch for NTC divider (OUTPUT LOW = on; INPUT = Hi-Z during sleep) |

NTC PCB circuit: `3.3V → NTC probe → GPIO1/D1 (ADC) → 10 kΩ (series) → GPIO22/D4 (GND switch)`
- NTC is on the **high side** (between 3.3V and ADC pin). At cold temperatures the NTC resistance is high, which keeps the ADC voltage low — in the accurate zone of the ESP32 ADC. The old topology (series R on top) drove the ADC to ~2.9V at -17°C, which is in the nonlinear region of ADC_11db and caused ~11°C over-reading. ADC attenuation is `ADC_6db` (0–2.2V), covering -40°C to +40°C for a 10K NTC.
- No I2C bus — GPIO22 (D4) is repurposed as NTC GND switch; GPIO23 (D5) is unused.
- `hum` is always sent as `-999`; the hub should display "N/A" for these nodes.
- Temperature uses the **full Steinhart-Hart equation** — `1/T(K) = A + B·ln(R) + C·ln(R)³` —
  with `NTC_SH_A`/`NTC_SH_B`/`NTC_SH_C`, not the Beta approximation. The deployed values are a
  **restricted cold-range fit** taken against an SHT40 reference, so they look nothing like
  textbook 10K coefficients; a full-range fit is less accurate inside a cooler.
- `SERIES_RESISTOR` should be the *measured* value of the divider resistor on each board — its
  tolerance biases every resistance reading.
- All four are settable per sensor from the dashboard (superadmin only); the compiled values are
  the defaults until the cloud pushes something.
- **Filter caps on ADC pins** (noise rejection / anti-aliasing):
  - `Cfn` = 100 nF X7R from GPIO1/D1 (NTC_ADC) to GND
  - `Cfb` = 10 nF X7R from GPIO2/D2 (BAT_ADC) to GND
  - Placed as close to the GPIO pin as possible. Existing 10 ms settling delay in firmware covers charge-up (RC ≈ 0.5 ms NTC, ≈ 0.5 ms battery at 50 kΩ source).

#### Power Supply (battery-powered build)

Feed the regulated output into the XIAO's `3V3` pin (not `5V`) to bypass the onboard LDO.

```
BAT+ ──┬── HT7333-A VIN ── VOUT ──┬── XIAO 3V3 pin
       │  (3.3 V LDO, SOT-89)     │
       C1 (10 µF X7R)             C2 (220 µF elec.)
       │                          │
BAT– ──┴──────────────────────────┴── XIAO GND

Battery divider (taps BAT+ before regulator):
BAT+ ── R1 (100 kΩ, 1%) ──┬── R2 (100 kΩ, 1%) ── GPIO21/D3 (enable)
                           └── GPIO2/D2 (ADC)
```

| Item | Value |
|------|-------|
| Battery | **2× Energizer Ultimate Lithium L91** (Li-FeS₂, AA, 1.5 V each → 3.0 V nominal in series, ~3.4 V fresh) — cold-tolerant to −40 °C, ~20-year shelf life, ~3000 mAh per cell |
| Regulator | HT7333-A, SOT-89, Iq ≈ 4 µA, Vdrop ≈ 170 mV @ 50 mA |
| C1 | 10 µF ceramic X7R (HT7333 input) |
| C2 | 220 µF electrolytic (HT7333 output, TX spike buffer) |
| Divider | 2× 100 kΩ 1 %; midpoint → GPIO2/D2; GPIO21/D3 = GND switch (Hi-Z during sleep). ~18 µA when enabled |
| Expected sleep current | < 25 µA (HT7333 Iq + ESP32-C6 deep sleep) |

> **⚠ LDO dropout limits useful battery life.** The HT7333-A needs ≥ 3.47 V
> at its input to maintain 3.3 V output under load (and more during the
> 200 mA ESP-NOW TX burst because dropout grows with current). L91 cells in
> series start at ~3.4 V and drop steadily toward ~1.8 V at end-of-life.
> Practically the node will brown out once BAT+ falls below ~3.4 V — which
> happens after only **10–25 % of the L91 pack's total capacity** has been
> used. The remaining ~75 % is unreachable through this regulator.
>
> The L91 chemistry itself supplies pulse current natively (no passivation),
> so no supercapacitor is needed. Cold-weather and shelf-life behaviour are
> excellent.
>
> **Upgrade path for full capacity utilisation:** replace the HT7333-A with
> a **buck-boost converter** (e.g., TI TPS63031, TPS63001) which holds 3.3 V
> across the full L91 voltage range (1.8 V → 3.6 V). This is the right move
> if you need to extract the full ~3000 mAh per cell.

### Sensor — NTC probe variant v2 (`sensor-ntc/`, bare ESP32-C6-WROOM-1U)

The v2 revision drops the XIAO carrier and builds the node on a discrete WROOM-1U
module with a custom PCB. Schematic at [docs/schematics/sensor-ntc-v2.svg](docs/schematics/sensor-ntc-v2.svg).
Why: kill the USB-C ingress path on deployed nodes, replace the HT7333 LDO with a
TPS63802 buck-boost (full L91 capacity utilisation), and use the Espressif ESP-PROG
for hands-free flashing.

| Pin | GPIO | Function |
|-----|------|----------|
| External button | 0 | Factory reset (hold 3 s) **and** deep sleep wakeup; LP GPIO; also user wake button on PCB |
| Status LED | **5** | Moved off GPIO15 (which is a strap pin on ESP32-C6) |
| Battery ADC | 2 | ADC midpoint of battery voltage divider |
| Divider enable | 21 | GND switch for battery divider (OUTPUT LOW = on; INPUT = Hi-Z during sleep) |
| NTC ADC | 1 | ADC midpoint of NTC voltage divider |
| NTC enable | 22 | GND switch for NTC divider (OUTPUT LOW = on; INPUT = Hi-Z during sleep) |
| U0TXD | 16 | UART TX → ESP-PROG `ESP_TXD` (header pin 3) |
| U0RXD | 17 | UART RX ← ESP-PROG `ESP_RXD` (header pin 5) |
| BOOT strap | 9 | → ESP-PROG `ESP_IO0` (header pin 6); 10 kΩ pullup to 3V3 |
| Strap (must be high) | 8 | 10 kΩ pullup to 3V3 |
| Strap (log) | 15 | Floats — internal pullup keeps it high, default boot-log-enabled |

GPIO14 (the XIAO RF-switch antenna-select pin) is **not used** on v2 — the WROOM-1U
routes its antenna pin directly to a u.FL connector. The firmware block that drives
GPIO3/14 at boot must be deleted when running on v2 hardware.

#### Power supply v2 — TPS63802 buck-boost

```
BAT+ ──┬── C_buf_e (1000 µF elec.)  ── TPS63802 VIN ──┐
       ├── C_buf_c (22 µF X7R)         L1 1.5 µH      │
       │   (HLC substitute on cell)    R_FB1 / R_FB2  │
       │                               PS=GND (PFM)   │
       │                              C_in 10 µF      │
       │                              C_out 22 µF     │
BAT– ──┴──────────────────────────── PGND ────────────┴── 3V3 OUT → WROOM-1U VDD
```

| Item | Value |
|------|-------|
| Battery | Same as v1: 2× L91 AA in series (or TL-4903 if upgrading to Li-SOCl₂ later) |
| Regulator | TI **TPS63802DMQR** buck-boost, V_in 1.3–5.5 V → V_out programmable, Iq ≈ 11 µA (PFM), **HotRod DFN-10** (1.4 × 2.3 mm) |
| Pinout | VIN, L1, L2, GND, AGND, VOUT, FB, PG, EN, MODE (10 pins). **The inductor connects between the L1 and L2 pins** — there is no SW pin. |
| L1_ext | 1.5 µH shielded power inductor between L1 and L2, ≥ 2 A saturation, ≤ 50 mΩ DCR (e.g., TDK MLP2520H1R5) |
| C_in / C_out | 10 µF / 22 µF X7R 0805 at VIN / VOUT |
| R_FB1 / R_FB2 | **560 kΩ / 100 kΩ** 1 % — V_out = 0.5 × (1 + R_FB1/R_FB2) = 3.30 V. R_FB2 must not exceed 100 kΩ per datasheet. |
| **MODE pin** | **Tie to GND** — enables PFM (Power Save) mode for µA-class light-load Iq. MODE = HIGH forces continuous PWM and burns multi-mA Iq. |
| EN pin | Tied directly to VIN/BAT+ (no resistor needed). Always-on regulator; deep sleep is the C6's, not the regulator's. |
| PG pin | Power Good open-drain output. Leave NC, or pull up to 3V3 via 100 kΩ if monitoring. |
| Cell-side buffer | 1000 µF elec. + 22 µF X7R across BAT (HLC substitute, buffers TX pulse) |
| Output decoupling | 10 µF X7R 0603 + 100 nF X7R 0402 at WROOM-1U VDD |
| Expected sleep current | < 20 µA (11 µA TPS63802 + ~7 µA C6 deep sleep + dividers Hi-Z) |

Unlike v1's HT7333, the TPS63802 holds 3.3 V across the full L91 discharge curve
(1.3 V → 5.5 V V_in window), so the node uses the cell down to true end-of-life
instead of browning out with 75% capacity remaining.

#### Programming header v2 — 2×3 IDC, ESP-PROG UART standard

```
       ┌────────────────┐
   1 ──│  EN     3V3  │── 2
   3 ──│  ESP_TXD GND │── 4
   5 ──│  ESP_RXD IO0 │── 6   (IO0 = GPIO9 BOOT on C6)
       └────────────────┘
```

2.54 mm pitch (matches commonly-sold ESP-PROG clones). Plugs directly into the
ESP-PROG's UART ribbon — no adapter PCB or transistors on the sensor board.
Set the **ESP-PROG VDD jumper to 3.3 V** before connecting; 5 V will damage the C6.

---

## Key Configuration Constants

### Hub
| Constant | Value | Notes |
|----------|-------|-------|
| `MAX_SENSORS` | 10 | Maximum paired sensors |
| `NTP_SYNC_INTERVAL` | 86400000 ms | Re-sync every 24 h |
| `gmtOffset_sec` | 7200 | UTC+2 |
| `daylightOffset_sec` | 3600 | +1 h DST |
| WiFiManager AP SSID | `Temp-sensor-Hub` | First-boot captive portal |
| WiFiManager AP pass | `12345678` | |

### Sensor (both variants)
| Constant | Value | Notes |
|----------|-------|-------|
| `SLEEP_TIME` | 900 s | 15 min; adjust as needed |
| `MAX_RETRIES` | 5 | TX retry attempts |
| `RETRY_DELAY_MS` | 100 ms | Delay between retries |
| `TX_TIMEOUT_MS` | 500 ms | Wait for ACK callback |
| `ESPNOW_CHANNEL` | 0 | Auto-detect channel |

### NTC variant only (`sensor-ntc/`)
| Constant | Value | Notes |
|----------|-------|-------|
| `NTC_SH_A` | 2.535e-3 | Steinhart-Hart A — cold-range fit, not a textbook value |
| `NTC_SH_B` | 3.01e-5 | Steinhart-Hart B — fitted from (-18.2 °C/81911 Ω, -7.2 °C/47214 Ω, +4 °C/26811 Ω) |
| `NTC_SH_C` | 7.23e-7 | Steinhart-Hart C — SHT40 reference, cold-board operation |
| `SERIES_RESISTOR` | 10000 Ω | Fixed series resistor — use ≥1 % tolerance |
| `NTC_SAMPLES` | 20 | ADC readings averaged per measurement |
| `NTC_PIN` | 1 | ADC GPIO — adjust if PCB differs |
| `NTC_ENABLE_PIN` | 22 | GND switch GPIO — adjust if PCB differs |

### Encryption (both files)
| Item | Detail |
|------|--------|
| `PMK_KEY[16]` | Primary Master Key — must be identical on hub and all sensors |
| `LMK_KEY[16]` | Local Master Key — used to encrypt unicast data frames |
| Set via | `esp_now_set_pmk(PMK_KEY)` after `esp_now_init()` |
| Data peers | Registered with `encrypt = true` and `lmk` set to `LMK_KEY` |
| Pairing | Still uses unencrypted broadcast; hub upgrades peer via `esp_now_mod_peer()` immediately after sending the pairing reply |

> **Important:** Change `PMK_KEY` and `LMK_KEY` in both files to your own secret values before deploying. All devices in the same network must share the same keys.

---

## Language / Framework

| Item | Detail |
|------|--------|
| Language | C++ (Arduino framework) |
| Target MCU | Seeed XIAO ESP32-C6 |
| Arduino core | ESP32 Arduino core (Espressif) |
| Build system | **PlatformIO** (`hub/platformio.ini`, `sensor/platformio.ini`) |
| Board ID | `seeed_xiao_esp32c6` |
| **Partition scheme** | **`min_spiffs.csv`** (hub only) — two 1920 KiB OTA slots (`app0`/`app1`), required for firmware OTA; set via `board_build.partitions` in `platformio.ini`. Replaced `huge_app.csv`, which had a single app slot and could not support OTA. `nvs` is at the same offset in both, so reflashing preserves credentials — **do not `erase_flash`** when migrating a provisioned hub. Sensors use the default table, which already has `app0`/`app1`. |
| Optimize | `-Os` (Smallest Code) — set via `build_flags` in `platformio.ini` |

### Required Libraries
| Library | Source | Used in |
|---------|--------|---------|
| `WiFi.h` | Built-in (ESP32 core) | Both |
| `esp_now.h` | Built-in (ESP32 core) | Both |
| `esp_wifi.h` | Built-in (ESP32 core) | Both |
| `esp_sleep.h` | Built-in (ESP32 core) | Sensor |
| `Wire.h` | Built-in (ESP32 core) | Sensor |
| `Preferences.h` | Built-in (ESP32 core) | Sensor |
| `WebServer.h` | Built-in (ESP32 core) | Hub |
| `time.h` | Built-in (ESP32 core) | Hub |
| **WiFiManager** | Third-party (tzapu/WiFiManager) | Hub *(planned: replaced by NimBLE-Arduino)* |
| **SensirionI2cSht4x** | Third-party (Sensirion Arduino Core) | Sensor |
| **NimBLE-Arduino** | Third-party (h2zero/NimBLE-Arduino) | Hub *(planned: BLE provisioning)* |
| **PubSubClient** | Third-party (knolleary/pubsubclient) | Hub *(planned: MQTT cloud uplink)* |

Install third-party libraries via Arduino Library Manager or `platformio.ini`.

---

## Development Workflow

1. Edit firmware in Arduino IDE or PlatformIO.
2. Select board: **XIAO ESP32-C6** (or `Seeed Studio XIAO ESP32C6`).
3. Flash hub first; it creates a WiFi AP (`Temp-sensor-Hub`) on first boot.
4. Flash sensor; it broadcasts a pairing request and saves the hub's MAC.
5. After pairing, sensors deep-sleep and send readings on each wake cycle.
6. Monitor output via Serial (115200 baud).

### Flashing v2 sensor-ntc hardware (bare WROOM-1U board)

The v2 PCB has no USB-C — flash it with an **Espressif ESP-PROG** plugged into the
2×3 IDC `J_PROG` header.

1. Set the ESP-PROG VDD jumper to **3.3 V** (5 V will damage the C6).
2. Plug the ESP-PROG's UART ribbon into `J_PROG` (pin 1 = EN, marked on silkscreen).
3. Plug the ESP-PROG USB into the dev PC.
4. `pio run -e <env> -t upload` — no buttons need to be pressed; ESP-PROG drives
   EN + BOOT through its built-in auto-reset circuit.
5. `pio device monitor` reuses the same ESP-PROG as a 115200-baud serial console.

The board does not include an LDO or USB protection — the ESP-PROG can power the
board through pin 2 (3V3) for bench testing, **but the battery should be disconnected**
while doing so to avoid back-feeding the cell.

### First-Time Setup (Current — WiFiManager)
1. Flash hub → connect to `Temp-sensor-Hub` AP → enter your WiFi credentials.
2. Hub prints its IP to Serial; open `http://<IP>/` in a browser.
3. Flash sensor(s) → they auto-pair to the hub.

### First-Time Setup (Planned — BLE provisioning)
1. Flash hub → open mobile app → tap "Add Device" → select `TempHub-XXXXXX`.
2. Enter WiFi SSID + password in the app; app pushes credentials via BLE.
3. Hub connects to WiFi + cloud; app shows "Done!".
4. Flash sensor(s) → they auto-pair (or approve pairing via app/dashboard).

### Resetting
- **Hub WiFi (current):** Hold BOOT (GPIO 9) or external D0 (GPIO 0) for 3 s → WiFiManager portal reopens.
- **Hub WiFi (planned BLE):** Hold BOOT (GPIO 9) or external D0 (GPIO 0) for 3 s → NVS erased → device re-enters BLE provisioning mode.
- **Sensor pairing:** Hold D0 (GPIO 0) for 3 s → NVS erased → pairing mode. Works from deep sleep — the button wakes the device, then `checkFactoryReset()` detects the held press.

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
- `loop()` is intentionally empty in the sensor — all logic runs in `setup()` followed by deep sleep.
- The sensor uses **GPIO 0 (D0)** as its reset/wakeup button — this is an LP GPIO (0–7 range) and **does** support `esp_deep_sleep_enable_gpio_wakeup()`. GPIO 9 (BOOT) is an HP GPIO and cannot wake from deep sleep; do not use it for this purpose.

### Encryption
- `PMK_KEY` and `LMK_KEY` are defined in both files and **must be kept in sync**.
- Pairing uses unencrypted broadcast by design (the sensor doesn't know the hub's MAC yet). The hub calls `esp_now_mod_peer()` after pairing to upgrade to encrypted.
- Do not change `encrypt` to `false` on data-mode peers — data is encrypted.

### Security
- Do not introduce command injection, XSS, or other OWASP Top 10 vulnerabilities in the web server HTML/JSON handlers.
- Do not commit WiFi credentials or pairing secrets.
- The hardcoded `PMK_KEY`/`LMK_KEY` are placeholder values — remind the user to replace them before production deployment. Flash both hub and all sensors with matching keys.

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
