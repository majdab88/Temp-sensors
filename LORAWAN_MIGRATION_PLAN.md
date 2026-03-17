# LoRaWAN Migration Plan — Optional / Future Project

> **Status:** Planning — not yet implemented
> **Priority:** Optional (future enhancement)
> **Prerequisite:** Current ESP-NOW + Cloud system (see `CLOUD_MIGRATION_PLAN.md`) should be stable first

---

## Goal

Replace ESP-NOW (short-range, WiFi-based) with **LoRaWAN** (long-range, sub-GHz) for
sensor-to-hub communication, while keeping:

- The existing hub as a custom single-channel LoRa gateway
- The existing web dashboard and mobile app (pairing approval, live data, history)
- Sensors tied to a specific hub by MAC ID
- ChirpStack as the LoRaWAN network server (self-hosted)

---

## Why LoRaWAN?

| | ESP-NOW (current) | LoRaWAN (proposed) |
|---|---|---|
| Range | ~100 m (line of sight) | 2–10 km (line of sight) |
| Obstacles | Walls reduce range significantly | Sub-GHz penetrates walls/floors far better |
| Power | WiFi radio — higher current draw | LoRa radio — lower TX current, longer battery life |
| Encryption | Manual PMK/LMK management | Built-in AES-128 (network + application layer) |
| Device management | Custom pairing protocol | Standardised OTAA join + ChirpStack device registry |
| Scalability | 10–20 sensors per hub | 100+ sensors per gateway (with multi-channel) |
| Trade-off | Simple, no extra hardware | Requires LoRa radio module on every device |

---

## Current vs Target Architecture

### Current

```
[Sensor 1..N]  ──ESP-NOW──►  [Hub ESP32-C6]  ──WiFi/MQTT──►  [Cloud]
                                    │                            │
                              Local Dashboard              Web Dashboard
                                                           Mobile App
```

### Target

```
[Sensor 1..N]  ──LoRa──►  [Hub ESP32-C6 + SX1262]  ──WiFi/UDP──►  [ChirpStack]
                           (single-channel gateway)                     │
                                    │                            ──MQTT──►  [Your Cloud]
                                    │                                          │
                              Local Dashboard                          Web Dashboard
                              (fed via MQTT from ChirpStack)           Mobile App
```

The hub serves dual roles:
1. **LoRa packet forwarder** — receives raw LoRa packets, wraps them in
   Semtech UDP protocol, forwards to ChirpStack Gateway Bridge
2. **Local dashboard** — subscribes to ChirpStack MQTT integration to
   populate the `sensors[]` array and serve the web UI

---

## Hardware Requirements

### LoRa Radio Module

Each device (hub + all sensors) needs an **SX1262** module connected via SPI.

Recommended modules:
- Waveshare SX1262 breakout (~$8)
- Ebyte E22-400M30S / E22-900M30S (~$6)
- HopeRF RFM95W (SX1276, also works but older) (~$5)

### Pin Wiring (XIAO ESP32-C6 + SX1262)

The SX1262 needs 6 GPIO connections. Pin assignments below are suggested —
adjust based on your PCB layout and which GPIOs are already in use.

#### Hub

| SX1262 Pin | ESP32-C6 GPIO | Notes |
|------------|---------------|-------|
| SCK | 19 (D8) | SPI clock |
| MOSI | 18 (D10) | SPI data out |
| MISO | 20 (D9) | SPI data in |
| NSS (CS) | 21 (D3) | Chip select |
| DIO1 (IRQ) | 22 (D4) | Interrupt — packet received |
| BUSY | 23 (D5) | Radio busy flag |
| RST | 3 (D7) | Radio reset (optional — can tie to MCU RST) |

> Hub no longer uses I2C (D4/D5) since it has no sensor. Those GPIOs are
> repurposed for LoRa DIO1 and BUSY.

#### Sensor — SHT40 Variant

SHT40 uses I2C on D4/D5, so LoRa pins must avoid those:

| SX1262 Pin | ESP32-C6 GPIO | Notes |
|------------|---------------|-------|
| SCK | 19 (D8) | SPI clock (shared with hub) |
| MOSI | 18 (D10) | SPI data out |
| MISO | 20 (D9) | SPI data in |
| NSS (CS) | 21 (D3) | Chip select |
| DIO1 (IRQ) | 3 (D7) | Interrupt |
| BUSY | — | Polled via NSS or tied to DIO1 if module supports it |
| RST | — | Tie to MCU RST |

> The SHT40 variant is tight on GPIOs. If insufficient pins remain, consider
> upgrading to an ESP32-S3 board for more GPIOs, or using a LoRa-integrated
> board (Heltec, TTGO).

#### Sensor — NTC Variant

NTC uses fewer GPIOs (no I2C), so more flexibility:

| SX1262 Pin | ESP32-C6 GPIO | Notes |
|------------|---------------|-------|
| SCK | 19 (D8) | SPI clock |
| MOSI | 18 (D10) | SPI data out |
| MISO | 20 (D9) | SPI data in |
| NSS (CS) | 23 (D5) | Chip select |
| DIO1 (IRQ) | 3 (D7) | Interrupt |
| BUSY | — | Polled or tied to DIO1 |
| RST | — | Tie to MCU RST |

---

## Single-Channel Gateway — Limitations & Justification

A full LoRaWAN gateway uses an **SX1302/SX1303 concentrator** that listens on
8 channels × 6 spreading factors simultaneously (49+ demodulation paths). The
SX1262 is a simple transceiver — it listens on **one frequency and one spreading
factor** at a time.

### Why Single-Channel Works For This Project

- 30 sensors at 15-min intervals = 2 transmissions/minute
- SF7 airtime per packet (~20 bytes): ~50 ms
- Channel occupancy: 100 ms / 60,000 ms = **0.17%**
- Collision probability: effectively zero

All sensors are configured to use the **same channel and SF**, which is a
deviation from the LoRaWAN spec but perfectly fine in a private network.

### OTAA Join on Single Channel

LoRaWAN OTAA Join-Requests are normally sent on one of 8 random join channels.
With a single-channel gateway, the hub only hears 1 of those 8.

**Workaround:** Force all sensors (in RadioLib config) to use only the one
channel the hub listens on. This violates the spec but works reliably in a
controlled, private deployment.

```cpp
// RadioLib — force single channel for OTAA join
LMIC_setupChannel(0, 868100000, DR_RANGE_MAP(DR_SF7, DR_SF7), BAND_CENTI);
// Disable channels 1–7
for (int i = 1; i < 8; i++) LMIC_disableChannel(i);
```

### Future: Multi-Channel Upgrade

If range diversity or capacity becomes an issue, stack **2–3 SX1262 modules**
on the hub (separate SPI chip selects), each on a different frequency/SF:

```
ESP32 Hub
├── SX1262 #1 (CS=GPIO_A)  → 868.1 MHz, SF7   (close sensors)
├── SX1262 #2 (CS=GPIO_B)  → 868.3 MHz, SF10  (mid-range)
└── SX1262 #3 (CS=GPIO_C)  → 868.5 MHz, SF12  (far sensors)
```

This would require an ESP32-S3 or similar board with more GPIOs. The firmware
architecture should be designed with this upgrade path in mind (radio abstraction
layer).

---

## ChirpStack Setup (Cloud Infrastructure)

### Components

ChirpStack v4 runs alongside the existing cloud stack:

```
docker-compose.yml (additions)
├── chirpstack           # Network server + application server (combined in v4)
├── chirpstack-gateway-bridge  # Receives Semtech UDP from hub, feeds to ChirpStack
├── chirpstack-redis     # Session storage
└── chirpstack-postgres  # Device registry, events (separate DB from your app)
```

### Configuration

