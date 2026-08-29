# CLAUDE.md — AI Assistant Guide for Temp-sensors

Guidance for AI assistants working in this repository: what exists, why it is
built the way it is, and which mistakes have already been made here.

---

## Project Overview

**Repository:** `Temp-sensors` · **Owner:** majdab88
**Hardware:** ESP32-C6 — XIAO carrier (v1) or bare WROOM-1U on a custom PCB (v2)
**Sensor:** Sensirion SHT40 (±0.2 °C, temperature + humidity) **or** NTC thermistor probe (temperature only)
**Protocol:** ESP-NOW between sensors and hub; MQTT/TLS between hub and cloud

Battery sensor nodes wake from deep sleep, take a reading, transmit to a hub over
ESP-NOW, and sleep again. The hub relays readings to a self-hosted cloud over
MQTT, which stores history, raises temperature alarms, and serves a web dashboard
and a mobile app. Deployment target is cold-chain monitoring: coolers and
freezers, where a node may be physically hard to reach for years.

Two sensor variants:

- **`sensor/`** — SHT40 over I2C; temperature + humidity
- **`sensor-ntc/`** — NTC probe on the ADC; temperature only, `hum` always `-999`

The NTC variant is the one being deployed and the one that receives active work.

---

## Repository Structure

```
Temp-sensors/
├── hub/                      # PlatformIO — hub firmware (ESP-NOW ↔ MQTT bridge)
├── sensor/                   # PlatformIO — SHT40 sensor node
├── sensor-ntc/               # PlatformIO — NTC probe sensor node (active variant)
├── temp-sensors-cloud/       # Self-hosted cloud stack (docker compose)
│   ├── backend/              #   Node.js API + MQTT bridge + Socket.IO
│   │   └── src/routes/       #   firmware.js, sensors.js, ...
│   ├── frontend/             #   React dashboard (Vite)
│   ├── postgres/             #   Schema + numbered migrations (init.sql, NN-*.sql)
│   ├── mosquitto/            #   Broker config, TLS
│   └── nginx/                #   Reverse proxy, certbot
├── temp-sensors-app/         # React Native / Expo mobile app
├── tools/firmware-signing/   # sign.js (ECDSA P-256) + publish.sh (build→sign→upload)
├── docs/schematics/          # Board schematics (sensor-ntc-v2.svg)
├── BattDebug/                # Battery measurement scratch sketches
├── ble-provision.html        # Browser-based BLE provisioning test page
├── OTA_UPDATE_PLAN.md        # Remote management design (mostly implemented)
├── CLOUD_MIGRATION_PLAN.md   # Cloud + BLE provisioning design (implemented)
├── LORAWAN_MIGRATION_PLAN.md # ESP-NOW → LoRaWAN (not started)
├── Temp32_hub.ino            # Original Arduino IDE source (historical reference)
├── Temp32_sensor.ino         # Original Arduino IDE source (historical reference)
└── CLAUDE.md                 # This file
```

> The `.ino` files at the root are **history, not the build**. All firmware work
> happens in the PlatformIO projects.

---

## Architecture

```
[Sensor 1..N] ──ESP-NOW──► [Hub ESP32-C6] ──MQTT/TLS──► [Cloud]
  deep sleep,               BLE provisioning            Mosquitto
  wakes to report           local web dashboard         Node.js backend
                            offline buffer              PostgreSQL
                                                        React dashboard
                                                        Expo mobile app
```

Everything above is **implemented and deployed**. The cloud runs on a
DigitalOcean droplet under docker compose. `LORAWAN_MIGRATION_PLAN.md` remains
untouched and speculative — see *Plan Documents* below before treating any plan
file as a description of reality.

### Hub (`hub/src/main.cpp`)

- **BLE provisioning** via NimBLE (replaced WiFiManager). The mobile app or
  `ble-provision.html` pushes WiFi credentials; no captive portal, no IP typing.
