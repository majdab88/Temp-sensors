# sensor-wifi — mains-powered WiFi NTC sensor with battery backup

A standalone NTC temperature sensor that connects **directly to WiFi and the
cloud**, with no hub. Powered from USB-C, with a rechargeable 1S Li-ion cell
that takes over when mains power is lost. Programmed with an ESP-PROG on the
same 2×3 header as sensor-ntc v2, not over USB-C.

Status: **design written; firmware builds (`pio run -e wifi_sensor`) but is
untested on hardware; PCB and enclosure not started; cloud changes (§7) not
started.**

---

## 1. Why it is built this way

### It presents itself to the cloud as a hub with one sensor

The cloud, the broker ACL and the mobile app already understand hubs. A hub
publishes `sensors/<HUB_MAC>/data` with a `sensor_mac`, and the backend
auto-creates the sensor row on the first reading. This device publishes the same
messages with **`sensor_mac` = its own MAC**, so on day one it gets:

| Feature | Comes from |
|---|---|
| Registration | The existing app flow: BLE provisioning, then `POST /api/devices/register` |
| Dashboard, history, alarms, excursions, push | `sensors/<mac>/data`, unchanged |
| Online/offline | Retained `sensors/<mac>/status` + LWT, as a hub does |
| Remote calibration + interval | `sensors/<mac>/config/set` (the hub's per-sensor config, addressed to itself) |
| Live mode | `sensors/<mac>/live/request` |
| Signed firmware OTA | `sensors/<mac>/ota/command`, the hub OTA path, with the same rollback scheme |

The BLE GATT service is the hub's, byte for byte, and the device advertises as
`TempHub-XXXXXX-W`. The app filters on the `TempHub-` prefix, so it finds it
without a rebuild.

What this does **not** give for free is listed in [§7 Cloud changes](#7-cloud-changes).

### The outage is the reason the battery exists — so expect WiFi to be down too

When mains power fails, the WiFi router usually fails with it. A backup battery
that only keeps the sensor trying to reach an absent network protects nothing.
So the device is a **data logger first**:

- Every reading is written to a flash ring log **before** any upload is tried.
- Uploading drains the log oldest-first. A record is marked uploaded only after
  an MQTT round-trip proves the broker has everything before it (see §4.4).
- On battery, a failed upload backs off to one attempt per 30 minutes while
  readings keep being logged every interval. Logging costs ~0.1 s awake; a WiFi
  attempt costs 3–8 s. Separating the two is what makes the backup last weeks.
- The ring holds 8 192 readings: **28 days at a 5-minute interval**.

When power and WiFi return, the whole outage — including any excursion during
it — reaches the dashboard with its original timestamps.

### Timestamps have to survive the outage without NTP

On battery the clock runs from the RTC through deep sleep. The ESP32-C6's
internal 136 kHz RC drifts by up to several percent with temperature, which over
a multi-day outage is hours. The board therefore carries a **32.768 kHz crystal**
on GPIO0/1, to be selected as the RTC slow clock. NTP re-syncs on every
successful connection.

**Not yet enabled in firmware.** It is `CONFIG_RTC_CLK_SRC_EXT_CRYS=y` through
pioarduino's `custom_sdkconfig`, which rebuilds the framework. On the dev machine
that rebuild fails, because the `tool-cmake` and `tool-ninja` packages are empty.
Until it is fixed, the build runs on the internal RC. Do it at bring-up, on a
board where the crystal can be seen to start.

A reading taken before the clock was ever set (cold boot with no WiFi) is sent
without `ts`, and the backend stamps it on arrival. Mains mode holds its first
reading for up to 60 s waiting for NTP, so this is rare.

### Mains mode and battery mode are different programs

| | Mains (USB-C present) | Battery |
|---|---|---|
| Radio | WiFi + MQTT held connected (modem sleep) | Off; deep sleep between readings |
| Readings | Every interval, uploaded immediately | Every interval, logged; uploaded with back-off |
| Remote commands | Applied immediately | Applied on the next successful upload |
| Firmware OTA | Accepted | **Deferred** until mains returns |
| Live mode | Immediate | Applied when next connected |
| Transition | PGOOD rises → reading flagged `power:battery`, upload attempt, then battery mode | PGOOD falls → wakes the chip at once → mains mode |

---

## 2. Block diagram

```
 USB-C (power only) ──► PTC + TVS ──► BQ24074 ──OUT (4.4 V on USB / VBAT on battery)──► TPS63802 ──► 3V3
   CC1/CC2 = 5k1 Rd                    │  │ │                                         buck-boost
                                       │  │ └─ /PGOOD ──► GPIO7 (LP, wakes from deep sleep)
                                       │  └─── /CHG ───► GPIO4
                                       BAT ──── P-FET (reverse) ── fuse ── 18650 in holder; board NTC under it → TS
                                       └─── 100k/100k divider (switched by GPIO21) ──► GPIO2 ADC

 3V3 ── 47k 0.1 % ──┬── GPIO3 ADC (100 nF, ESD diode)
                    └── screw terminal ── NTC probe (via cable gland) ── GPIO22 (low-side enable switch)

 J_PROG 2×3 (EN 3V3 TXD GND RXD IO0) ──► ESP-PROG, which drives EN and GPIO9 itself
 32.768 kHz XTAL on GPIO0/GPIO1 · LED on GPIO5 · user button on GPIO6
```

## 3. Hardware

### 3.1 Pin map (ESP32-C6-WROOM-1U-N4, as sensor-ntc v2)

| GPIO | Function | Notes |
|---|---|---|
| 0, 1 | 32.768 kHz crystal (XTAL_32K_P/N) | 2 × 12 pF load caps; this is why the NTC is no longer on GPIO1 |
| 2 | Battery ADC (ADC1_CH2) | 100k/100k from BAT; 10 nF to GND |
| 3 | NTC ADC (ADC1_CH3) | 100 nF to GND, ESD diode — the probe cable is an antenna |
| 4 | BQ24074 `/CHG` | Open drain, 100 k pull-up; LOW = charging. MTMS strap, inert unless the JTAG eFuse is burned |
| 5 | Status LED | Via 1 k. MTDI strap, inert as above. Same pin as sensor-ntc v2 |
| 6 | User button | Active low, 10 k pull-up + 100 nF. LP GPIO → deep-sleep wake |
| 7 | BQ24074 `/PGOOD` | Open drain, 100 k pull-up; LOW = USB power present. LP GPIO → deep-sleep wake |
| 8 | Strap | 10 k pull-up (must be high at boot) |
| 9 | BOOT strap | 10 k pull-up; → `J_PROG` pin 6 (IO0) |
| 12, 13 | USB D−/D+ | **Not connected.** USB-C is power-only by choice |
| 15 | Strap | Left floating (internal pull-up, boot log on) |
| 16 / 17 | U0TXD / U0RXD | `J_PROG` pin 3 (ESP_TXD) / pin 5 (ESP_RXD) |
| 21 | Battery divider enable | LOW = on, Hi-Z otherwise |
| 22 | NTC divider enable | LOW = on, Hi-Z otherwise |
| EN | Reset | 10 k pull-up, 1 µF to GND; → `J_PROG` pin 1 |

The NTC sits on the **low side**, like sensor-ntc v2:
`R = r_series · V / (3.3 − V)`. The series resistor is **47 kΩ**, not 10 k:
with 10 k a freezer probe (≈ 82 kΩ at −18 °C) drives the ADC to 2.9 V, into the
non-linear top of the ADC range. With 47 k, −18 °C reads 2.1 V, +4 °C 1.2 V and
+25 °C 0.6 V — the whole cold-chain range in the linear region.

### 3.2 Power

| Block | Part | Detail |
|---|---|---|
| USB-C receptacle | 16-pin SMD (e.g. HRO TYPE-C-31-M-12) | CC1, CC2 → 5.1 kΩ to GND each; D+/D− unconnected; shield via 1 MΩ ‖ 4.7 nF |
| Input protection | 1206 PTC 1.1 A hold + SMF5.0A TVS | |
| Charger / power path | **TI BQ24074RGTR** (VQFN-16) | OUT regulated to 4.4 V with input present, OUT = BAT without. 10.5 V OVP. Dynamic power-path: the load is served first, the cell charges from what is left |
| Input current limit | R_ILIM ≈ 1.5 kΩ, EN1=0 EN2=1 | ≈ 1 A from the USB source. **Verify K_ILIM in the datasheet** |
| Charge current | R_ISET ≈ 1.8 kΩ | ≈ 0.5 A ≈ 0.15 C for a 3000–3500 mAh cell. Slow and gentle on a cell that sits full for years. **Verify K_ISET** |
| Battery temperature | TS ← 10 k NTC (0603, B ≈ 3435) on the PCB, under the holder, in contact with the cell | No charging below 0 °C or above 45 °C — required for Li-ion. A loose 18650 has no thermistor of its own, so the board supplies one |
| Reverse polarity | P-MOSFET high side (e.g. DMG2305UX), gate to GND | A cell in a holder **will** be put in backwards sometimes. Conducts both ways when the cell is right (charge and discharge), blocks when it is reversed |
| Cell fuse | 1206 fast fuse, 2–3 A, in series with the cell | An 18650 can deliver tens of amps into a fault |
| 3.3 V rail | **TI TPS63802** buck-boost | Same part, inductor and divider as sensor-ntc v2 (L 1.5 µH, 560k/100k, MODE = GND). Accepts 1.3–5.5 V, so it covers 4.4 V (USB) and 3.0–4.2 V (cell) |
| Bulk | 22 µF on OUT, 22 µF + 100 µF on 3V3 | WiFi TX peaks ~350 mA |
| Battery | **18650 Li-ion, 3000–3500 mAh, protected, button top**, in a PCB-mounted holder (Keystone 1042 SMT / 1043 THT or equivalent) | Protected cells are 69–70 mm, longer than bare ones. **Check the holder takes that length.** Whether to add on-board DW01A + FS8205A protection, so a bare cell is also safe, is open: it has to be reconciled with the reverse-polarity FET in the schematic |

**Do not use the cell side for anything but the divider.** All loads hang off
OUT through the TPS63802, so the charger's power path decides the source, not
the firmware.

### 3.3 Programming — `J_PROG`, same header as sensor-ntc v2

2×3 IDC, 2.54 mm, ESP-PROG UART pinout. The ESP-PROG ribbon plugs straight in,
and one programmer covers both products.

```
       ┌──────────────────┐
   1 ──│  EN       3V3    │── 2
   3 ──│  ESP_TXD  GND    │── 4
   5 ──│  ESP_RXD  IO0    │── 6   (IO0 = GPIO9 BOOT on the C6)
       └──────────────────┘
```

- The ESP-PROG's auto-reset circuit drives EN and IO0, so
  `pio run -t upload` needs no buttons. Nothing on this board does it: no
  transistors, and no RESET or BOOT buttons, same as v2.
- **Pin 2 (3V3) ties to this board's 3V3 rail, where the TPS63802 is always
  running** — the Li-ion cell is inside the box and stays connected. Two 3.3 V
  sources would fight. Either take the ESP-PROG's power-select jumper off
  (no VDD on pin 2) and power the board from USB-C, or take the 18650
  out of its holder, unplug USB-C, and let the ESP-PROG power it. Either way, if the
  jumper is on it must be at **3.3 V**: 5 V destroys the C6.
- Serial monitor uses the same ESP-PROG at 115200 baud.

### 3.4 Power budget (battery)

| State | Current | Per event |
|---|---|---|
| Deep sleep (C6 + TPS63802 Iq + BQ24074 battery leakage) | ≈ 25 µA | 0.6 mAh/day |
| Log-only wake | ≈ 25 mA × 0.15 s | 0.001 mAh |
| Upload wake (WiFi assoc + TLS + publish) | ≈ 90 mA × 4 s | 0.10 mAh |

At a 5-minute interval with WiFi available: 288 uploads/day ≈ **30 mAh/day →
~3 months** on a 3000 mAh 18650. With WiFi down (router also off): 1 attempt per
30 min ≈ 6 mAh/day → well over a year of logging. The 28-day ring is the real
limit: past that, the oldest unsent readings are overwritten.

Thresholds on battery: below **3.45 V** WiFi is not attempted (logging only);
below **3.30 V** the device hibernates and wakes only when USB returns or the
button is pressed. The cell's own protection board is the last line, around 2.5–3 V.

### 3.5 BOM summary

| Ref | Part | Qty |
|---|---|---|
| U1 | ESP32-C6-WROOM-1U-N4 (u.FL), the sensor-ntc v2 module | 1 |
| ANT1 | 2.4 GHz antenna: u.FL → SMA bulkhead pigtail (~100 mm) + SMA rubber-duck dipole | 1 |
| U2 | BQ24074RGTR | 1 |
| U3 | TPS63802DLAR / DMQR (whichever sensor-ntc v2 used) | 1 |
| L1 | 1.5 µH ≥ 2 A shielded (TDK MLP2520H1R5) | 1 |
| Y1 | 32.768 kHz, 12.5 pF, 3215 | 1 |
| J1 | USB-C 16-pin receptacle | 1 |
| J2 | 2-pin pluggable screw terminal, 3.5 mm pitch (probe) | 1 |
| — | Cable gland PG7 / M12 (3–6.5 mm cable), nylon, IP68 | 1 |
| BH1 | 18650 holder, PCB-mounted on the back side | 1 |
| J4 | 2×3 2.54 mm shrouded IDC header (`J_PROG`, as sensor-ntc v2) | 1 |
| SW1 | Tact switch: USER (GPIO6) | 1 |
| D1 | SMF5.0A (VBUS TVS) | 1 |
| D2 | PESD5V0S1BL (probe ESD) | 1 |
| D3 | Status LED 0603 | 1 |
| F1 | PTC 1.1 A 1206 | 1 |
| R | 47 k 0.1 % (NTC series), 2 × 100 k 1 % (battery), 560 k / 100 k 1 % (FB), 2 × 5.1 k (CC), R_ISET, R_ILIM, pull-ups | — |
| BT1 | 18650 Li-ion 3000–3500 mAh, protected, button top | 1 |
| Q1 | DMG2305UX P-MOSFET (reverse polarity) | 1 |
| F2 | Fuse 2–3 A 1206 (cell) | 1 |
| RT1 | 10 k NTC 0603 (battery temperature, under the holder) | 1 |

---

## 4. Firmware (`firmware/`)

PlatformIO, Arduino on pioarduino. Envs: `wifi_sensor`, and
`wifi_sensor_rollbacktest` (`1.0.99`, never reaches the cloud, must revert by
itself). Image is 1.54 MB of the 1.92 MB OTA slot. Files:

| File | Role |
|---|---|
| `config.h` | Pins, constants, version, defaults |
| `main.cpp` | Boot, mode selection, mains loop, battery cycle |
| `measure.*` | NTC (Steinhart-Hart, low-side), battery, power source |
| `datalog.*` | Flash ring log in the `datalog` partition |
| `settings.*` | Calibration + interval in NVS, validated |
| `cloud.*` | WiFi, NTP, MQTT topics, commands, upload with round-trip barrier |
| `ota.*` | Signed OTA + app-level rollback (the hub's scheme) |
| `ble_prov.*` | BLE provisioning (the hub's GATT service) |

### 4.1 Boot

1. Pins, LED. Button held 3 s → erase WiFi + cloud credentials → reboot into provisioning.
2. OTA boot-state check (rollback counter).
3. Not provisioned → BLE provisioning (same flow and app as a hub).
4. `/PGOOD` LOW → mains mode, else battery mode.

### 4.2 Mains mode

`loop()` keeps WiFi and MQTT up, takes a reading every interval (or every 30 s
during live mode), logs it, drains the log, handles commands and OTA, re-syncs
NTP every 6 h, and watches `/PGOOD`. Losing it for 500 ms switches to battery
mode after one immediate reading.

### 4.3 Battery mode

Each wake: read → log → if WiFi is due (not backing off, cell ≥ 3.45 V) connect,
sync NTP, publish status, drain log, apply retained commands, disconnect → deep
sleep. Wake sources: timer, button (GPIO6), USB return (GPIO7).

Back-off after failed uploads: 1, 2, 4, then every 6 wakes (≤ 30 min at 5 min).

### 4.4 Upload barrier

PubSubClient publishes at QoS 0, so "publish returned true" only means the bytes
reached the socket. After a batch the device publishes a nonce to
`sensors/<mac>/wifi/echo`, to which it is subscribed, and waits for it to come
back. MQTT preserves order on one connection, so the echo proves every earlier
publish reached the broker. Only then are those records marked uploaded (one
flash byte each, 0xFF → 0x00, no erase).

Duplicates are possible if the device dies between the echo and the mark; the
backend should ignore a reading with the same sensor and timestamp (§7).

### 4.5 OTA

Same command, signing key, verification and rollback as the hub. Two additions:

- The image must contain the marker `TEMPWIFI_FW=`. A hub or ESP-NOW sensor
  image is rejected **before** the slot is made bootable. Hub and wifi-sensor
  images are signed with the same key, and today the cloud would offer hub
  images to this device (§7), so this check is the actual guard.
- Refused on battery. The retained command is delivered again on the next
  mains connection.

A new image confirms itself when a reading is **delivered** (barrier passed),
and reverts after 3 boots without that, or after 5 minutes in mains mode.

---

## 5. PCB (`pcb/`) — not started

- 2-layer, ~85 × 45 mm, 1.6 mm. Sized by the 18650 holder (77 × 21 mm). The
  WROOM-1U has no on-board antenna, so no keep-out constrains the layout, and
  the cell can run the full length under the module.
- u.FL at the module, near the top edge. The pigtail runs to an SMA bulkhead
  in the enclosure's top face, so the antenna can be replaced by a remote one
  with an extension cable if the device ends up behind a metal cabinet.
- USB-C and the probe screw terminal on the bottom short edge, so cables leave
  the enclosure together at the bottom when wall-mounted. Terminal entry faces
  the cable gland.
- 18650 holder on the **back side**, along the long axis. RT1 sits under the
  holder's middle, where the cell touches it.
- BQ24074 thermal pad stitched to the ground pour (it dissipates ~0.5 W
  while charging from 5 V).
- NTC ADC trace short and guarded, away from the TPS63802 switch node and L1.
- Draw in KiCad 10 (Copperpour MCP), not PCBCraft.

## 6. Enclosure (`enclosure/`) — not started

- Wall-mounted outside the fridge/freezer. The probe enters through the door
  gasket on a flat-section cable. The electronics, and above all the Li-ion
  cell, stay at room temperature: **Li-ion must not be charged below 0 °C**.
  The BQ24074 TS input enforces that through RT1 under the cell.
- Two-part printed PETG box, ~95 × 55 × 40 mm plus gland and SMA (sized by the
  18650 under the board): base with keyhole slots, lid with a light pipe for the LED and a
  pin-hole for the button. The lid comes off without tools so the cell can be
  swapped. Mark the cell polarity on the base, next to the holder.
- Bottom face: USB-C cut-out and a PG7 (M12) cable gland for the probe cable.
  Leave ~25 mm inside the gland for the cable to bend to the screw terminal,
  and a strain-relief rib so a pull on the probe lands on the gland, not the
  terminal.
- Top face: SMA bulkhead (D-flat hole, 6.4 mm) for the antenna.
- Vents are unnecessary at < 0.5 W, but give the charger area 2 mm clearance
  to the lid.
- Model in SolidCraft around the KiCad STEP once the board exists.

## 7. Cloud changes

Needed before this device is first-class. None block bring-up: it reports,
alarms and takes config on the existing backend.

| # | Change | Why |
|---|---|---|
| C1 | `firmware_images.device_kind` accepts `'wifi'`; upload checks the `TEMPWIFI_FW=` tag; `publish.sh --wifi` | Without it, the only image kind that can be pushed to this device is `hub` — which it will refuse |
| C2 | `devices.kind` (`'hub'` / `'wifi'`), set from `kind` in the status payload | Offer the right image kind; hide the hub-only pairing UI for this device |
| C3 | Unique `(sensor_id, recorded_at)` on readings, `ON CONFLICT DO NOTHING` | A backlog may be re-sent after a power cut mid-upload |
| C4 | Store `power` (`mains`/`battery`) and `charging` from status/data; show a badge | "On battery" is the actual signal of a power failure at the site |
| C5 | Alert rule "mains power lost" on the mains→battery transition | The most useful alarm this device can raise that no other one can |
| C6 | Don't evaluate temperature alerts for readings older than e.g. 1 h as *new* events; record them as backfilled excursions | Otherwise a backlog upload fires a burst of stale push notifications |