| Item | Value |
|------|-------|
| Region | EU868 or US915 (match your hardware) |
| Gateway ID | Hub MAC (e.g. `AABBCCDDEEFF0000`) |
| Device profile | Class A, OTAA, CayenneLPP codec |
| Application | One per hub MAC (sensors grouped by hub) |
| Integration | MQTT — publishes decoded uplinks to your existing Mosquitto broker |

### ChirpStack MQTT Integration Topics

ChirpStack publishes decoded sensor data to:

```
application/{app_id}/device/{dev_eui}/event/up     — decoded uplink data
application/{app_id}/device/{dev_eui}/event/join    — OTAA join notification
application/{app_id}/device/{dev_eui}/event/status  — device status/battery
```

Your backend subscribes to these and routes data into the existing
`sensors/{hub_mac}/data` pipeline.

---

## Sensors Tied to Hub MAC

### Data Model

The existing relationship is preserved:

```
Hub (MAC: AABBCCDDEEFF)
├── ChirpStack Gateway ID: AABBCCDDEEFF0000
├── ChirpStack Application: "Hub-AABBCCDDEEFF"
│   ├── Device: sensor-001 (DevEUI: 1122334455660001)
│   ├── Device: sensor-002 (DevEUI: 1122334455660002)
│   └── Device: sensor-003 (DevEUI: 1122334455660003)
```

### Database Schema Changes

The existing `sensors` table adds a `dev_eui` column:

```sql
ALTER TABLE sensors ADD COLUMN dev_eui VARCHAR(16);  -- LoRaWAN DevEUI (hex)
-- mac column kept for backwards compatibility; dev_eui used for LoRaWAN devices
-- device_id still references the hub (devices table)
```

### MQTT Topic Mapping

ChirpStack topics are mapped to the existing topic structure by the backend:

```
ChirpStack publishes:
  application/{app_id}/device/{dev_eui}/event/up
  → { "temp": 22.5, "hum": 55.0, "battery": 85 }  (decoded CayenneLPP)

Your backend translates to:
  sensors/{hub_mac}/data
  → { "sensor_mac": "...", "dev_eui": "1122...", "temp": 22.5, ... }
```

The dashboard and app receive data in the same format as today.

---

## Pairing Flow — Option B (Approve via Dashboard/App)

This flow mirrors the current ESP-NOW pairing UX:

```
Sensor Node          Hub (Gateway)        ChirpStack         Your Cloud        Dashboard/App
    │                     │                    │                  │                  │
    │── Join-Request ───► │                    │                  │                  │
    │   (LoRa broadcast)  │                    │                  │                  │
    │                     │── UDP PUSH_DATA ──►│                  │                  │
    │                     │                    │                  │                  │
    │                     │                    │── Join rejected  │                  │
    │                     │                    │   (DevEUI not    │                  │
    │                     │                    │    registered)   │                  │
    │                     │                    │                  │                  │
    │                     │── Extracts DevEUI from raw packet    │                  │
    │                     │── MQTT publish ──────────────────────►│                  │
    │                     │   hub/{mac}/pair/request              │                  │
    │                     │   {"devEui":"1122..."}                │── WebSocket ────►│
    │                     │                    │                  │  "New sensor     │
    │                     │                    │                  │   wants to join" │
    │                     │                    │                  │                  │
    │                     │                    │                  │◄── Approve ──────│
    │                     │                    │                  │                  │
    │                     │                    │◄── REST API ─────│                  │
    │                     │                    │   POST /api/devices               │
    │                     │                    │   (creates device in              │
    │                     │                    │    hub's application)             │
    │                     │                    │                  │                  │
    │── Join-Request ───► │                    │                  │                  │
    │   (retry, ~30s)     │── UDP PUSH_DATA ──►│                  │                  │
    │                     │                    │── Join accepted! │                  │
    │                     │                    │   (device now    │                  │
    │◄── Join-Accept ─────│◄── UDP PULL_RESP ──│    registered)   │                  │
    │   (session keys)    │                    │                  │                  │
    │                     │                    │── MQTT event ───►│── WebSocket ────►│
    │                     │                    │  .../event/join  │  "Sensor joined" │
    │                     │                    │                  │                  │
    │── Uplink data ─────►│── UDP ────────────►│── MQTT ─────────►│── Dashboard ────►│
    │   (encrypted)       │                    │  decoded data    │  shows readings  │
```