- Receives sensor data over ESP-NOW, encrypted with a shared PMK/LMK.
- Publishes readings to the cloud over MQTT/TLS; **buffers to NVS when offline**
  (`OFFLINE_BUFFER_SIZE` 50) and flushes on reconnect.
- Serves a local dashboard and JSON API for on-site use without the cloud.
- Tracks up to `MAX_SENSORS` (10) sensors by MAC; syncs its list with the cloud.
- Syncs time via NTP (UTC+2, +1 h DST).
- Relays remote management to sensors: config, live mode, firmware.
- Takes its **own** firmware over the air, signed and rollback-protected.
- Hold BOOT (GPIO 9) or external D0 (GPIO 0) for 3 s to erase credentials.

### Sensor (`sensor-ntc/src/main.cpp`)

- Wakes from deep sleep, reads the probe, transmits, sleeps. `loop()` is
  intentionally empty — everything happens in `setup()`.
- Sleep interval `g_sleepSecs`, default `SLEEP_TIME` 900 s, settable from the
  dashboard within `CFG_SLEEP_MIN`–`CFG_SLEEP_MAX` (300–3600 s).
- Persists hub MAC and configuration in NVS across reboots.
- **Pairing:** broadcast → hub replies → sensor saves MAC → restart.
- Hold D0 (GPIO 0) for 3 s to erase pairing. Works from deep sleep: the button
  wakes the node, then `checkFactoryReset()` sees the held press.
- Retries transmission `MAX_RETRIES` (5) times, then counts a failed wake.
  After `MAX_FAILED_WAKES_BEFORE_HIBERNATE` (4) it hibernates to button-only
  wake rather than burning current on an unreachable hub.
- Accepts remote configuration, live mode, and signed firmware over ESP-NOW.
- Deinits ESP-NOW and stops WiFi before deep sleep — mandatory on the C6.

### Message Protocol

All structs must be **byte-for-byte identical** on hub and sensors. New fields
are appended only; `OnDataRecv` accepts the legacy length and zero-fills, so a
pre-1.0 sensor reporting `0.0.0` is simply one that has not been updated.

```c
typedef struct struct_message {
  uint8_t  msgType;
  float    temp;
  float    hum;      // -999 on the NTC variant, and on a probe fault
  uint8_t  battery;  // 0–100 %; 255 = read error
  uint8_t  fw_major; // 0.0.0 = pre-1.0 sensor
  uint8_t  fw_minor;
  uint8_t  fw_patch;
  uint16_t cfg_ver;  // config applied on the sensor; 0 = compiled defaults
} struct_message;
```

| ID | Name | Direction | Purpose |
|----|------|-----------|---------|
| 1 | `MSG_PAIRING` | both | Pairing handshake (unencrypted broadcast) |
| 2 | `MSG_DATA` | sensor → hub | A reading |
| 3 | `MSG_LOG` | sensor → hub | Remote log, chunked text |
| 4 | `MSG_CONFIG` | hub → sensor | Interval + calibration |
| 5 | `MSG_OTA_OFFER` | hub → sensor | Image available: size, hash, signature |
| 6 | `MSG_OTA_REQ` | sensor → hub | Accept, or decline with a reason |
| 7 | `MSG_OTA_DATA` | hub → sensor | One chunk |
| 8 | `MSG_OTA_ACK` | sensor → hub | Next sequence expected |
| 9 | `MSG_OTA_DONE` | sensor → hub | Final result |
| 10 | `MSG_LIVE` | hub → sensor | Report faster for a while; `duration_s = 0` stops |

---

## Remote Management

All of it is implemented and proven on hardware. The design notes live in
`OTA_UPDATE_PLAN.md`; the invariants that were learned the hard way are here,
because breaking one of them silently breaks a feature that still looks fine in
the logs.

### The listening window — the constraint everything else follows from

A sleeping node has its radio off. It cannot be reached on demand, and listening
often enough to be reachable would cost most of the battery. Every remote
instruction rides the **few hundred milliseconds after the node transmits**.

This has consequences that are not obvious:

- **Never do network I/O between receiving a reading and answering it.** The
  ESP-NOW receive callback runs in the WiFi task. An MQTT publish there is a
  blocking TLS write that routinely outlasts the node's listening window, and
  anything sent afterwards arrives at a sensor that has gone back to sleep. This
  caused three separate "the node is not listening" bugs. Anything the node must
  receive is sent **from the callback, before `updateSensor()`**; anything slow
  runs later from `loop()`.
- **Prepare before you need it.** A firmware offer is built when the image is
  *staged*, not when the sensor appears — building it needs an HTTP round trip
  to size the image, which does not fit in the window.
- Config and live requests reach a node on **any** wake. Firmware needs a
  **button press**, or an active live session (see below), because installing an
  image is a bigger commitment than changing a setting.

### Remote configuration

Sleep interval and the four calibration values (`sh_a`, `sh_b`, `sh_c`,
`r_series`), superadmin only, pushed from the dashboard. The node validates
before applying: bounds on each value, plus `shCoefficientsSane()`, which checks
the coefficients actually produce a falling NTC curve. **A rejected config is
silent from the cloud's point of view** — the sensor keeps reporting its old
`cfg_ver` and the cloud re-queues. The hub's serial log gives the reason.

`cfg_ver` is a fingerprint of the values, not a counter.

### Live mode

Asks a node to report every 30 s for 5 minutes, then return to normal.

It is a **temporarily shorter sleep interval, not a period of staying awake**.
The node keeps deep-sleeping between readings. Five minutes held awake costs
about 3.3 mAh; the same five minutes as ten short wakes costs about 0.4 mAh.
The count lives in RTC memory, so it survives sleep but not a power cycle, and
it counts **down** so a session whose end is never delivered still ends.

A live session is also a good time to change calibration: the change lands
within one interval instead of one reporting period, and you watch the result.

### Firmware OTA

Both hub and sensor, ECDSA P-256 signed, verified on-device before the new slot
is ever made bootable. The hub downloads over plain HTTP by design — the
signature is what protects the image, not the transport.

**Rollback is application-level, not bootloader-level.** The ESP-IDF bootloader
rollback never arms on this hardware: images boot straight to `VALID` rather than
`PENDING_VERIFY`, despite `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` being set. This
was discovered by testing, after being wrongly asserted from reading the config.
Both sides therefore count boots and revert themselves:

- **Hub** — reverts unless it reaches the cloud within `OTA_VERIFY_WINDOW_MS`
  (5 min), after `OTA_MAX_BOOT_TRIES` (3) attempts. Proven on hardware.
- **Sensor** — reverts unless a reading is *delivered*, after
  `OTA_MAX_BOOT_TRIES` (3) boots. A button press is a boot, so the revert can be
  forced in minutes. Proven on hardware with the `rollbacktest` build.

Both projects have a deliberately-broken `*_rollbacktest` env, versioned
`x.x.99`, whose only purpose is to fail so the revert can be observed. **Use
them.** Both rollback paths only became trustworthy once they had been seen to
work, and one of them was broken exactly where it was assumed to be fine.

### State is per sensor, never per hub

Firmware staging and live requests are **per-sensor actions driven from a
dashboard that lists every sensor**. Both were originally single hub-wide
variables, and both produced the same failure: staging or requesting for a
second sensor silently discarded the first, which then waited forever for
something that had already been thrown away — while the dashboard, which tracks
state per sensor in the database, went on showing it as pending.

The retained MQTT command topics are **also per sensor** for the same reason: a
shared topic retains only the last message written to it, so a hub restart came
back having forgotten every sensor but one.

If you add another per-sensor remote action, give it a slot per sensor and its
own retained topic. This mistake has been made twice.

### Timeouts on the two sides must not be equal

The hub waits for acknowledgements; the sensor re-asks after silence. When both
used 4000 ms they expired together, and the hub concluded the transfer was
finished at exactly the moment the node was about to ask for the missing piece.
The hub's wait is now deliberately longer than the sensor's retry interval.

Related: **accepting an image takes seconds, not milliseconds.** The node calls
`esp_ota_begin()` first, which erases about a megabyte of flash, and only then
answers. The accept window is 8 s for that reason. A window sized for a radio
round trip missed the answer every time the target partition was not already
blank — which is why the same update could fail repeatedly and then succeed
right after a power cycle.

### Publishing an image

```bash
cd tools/firmware-signing
./publish.sh                    # hub: build → sign → upload
./publish.sh --install all      # ...and stage on every hub
./publish.sh --sensor           # sensor image (wroom_v2 by default)
./publish.sh --sensor --env <name>
./publish.sh --list             # what is on the server
```

Build, sign and upload happen **in one step on purpose**. Rebuilding is not
reproducible — the ESP-IDF app descriptor embeds the build time — so a signature
produced from a separate build will not match. The script also URL-encodes the
signature: base64 contains `+`, which decodes to a space in a query string, and
the node downloads the entire image before rejecting it.

The version comes from the **tag compiled into the binary**, not from the source,
so a `build_flags` override (as `rollbacktest` uses) is published under the
version it actually is.

Staging a sensor image is **not** scriptable: it waits on a button press, so it
is chosen per sensor from the dashboard.

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

> **The divider is the other way round on v2.** v1 puts the NTC on the high
> side (`3.3 V → NTC → ADC → series R → GND switch`); the v2 PCB puts it on the
> low side. `BOARD_REV` selects `NTC_ON_LOW_SIDE`, which picks the resistance
> formula — `r_series * adcV / (vcc - adcV)` on v2 rather than the v1 form.
> Getting this backwards is not subtle in the field but is invisible in review:
> it read 2–4 °C as 40.87 °C.

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
| `MAX_SENSORS` | 10 | Also the size of the staging and live-request tables |
| `OFFLINE_BUFFER_SIZE` | 50 | Readings held in NVS while MQTT is down |
| `OTA_MAX_BOOT_TRIES` | 3 | Attempts before reverting to the other slot |
| `OTA_VERIFY_WINDOW_MS` | 300000 | 5 min per attempt → ~15 min to revert |
| `NTP_SYNC_INTERVAL` | 86400000 ms | Re-sync every 24 h |
| `gmtOffset_sec` / `daylightOffset_sec` | 7200 / 3600 | UTC+2, +1 h DST |

### Sensor (both variants)
| Constant | Value | Notes |
|----------|-------|-------|
| `SLEEP_TIME` | 900 s | Compiled default; overridden by cloud config |
| `CFG_SLEEP_MIN` / `MAX` | 300 / 3600 s | Accepted range for a pushed interval |
| `MAX_RETRIES` | 5 | TX attempts per wake |
| `RETRY_DELAY_MS` | 100 ms | Between retries |
| `TX_TIMEOUT_MS` | 500 ms | Wait for the ACK callback |
| `MAX_FAILED_WAKES_BEFORE_HIBERNATE` | 4 | ≈ 1 h of outage before button-only sleep |
| `ESPNOW_CHANNEL` | 0 | Auto-detect |
| `LIVE_MIN_INTERVAL_S` | 20 | Below this a wake is mostly overhead |
| `LIVE_MAX_DURATION_S` | 300 | 5 min |
| `OTA_MIN_BATTERY_PCT` | 40 | Below this an image is declined |
| `OTA_MAX_BOOT_TRIES` | 3 | Boots without a delivered reading before reverting |