### How the Hub Detects Unknown DevEUIs

The hub receives raw LoRa packets before forwarding them to ChirpStack. It can
parse the LoRaWAN MAC header to extract the DevEUI from Join-Request frames
(MType = 0x00). If the DevEUI is not in its local known-devices list, it
publishes a pairing request to MQTT.

```cpp
// Pseudo-code — hub packet inspection
void onLoRaPacket(uint8_t* data, int len) {
  // Forward everything to ChirpStack regardless
  sendSemtechUDP(data, len);

  // Inspect: is this a Join-Request?
  uint8_t mtype = (data[0] >> 5) & 0x07;
  if (mtype == 0x00 && len >= 23) {  // Join-Request
    uint8_t devEui[8];
    memcpy(devEui, &data[9], 8);  // DevEUI at bytes 9–16 (little-endian)

    if (!isKnownDevice(devEui) && pairingModeActive) {
      publishPairingRequest(devEui);
    }
  }
}
```

### Dashboard/App UI Changes

Minimal changes — the pairing approval screen works the same way:

| Current (ESP-NOW) | LoRaWAN |
|---|---|
| Shows sensor MAC address | Shows DevEUI (16 hex chars) |
| "Approve" → MQTT to hub → hub saves MAC | "Approve" → backend calls ChirpStack API → device registered |
| "Reject" → hub ignores | "Reject" → device not registered, join fails |

---

## Payload Encoding — CayenneLPP

Replace the `struct_message` binary struct with **CayenneLPP**, a standardised
IoT payload format that ChirpStack can decode automatically:

### Current (ESP-NOW)

```cpp
typedef struct struct_message {
  uint8_t msgType;   // 1 byte
  float   temp;      // 4 bytes
  float   hum;       // 4 bytes
  uint8_t battery;   // 1 byte
} struct_message;    // 10 bytes total
```

### Proposed (LoRaWAN — CayenneLPP)

```cpp
#include <CayenneLPP.h>
CayenneLPP lpp(51);  // 51-byte buffer

lpp.reset();
lpp.addTemperature(1, temp);        // 4 bytes: ch(1) + type(1) + value(2)
lpp.addRelativeHumidity(2, hum);    // 3 bytes: ch(1) + type(1) + value(1)
lpp.addAnalogInput(3, bat / 100.0); // 4 bytes: ch(1) + type(1) + value(2)
// Total: 11 bytes — well within LoRaWAN SF7 payload limit (222 bytes)
```

ChirpStack decodes this automatically when the device profile codec is set to
"CayenneLPP". The decoded JSON looks like:

```json
{
  "temperature_1": 22.5,
  "relative_humidity_2": 55.0,
  "analog_input_3": 0.85
}
```

For NTC-only sensors, omit `addRelativeHumidity()` — the field simply won't
appear in the decoded output. The backend handles missing `hum` the same way
it handles `-999` today.

---

## Firmware Changes — Sensor

### Libraries Changed

| Change | Library | Notes |
|--------|---------|-------|
| **Remove** | `esp_now.h`, `esp_wifi.h`, `WiFi.h` | No longer needed |
| **Add** | `RadioLib` | LoRa/LoRaWAN stack (SX1262 driver + LoRaWAN MAC) |
| **Add** | `CayenneLPP` | Payload encoding |
| Keep | `esp_sleep.h`, `Preferences.h` | Deep sleep + NVS |

### Code Changes