### NTC variant only (`sensor-ntc/`)
| Constant | Value | Notes |
|----------|-------|-------|
| `NTC_SH_A` | 2.535e-3 | Steinhart-Hart A — cold-range fit, not a textbook value |
| `NTC_SH_B` | 3.01e-5 | Fitted from (−18.2 °C/81911 Ω, −7.2 °C/47214 Ω, +4 °C/26811 Ω) |
| `NTC_SH_C` | 7.23e-7 | SHT40 reference, cold-board operation |
| `SERIES_RESISTOR` | 10000 Ω | Use the **measured** value of the resistor on the board |
| `NTC_SAMPLES` | 20 | ADC readings averaged per measurement |
| `CFG_COEF_ABS_MAX` | 1e-1 | Magnitude bound on A/B/C |
| `CFG_RSERIES_MIN` / `MAX` | 1000 / 1000000 Ω | Deliberately wide — 47 kΩ and 100 kΩ are both in use |
| `BOARD_REV` | 1 or 2 | Selects pins **and** divider orientation |

All four calibration values are settable per sensor from the dashboard; the
compiled values are only defaults. Bounds on A/B/C are magnitude-only and are
backed by a physical check (`shCoefficientsSane`) rather than narrow numeric
ranges — an earlier invented range rejected a legitimate negative `B`.

### Encryption
| Item | Detail |
|------|--------|
| `PMK_KEY[16]` | Primary Master Key — identical on hub and every sensor |
| `LMK_KEY[16]` | Local Master Key — encrypts unicast data frames |
| Set via | `esp_now_set_pmk()` after `esp_now_init()` |
| Data peers | `encrypt = true` with `lmk` set |
| Pairing | Unencrypted broadcast by design; the hub upgrades the peer with `esp_now_mod_peer()` immediately after replying |

> The committed `PMK_KEY`/`LMK_KEY` are placeholders. Replace them before
> production, on the hub and every sensor together — a mismatch looks exactly
> like a sensor that has stopped reporting.

### Firmware signing

`FW_PUBLIC_KEY[]` in `hub/src/main.cpp` and `sensor-ntc/src/main.cpp` is the
**public** half of the OTA signing key: safe in git, safe to read off a device.
The private key lives only on the dev machine as
`tools/firmware-signing/fw-signing-key.pem`.

> **If the private key is lost, no hub or sensor can ever be updated over the
> air again.** Rotating it means shipping the new key inside an image signed
> with the old one, or the fleet is stranded. Keep an offline backup.

---

## Language / Framework

| Item | Detail |
|------|--------|
| Language | C++ (Arduino framework) |
| Target | ESP32-C6 (RISC-V) |
| Core | pioarduino platform-espressif32 |
| Build | **PlatformIO** — one project per device |
| Boards | `seeed_xiao_esp32c6` (v1), `esp32-c6-devkitm-1` + `board_build.variant = esp32c6` (v2 WROOM-1U) |
| Partitions | **`min_spiffs.csv`** on the hub — two 1920 KiB OTA slots. Replaced `huge_app.csv`, which had one app slot and could not support OTA. `nvs` sits at the same offset in both, so reflashing preserves credentials: **do not `erase_flash`** when migrating a provisioned hub. Sensors use the default table, which already has `app0`/`app1`. |
| Optimize | `-Os` |

### PlatformIO environments

| Env | Purpose |
|-----|---------|
| `xiao_esp32c6_hub` | Hub |
| `xiao_esp32c6_hub_rollbacktest` | Hub built to fail, for testing revert |
| `xiao_esp32c6_sensor_ntc` | NTC sensor on XIAO (v1) |
| `xiao_with_regulator_sensor_ntc` | v1 with external regulator |
| `wroom_v2_sensor_ntc` | **Deployed sensor hardware** |
| `wroom_v2_sensor_ntc_rollbacktest` | Sensor built to fail, for testing revert |

`FW_MAJOR`/`FW_MINOR`/`FW_PATCH` are wrapped in `#ifndef` in both firmwares so a
build env can override them. Adding a `-DFW_PATCH=` to an env that lacks those
guards silently produces an image labelled with the wrong version.

### Required Libraries
| Library | Source | Used in |
|---------|--------|---------|
| `WiFi.h`, `esp_now.h`, `esp_wifi.h`, `esp_sleep.h`, `Preferences.h`, `Wire.h`, `WebServer.h`, `time.h` | ESP32 core | as applicable |
| `esp_ota_ops.h`, `mbedtls/*` | ESP-IDF, via the core | OTA verify + signing |
| **NimBLE-Arduino** (`h2zero/NimBLE-Arduino@^2.0.0`) | Third-party | Hub — BLE provisioning |
| **PubSubClient** (`knolleary/PubSubClient@^2.8`) | Third-party | Hub — MQTT |
| **SensirionI2cSht4x** | Third-party | `sensor/` only |

WiFiManager is **no longer used** — BLE provisioning replaced it.

---

## Development Workflow

### Firmware

1. Edit in the relevant PlatformIO project.
2. `pio run -e <env>` to build.
3. Deploy over the air with `publish.sh` (see *Remote Management*), or flash
   over USB / ESP-PROG for a node that has no working image.

### Flashing v2 sensor-ntc hardware (bare WROOM-1U)

The v2 PCB has no USB-C. Flash with an **Espressif ESP-PROG** on the 2×3 IDC
`J_PROG` header.

1. Set the ESP-PROG VDD jumper to **3.3 V** — 5 V will damage the C6.
2. Plug the UART ribbon into `J_PROG` (pin 1 = EN, marked on silkscreen).
3. `pio run -e wroom_v2_sensor_ntc -t upload` — no buttons; ESP-PROG drives EN
   and BOOT through its auto-reset circuit.
4. `pio device monitor` reuses the same ESP-PROG at 115200 baud.

The ESP-PROG can power the board through pin 2 (3V3) for bench work, but
**disconnect the battery first** to avoid back-feeding the cell.

### Cloud

Runs on the droplet at `~/Temp-sensors/temp-sensors-cloud/` under docker compose.

```bash
git pull
docker compose up -d --build backend       # backend changes
cd frontend && npm run build               # frontend changes
```

`docker compose restart` does **not** pick up volume or environment changes —
use `up -d`, which recreates the container.

**Migrations are not automatic.** Files in `postgres/` run only on a fresh
volume, so every numbered migration since the first deploy has to be applied by
hand:

```bash
set -a; . ./.env; set +a
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < postgres/NN-name.sql
```

A missing column fails the whole `SELECT`, which surfaces as the entire
dashboard reporting "Failed to load sensors" rather than one absent field.

### First-time setup

1. Flash the hub → provision WiFi over BLE from the mobile app or
   `ble-provision.html`.
2. Flash a sensor → it broadcasts a pairing request and stores the hub MAC.
3. Approve the sensor from the dashboard if pairing approval is enabled.

### Resetting

- **Hub:** hold BOOT (GPIO 9) or external D0 (GPIO 0) for 3 s → NVS erased →
  BLE provisioning again.
- **Sensor:** hold D0 (GPIO 0) for 3 s → pairing erased → pairing mode. Works
  from deep sleep: the button wakes the node, then the held press is detected.

---

## Branch Strategy and Git Conventions

| Branch | Purpose |
|--------|---------|
| `main` | Stable; deployed from |
| `claude/<topic>` | AI-assisted work |

- Branch from **`origin/main`**, not local `main`, and open the PR against
  `main`. A PR based on another feature branch merges into that branch and
  never reaches `main`.
- **Check the PR state before pushing a follow-up** (`gh pr view <n> --json
  state`). Pushing to a branch whose PR has merged orphans the commit — it looks
  delivered and is not. This happened repeatedly before it was written down.
- Small, focused commits; imperative subject lines.
- Never commit secrets: WiFi credentials, MQTT passwords, the signing key.
- No force-pushes to `main`.

---

## Key Conventions for AI Assistants

### General
- **Read before editing.** Never change a file you have not read.
- **Minimal, requested changes.** No speculative abstractions or error handling
  for hypothetical cases.
- **Delete, don't deprecate.** Unused code goes.
- **Do not invent limits.** Ranges asserted from intuition have twice rejected
  values the hardware genuinely uses (`r_series` at 100 kΩ, a negative
  Steinhart-Hart `B`). Bound what is physically impossible, not what looks
  unusual, and prefer a physical check to a numeric one.