| Remove | Add / Modify |
|--------|-------------|
| ESP-NOW init, callbacks, peer management | RadioLib SX1262 init + LoRaWAN OTAA join |
| `PMK_KEY` / `LMK_KEY` | `DevEUI`, `AppEUI`, `AppKey` (LoRaWAN credentials) |
| `struct_message` + `esp_now_send()` | CayenneLPP encoding + `node.uplink()` |
| WiFi channel detection | Not needed (LoRa uses sub-GHz) |
| Pairing broadcast loop | OTAA join (automatic retry) |
| `goToSleep()` ESP-NOW deinit | `goToSleep()` radio sleep (`radio.sleep()`) |

### NVS Keys (Sensor)

| Current | LoRaWAN |
|---------|---------|
| `hubMac` (6 bytes) | `devEui` (8 bytes), `appEui` (8 bytes), `appKey` (16 bytes) |
| | `nwkSKey`, `appSKey`, `devAddr` — saved after successful join (ABP fallback) |

### Sensor Lifecycle

```
[Boot]
  ├── Read NTC / SHT40 + battery (unchanged)
  ├── Init SX1262 via RadioLib
  ├── Check NVS for saved session (nwkSKey, appSKey, devAddr)
  │   ├── Found → restore session (skip OTAA join)
  │   └── Not found → OTAA join (may take a few attempts on single-channel)
  ├── Encode payload as CayenneLPP
  ├── Send uplink (confirmed or unconfirmed)
  ├── radio.sleep()
  └── esp_deep_sleep_start()
```

---

## Firmware Changes — Hub

### Libraries Changed

| Change | Library | Notes |
|--------|---------|-------|
| **Remove** | `esp_now.h` | Replaced by LoRa radio |
| **Add** | `RadioLib` | SX1262 driver (receive mode) |
| Keep | Everything else | WiFi, MQTT, BLE provisioning, WebServer, NimBLE |

### Code Changes

| Remove (~400 lines) | Add (~300 lines) | Modify (~100 lines) |
|---------------------|-------------------|---------------------|
| `OnDataRecv()` ESP-NOW callback | `onLoRaPacket()` — receive + forward to ChirpStack | MQTT subscriptions — add ChirpStack integration topics |
| `OnDataSent()` callback | Semtech UDP packet forwarder (PUSH_DATA, PULL_DATA) | `sensors[]` population — from ChirpStack MQTT instead of ESP-NOW |
| `esp_now_init()` + peer management | SX1262 init + continuous receive mode | Dashboard HTML — show DevEUI, LoRa RSSI/SNR |
| `PMK_KEY` / `LMK_KEY` | UDP socket to ChirpStack Gateway Bridge | |
| Pairing via `MSG_PAIRING` | Join-Request DevEUI extraction + pairing request publish | |
| Channel detection / AP scanning | | |

### Hub Packet Forwarder

The hub implements a minimal **Semtech UDP packet forwarder** — the standard
protocol used by all LoRaWAN gateways to communicate with the network server:

```
Hub (SX1262)                    ChirpStack Gateway Bridge
     │                                    │
     │── PUSH_DATA (UDP port 1700) ──────►│  (raw LoRa packet + metadata)
     │◄── PUSH_ACK ──────────────────────  │
     │                                    │
     │── PULL_DATA (keepalive) ──────────►│
     │◄── PULL_ACK ──────────────────────  │
     │◄── PULL_RESP (downlink packet) ───  │  (e.g. Join-Accept)
     │── TX_ACK ─────────────────────────►│
     │                                    │
```

The PUSH_DATA payload is JSON with the raw packet base64-encoded:

```json
{
  "rxpk": [{
    "tmst": 12345678,
    "freq": 868.1,
    "chan": 0,
    "rfch": 0,
    "stat": 1,
    "modu": "LORA",
    "datr": "SF7BW125",
    "codr": "4/5",
    "rssi": -65,
    "lsnr": 7.5,
    "size": 23,
    "data": "BASE64_ENCODED_PACKET"
  }]
}
```

### Hub Data Flow (Post-Migration)

```
1. SX1262 receives LoRa packet
2. Hub wraps it in Semtech UDP, sends to ChirpStack Gateway Bridge
3. Hub also inspects the packet:
   - Join-Request from unknown DevEUI? → publish pair/request
   - Data uplink? → ignore (ChirpStack will decode and publish via MQTT)
4. ChirpStack decodes the packet, publishes to MQTT integration
5. Hub receives decoded data on MQTT (ChirpStack integration topic)
6. Hub populates sensors[] array from decoded data
7. Local dashboard + your cloud both receive the data
```

---

## Migration Phases

### Phase 1 — ChirpStack Infrastructure

1. Add ChirpStack containers to `docker-compose.yml`:
   - `chirpstack` (v4, all-in-one)
   - `chirpstack-gateway-bridge`
   - `chirpstack-redis`
   - `chirpstack-postgres` (separate from app DB)
2. Configure region (EU868 or US915).
3. Create a gateway profile and an initial application.
4. Enable MQTT integration → publishes to existing Mosquitto broker.
5. Verify ChirpStack web UI is accessible.

**Deliverable:** ChirpStack running, ready to accept gateway connections.

---

### Phase 2 — Backend Integration

1. Add ChirpStack REST API client to backend (for device registration).
2. Subscribe to ChirpStack MQTT integration topics:
   - `application/+/device/+/event/up` → route to `sensors/{hub_mac}/data`
   - `application/+/device/+/event/join` → notify dashboard "sensor joined"
3. Modify pairing approval handler:
   - On approve: call ChirpStack API `POST /api/devices` to register device
     under the hub's application.
   - On reject: do nothing (device stays unregistered, join fails).
4. Add `dev_eui` column to `sensors` table.
5. Map ChirpStack application IDs to hub MACs in config or DB.

**Deliverable:** Backend bridges ChirpStack ↔ existing dashboard/app pipeline.

---

### Phase 3 — Hub Firmware (LoRa Gateway)

1. Add SX1262 module to hub PCB/breadboard.
2. Add `RadioLib` to `platformio.ini`.
3. Remove all ESP-NOW code (~400 lines).
4. Implement SX1262 init + continuous receive mode.
5. Implement Semtech UDP packet forwarder (PUSH_DATA, PULL_DATA, TX via PULL_RESP).
6. Add Join-Request inspection for unknown DevEUI detection.
7. Subscribe to ChirpStack MQTT integration topics to populate `sensors[]`.
8. Update dashboard HTML: show DevEUI, LoRa RSSI/SNR instead of WiFi RSSI.

**Deliverable:** Hub receives LoRa packets and forwards to ChirpStack.

---

### Phase 4 — Sensor Firmware (LoRaWAN Node)

1. Add SX1262 module to sensor PCB/breadboard.
2. Replace ESP-NOW with RadioLib LoRaWAN:
   - Remove: `WiFi.h`, `esp_now.h`, `esp_wifi.h`
   - Add: `RadioLib`, `CayenneLPP`
3. Implement OTAA join (single-channel config — force one frequency).
4. Save session keys to NVS after successful join (skip re-join on subsequent boots).
5. Encode readings as CayenneLPP.
6. Send uplink, then `radio.sleep()` + `esp_deep_sleep_start()`.
7. Update factory reset to erase LoRaWAN session keys.

**Deliverable:** Sensor joins via OTAA, sends readings, sleeps.

---

### Phase 5 — Testing & Validation

1. Flash hub with LoRa gateway firmware.
2. Flash one sensor with LoRaWAN firmware.
3. Verify OTAA join succeeds (may take a few retries on single-channel).
4. Verify sensor data appears in ChirpStack web UI.
5. Verify data flows through to dashboard and app.
6. Test pairing approval flow:
   - Power on unregistered sensor → dashboard shows "New sensor" → approve → sensor joins on next retry.
7. Test factory reset on sensor → re-join.
8. Test range: walk sensor to various distances, verify reception.
9. Test 5+ sensors simultaneously — verify no collisions at 15-min interval.

---

## What Changes vs What Stays