- **Test the safety path before claiming it works.** Bootloader rollback was
  asserted from reading `sdkconfig.h` and was wrong. Both rollback paths are now
  verified on hardware, and both projects ship a build whose purpose is to fail.

### ESP32-C6 specifics
- Always `esp_now_deinit()` and `esp_wifi_stop()` before `esp_deep_sleep_start()`
  — skipping this causes an illegal-instruction crash (`MCAUSE: 0x18`).
- **GPIO 0 (D0) is an LP GPIO and can wake from deep sleep. GPIO 9 (BOOT) cannot.**
- GPIO 15 is a strap pin; v2 moved the LED to GPIO 5.
- Serial needs ~500 ms after `begin()`; add short delays after GPIO and I2C init.
- Sensor error values use `-999` as the sentinel; battery uses `255`.
- `loop()` is intentionally empty on sensors.

### Working in the ESP-NOW callback
- It runs in the WiFi task. **No blocking network calls** — an MQTT publish
  there costs more time than a sleeping node will wait, and delays every frame
  queued behind it.
- Send anything the node must receive **before** `updateSensor()`.
- Hand anything slow to `loop()` via a flag.
- Take the radio (`sOtaRunning`) for the whole handshake, not just the transfer,
  and release it on **every** exit path.

### NVS / Preferences
- Reading an absent key logs an `[E]` line that looks like a failure. Guard with
  `isKey()` where absence is normal.
- Keep NVS writes out of the ESP-NOW callback — a commit there stalls the WiFi
  task while sensors are mid-transmission.

### Cloud
- `node-postgres` returns `bigint` as a **string**. Adding a number to one
  concatenates. This produced a countdown of 29767197071 minutes.
- Retained MQTT commands are the copy that survives a hub restart. Clear one
  only when retrying is pointless — an installed image, or one the node rejected
  and would reject identically. A transfer that merely failed should stay.

### Style
- Follow the conventions of the file you are editing.
- Comment the non-obvious: why a timeout has the value it has, why an order
  matters. Most of the bugs in this system were ordering and timing, and the
  comments recording them are load-bearing.

---

## Plan Documents

Plan files describe intent at the time of writing and drift from reality. Check
the code before trusting one.

| Document | Status |
|----------|--------|
| `CLOUD_MIGRATION_PLAN.md` | **Implemented.** Cloud, MQTT, PostgreSQL, React dashboard, BLE provisioning and the Expo app all exist and are deployed. |
| `OTA_UPDATE_PLAN.md` | **Implemented beyond what it describes.** Its status header predates hub OTA being exercised on hardware, sensor remote config, live mode, and sensor firmware OTA — all of which now work. Appendix A describes sensor OTA as deferred; it was built. |
| `LORAWAN_MIGRATION_PLAN.md` | **Not started.** ESP-NOW → LoRaWAN + ChirpStack, hub as a single-channel gateway. Entirely speculative; nothing in the codebase moves toward it. |
| `SESSION_SUMMARY.md` | Historical notes from one session. Not maintained. |

### Known gaps

- **`sensor/` (SHT40) has no OTA receiver.** Only `sensor-ntc/` can be updated
  over the air. The firmware registry distinguishes `hub` from `sensor` but not
  the two sensor variants, so nothing stops an NTC image being staged on an
  SHT40 node. Harmless today because those nodes cannot accept an image at all.
- **The local hub dashboard is a fallback**, not maintained in step with the
  cloud dashboard.

---

## Updating This File

Keep it current — it has been stale twice in ways that misled work: it described
the Beta approximation while the firmware used Steinhart-Hart, and the wrong
divider orientation after the v2 board flipped it.

Update when: pins or board revisions change, constants move, dependencies
change, a plan document's status changes, or a **new invariant is learned the
hard way**. That last one matters most. The sections above on the listening
window, per-sensor state, and unequal timeouts each exist because the same class
of bug was fixed more than once before anyone wrote down why it happened.