| Component | Status | Notes |
|-----------|--------|-------|
| Sensor — SHT40/NTC reading | **Unchanged** | `readSensor()`, `readNTC()`, `getBatteryInfo()` |
| Sensor — deep sleep | **Modified** | `radio.sleep()` replaces `esp_now_deinit()` |
| Sensor — ESP-NOW comms | **Removed** | Replaced by RadioLib LoRaWAN |
| Sensor — pairing broadcast | **Removed** | Replaced by OTAA join |
| Sensor — factory reset button | **Modified** | Erases LoRaWAN session keys instead of hub MAC |
| Hub — ESP-NOW receive | **Removed** | Replaced by SX1262 LoRa receive |
| Hub — packet forwarder | **New** | Semtech UDP protocol to ChirpStack |
| Hub — WiFi + MQTT | **Unchanged** | Same connection to cloud |
| Hub — BLE provisioning | **Unchanged** | Still provisions WiFi + MQTT creds |
| Hub — local web dashboard | **Modified** | Data source changes from ESP-NOW to ChirpStack MQTT |
| Hub — pairing logic | **Modified** | Join-Request inspection replaces MSG_PAIRING handling |
| Cloud backend | **Modified** | Adds ChirpStack API client + MQTT topic mapping |
| Web dashboard | **Minor** | Show DevEUI instead of MAC; show LoRa RSSI/SNR |
| Mobile app | **Minor** | Same pairing UI; DevEUI instead of MAC in display |
| ChirpStack | **New** | Docker containers added to cloud stack |
| PMK/LMK keys | **Removed** | LoRaWAN handles encryption natively |
| Hardware | **Modified** | SX1262 module added to hub + all sensors |

---

## Capacity Planning

### Single-Channel (Initial)

| Parameter | Value |
|-----------|-------|
| Frequency | 868.1 MHz (EU) or 915.2 MHz (US) |
| Spreading factor | SF7 (best for short-medium range) |
| Bandwidth | 125 kHz |
| Airtime per uplink | ~50 ms (20-byte CayenneLPP payload) |
| Max sensors (15-min interval) | ~200 (before 1% duty cycle) |
| Max sensors (5-min interval) | ~60 |
| Practical limit | 30–50 sensors comfortably |

### Multi-Channel Upgrade (Future)

| Configuration | Sensors supported |
|---------------|-------------------|
| 2× SX1262 (2 channels, SF7+SF10) | 60–100 sensors, mixed range |
| 3× SX1262 (3 channels, SF7+SF10+SF12) | 100–150 sensors, full range diversity |
| SX1302 concentrator (replace hub radio) | 500+ sensors (full LoRaWAN gateway) |

---

## Open Decisions

| Question | Options | Notes |
|----------|---------|-------|
| LoRa frequency band | EU868 / US915 / other | Depends on your region's regulations |
| SX1262 module brand | Waveshare / Ebyte / HopeRF | Any SX1262-based module works with RadioLib |
| Sensor board | Keep XIAO ESP32-C6 + external SX1262 / switch to integrated LoRa board | XIAO is tight on GPIOs with SHT40 variant |
| ChirpStack hosting | Same VPS as cloud / separate | Same VPS is fine for <50 sensors |
| Session persistence | Save LoRaWAN session to NVS (skip re-join) / re-join every boot | Save session — reduces join traffic and latency |
| Downlink commands | Implement later / not needed | Could use for remote config (sleep interval, calibration) |
| CayenneLPP library | ElectronicCats/CayenneLPP / manual encoding | Library is simpler; manual saves ~2 KB flash |

---

## Dependencies on Current System

This migration assumes the following are already implemented and stable:

1. Cloud infrastructure (Phase 1–3 of `CLOUD_MIGRATION_PLAN.md`)
2. MQTT broker with hub authentication
3. Web dashboard with pairing approval UI
4. Mobile app with device management
5. Backend REST API + WebSocket

Do **not** start this migration until the ESP-NOW + cloud system is working
end-to-end. LoRaWAN adds a new communication layer — it should not be debugged
alongside cloud infrastructure issues.
