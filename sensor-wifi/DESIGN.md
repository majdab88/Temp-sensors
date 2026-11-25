# sensor-wifi — mains-powered WiFi NTC sensor with battery backup

A standalone NTC temperature sensor that connects **directly to WiFi and the
cloud**, with no hub. Powered from USB-C, with a rechargeable 1S Li-ion cell
that takes over when mains power is lost. Programmed with an ESP-PROG on the
same 2×3 header as sensor-ntc v2, not over USB-C.

Status: **design written; schematic drawn (ERC clean); firmware builds (`pio run -e wifi_sensor`) but is
untested on hardware; PCB layout and enclosure not started; cloud changes (§7) not
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
                                       │  └─── /CHG ───► GPIO18
                                       BAT ──── reverse protection (open) ── fuse ── 18650 ── DW01A + FS8205A ── GND
                                                                          board NTC under the cell → TS
                                       └─── 100k/100k divider (switched by GPIO21) ──► GPIO2 ADC

 3V3 ── PTC ── screw terminal ── NTC probe (via cable gland) ──┬── GPIO3 ADC (100 nF, ESD diode)
                                                               └── 10k 0.1 % ── GPIO22 (enable switch)

 J_PROG 2×3 (EN 3V3 TXD GND RXD IO0) ──► ESP-PROG, which drives EN and GPIO9 itself
 32.768 kHz XTAL on GPIO0/GPIO1 · LED on GPIO5 · user button on GPIO6
```

## 3. Hardware

### 3.1 Pin map (ESP32-C6-MINI-1U-H4)

The module is the **ESP32-C6-MINI-1U-H4**: 4 MB in-package flash, rated
−40 to 105 °C, u.FL antenna, 13.2 × 12.5 mm. JLCPCB stocks it, so the board can be
assembled there. It replaced the WROOM-1U-N4 after layout. The GPIOs used are
the same, so the firmware did not change. The MINI does not bring out
IO10/IO11 (the in-package flash takes them), and nothing here used them.

| GPIO | Function | Notes |
|---|---|---|
| 0, 1 | 32.768 kHz crystal (XTAL_32K_P/N) | 2 × 12 pF load caps; this is why the NTC is no longer on GPIO1 |
| 2 | Battery ADC (ADC1_CH2) | 100k/100k from BAT; 10 nF to GND |
| 3 | NTC ADC (ADC1_CH3) | 100 nF to GND, ESD diode — the probe cable is an antenna |
| 5 | Status LED | Via 1 k. MTDI strap, inert as above. Same pin as sensor-ntc v2 |
| 6 | User button | Active low, 10 k pull-up + 100 nF. LP GPIO → deep-sleep wake |
| 7 | BQ24074 `/PGOOD` | Open drain, 100 k pull-up; LOW = USB power present. LP GPIO → deep-sleep wake |
| 8 | Strap | 10 k pull-up (must be high at boot) |
| 9 | BOOT strap | 10 k pull-up; → `J_PROG` pin 6 (IO0) |
| 12, 13 | USB D−/D+ | **Not connected.** USB-C is power-only by choice |
| 15 | Strap | Left floating (internal pull-up, boot log on) |
| 18 | BQ24074 `/CHG` | Open drain, 100 k pull-up; LOW = charging. Moved off GPIO4, which is a C6 strapping pin (MTMS) |
| 16 / 17 | U0TXD / U0RXD | `J_PROG` pin 3 (ESP_TXD) / pin 5 (ESP_RXD) |
| 21 | Battery divider enable | LOW = on, Hi-Z otherwise |
| 22 | NTC divider enable | LOW = on, Hi-Z otherwise |
| EN | Reset | 10 k pull-up, 1 µF to GND, RESET button (SW1, as v2); → `J_PROG` pin 1 |
| 4, 10, 11, 15, 19, 20, 23 | Free | Unconnected |

The NTC sits on the **high side**, as in the original v1 design:
`3V3 → NTC → ADC → 10 kΩ → GPIO22`, so `R = r_series · (3.3 − V) / V`.
(sensor-ntc v2 is the other way round. The formula must match the board: the
wrong one read a +4 °C probe as +41 °C.)

A cold probe has a high resistance, which keeps the ADC low, where it is
accurate. Using the deployed probe's calibration points: −18 °C (81.9 kΩ)
reads 0.36 V, −7 °C (47.2 kΩ) 0.58 V, +4 °C (26.8 kΩ) 0.90 V and +25 °C
1.65 V. The ADC runs at 11 dB. On the C6, 6 dB saturates near 1.3 V, below
room temperature.

**A side effect of the high side: one probe wire carries 3V3 continuously.**
A probe cable crushed in a door gasket against an earthed fridge body would
short the 3.3 V rail, if board ground is earthed through the USB supply. A
50 mA-hold 0805 PTC between 3V3 and the terminal limits that to a fault
reading instead of a browned-out device. Its few ohms are 0.05 % of 10 kΩ,
which is negligible.

### 3.2 Power

| Block | Part | Detail |
|---|---|---|
| USB-C receptacle | 16-pin SMD (e.g. HRO TYPE-C-31-M-12) | CC1, CC2 → 5.1 kΩ to GND each; D+/D− unconnected; shield via 1 MΩ ‖ 4.7 nF |
| Input protection | 1206 PTC 1.1 A hold + SMF5.0A TVS | |
| Charger / power path | **TI BQ24074RGTR** (VQFN-16) | OUT regulated to 4.4 V with input present, OUT = BAT without. 10.5 V OVP. Dynamic power-path: the load is served first, the cell charges from what is left |
| Input current limit | R_ILIM ≈ 1.5 kΩ, EN1=0 EN2=1 | ≈ 1 A from the USB source. **Verify K_ILIM in the datasheet** |
| Charge current | R_ISET ≈ 1.8 kΩ | ≈ 0.5 A ≈ 0.15 C for a 3000–3500 mAh cell. Slow and gentle on a cell that sits full for years. **Verify K_ISET** |
| Battery temperature | TS ← 10 k NTC (0603, B ≈ 3435) on the PCB, under the holder, in contact with the cell | No charging below 0 °C or above 45 °C — required for Li-ion. A loose 18650 has no thermistor of its own, so the board supplies one |
| Reverse polarity | **Open — see below.** | A cell in a holder **will** be put in backwards sometimes, with or without USB present |
| Cell protection | **DW01A + FS8205A** (dual N-FET) in the cell's negative leg | The board cannot know whether a protected cell was fitted, so it protects every cell itself. Over-charge ~4.3 V, over-discharge ~2.4 V, over-current/short ~3 A. A protected cell just ends up with two protectors in series |
| Cell fuse | 1206 fast fuse, 2–3 A, in series with the cell | Last resort if both protectors fail short. An 18650 can deliver tens of amps |
| 3.3 V rail | **TI TPS63802** buck-boost | Same part, inductor and divider as sensor-ntc v2 (L 1.5 µH, 560k/100k, MODE = GND). Accepts 1.3–5.5 V, so it covers 4.4 V (USB) and 3.0–4.2 V (cell) |
| Bulk | 22 µF on OUT, 22 µF + 100 µF on 3V3 | WiFi TX peaks ~350 mA |
| Battery | **Any 18650 Li-ion**, protected or not, 2500–3500 mAh, in a PCB-mounted holder | The holder must take **65 mm flat-top bare cells and 70 mm button-top protected cells alike**: a spring contact at one end, a contact that reaches a recessed flat top at the other. Choose and check it on real cells of both kinds |

**Do not use the cell side for anything but the divider.** All loads hang off
OUT through the TPS63802, so the charger's power path decides the source, not
the firmware.

#### Battery protection

**Requirement:** any 18650 may be fitted, protected or bare, either way round.
Nothing on the board may be damaged, and nothing may heat up, in any of these:
no cell, correct cell, reversed cell, each with and without USB present.

As drawn in the schematic (refs are the schematic's):

```
 BT1 + ─ F2 (3 A) ─ CELL_PF ─┬─ Q1 DMG2305UX: D = CELL_PF, S = VBAT ──► BQ24074 BAT
                             │      gate REV_G: 10 k (R10) to CELL_N, 1 M (R11) to VBAT
                             └─ D2 RB751S40 ─ R12 330 Ω ─ DW_VCC ── U3 DW01A VCC (C6 100 nF to CELL_N)
 BT1 − = CELL_N = DW01A GND ─ Q2 FS8205A S1 │ D12 │ S2 ─ GND
                                DW01A OD → G1, OC → G2 (R14 1 M to GND), CS → R13 1 k → GND
```

Two rules make it hold whichever way the cell sits:

1. **Q1's gate is referenced to the cell's own negative terminal (CELL_N), not
   to system ground.** That is what the first attempt got wrong. With the cell
   correct, CELL_N ≈ GND and Vgs ≈ −Vcell: on, conducting both ways (charge
   and discharge). With the cell reversed, CELL_N is the cell's *positive*
   terminal, so the gate sits above the source and Q1 stays off, whatever the
   charger does to VBAT.
2. **The DW01A is powered from the cell through D2, and FS8205A's charge FET
   has a 1 MΩ gate pull-down.** A reversed cell cannot back-feed the DW01A: D2
   blocks it. With the DW01A unpowered, both FS8205A gates sit at their sources
   and the back-to-back pair blocks both directions. D2's ~0.1 V drop at the
   DW01A's µA supply current raises its trip points by the same amount
   (over-discharge ~2.5 V, over-charge ~4.4 V). The charger regulates at 4.2 V
   anyway.

| Cell | USB | Expected |
|---|---|---|
| none | no | board off |
| none | yes | runs from USB; `battery: 255` reported |
| correct | no | Q1 on, DW01A + FS8205A conduct; runs from the cell |
| correct | yes | runs from USB, charges the cell |
| reversed | no | D2, Q1 and both FS8205A FETs block; no current |
| reversed | yes | as above; the charger sees no battery; `battery: 255` reported |
| correct, over-discharged | either | DW01A trips at ~2.5 V; releases when USB returns and charging starts |
| bare cell shorted in the holder | either | DW01A short-circuit trip (~3 A); F2 if that fails |

The two reversed rows are reasoned, not measured. **Bench-test them before
trusting the board:** reverse a cell on a current-limited supply, with and
without USB, and confirm zero current and no heating. This is a safety path,
and the CLAUDE.md rule applies: verified, not argued. A first version of this
circuit (gate to GND) looked right and failed exactly the reversed + USB case.

A brand-new DW01A circuit can power up in its protected state and stay off
until a charger is connected once. Since installation always involves USB
power, that is acceptable. It also means a fresh cell does not start the board
on its own.

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
  transistors, and no BOOT button. A RESET button (SW1, EN to GND) is kept,
  as on v2.
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
button is pressed. The on-board DW01A is the last line, at about 2.4 V. After
hibernating, the board draws ~25 µA, so a cell at 3.3 V takes months to fall
that far.

### 3.5 Schematic and BOM

KiCad 10 project in `pcb/` (`sensor-wifi.kicad_pro`), one A3 sheet, 68 parts.
**The schematic is the BOM of record.** Values and footprints are set on every
part. Project libraries live beside it, so the design opens on any machine:

- U1 uses KiCad's stock `RF_Module:ESP32-C6-MINI-1` symbol. The MINI-1U pinout
  is identical.
- `sensor-wifi.kicad_sym`: TPS63802DLAR, taken from the NTC_SENSOR (v2)
  schematic, plus a custom FS8205A.
- `sensor-wifi.pretty`:
  - `ESP32-C6-MINI-1U`, generated by `routing/mkfp_mini1u.py` from KiCad's
    MINI-1. The land pattern is the same (datasheet v1.5 fig. 11-2). The body is
    trimmed to 12.5 mm at the antenna end, with no keep-out, and the u.FL is
    marked on F.Fab. Its 3D model, `3d/ESP32-C6-MINI-1U.wrl` (LCSC/EasyEDA), was
    checked against the datasheet. It is 13.2 × 12.5 × 2.42 mm, its origin is the
    pad-pattern centre, and pin 1 is top-left, so it needs no offset or
    rotation. Its u.FL sits about 0.3–0.4 mm from the datasheet position, which
    is cosmetic. It is VRML only: the enclosure STEP export needs the STEP
    version.
  - The v2 footprints for the TPS63802 and the VLS3015 inductor. Their 3D models
    still point at absolute paths on the dev machine, as in v2.

ERC is clean, and an exported netlist matched the intended 44 nets exactly.
Values marked for checking against datasheets before layout:

| Ref | Value | Check |
|---|---|---|
| R4 | 1.5 k (ILIM ≈ 1 A) | K_ILIM in the BQ24074 datasheet |
| R5 | 1.8 k (ISET ≈ 0.5 A) | K_ISET |
| R6 | 68 k (TMR) | Safety timer must exceed the ~7 h a 3.5 Ah cell takes at 0.5 A; check K_TMR and the allowed range |
| R7 | DNP | ITERM left open for the default termination current; confirm that is what open means on the BQ24074 |
| Q2 | FS8205A, TSSOP-8 | Pinout (1,8 D; 2,3 S1; 4 G1; 5 G2; 6,7 S2) against the purchased part |
| BT1 | Keystone 1042 footprint | Must take 65 mm flat-top **and** 70 mm button-top cells; swap for a holder that does |
| L1 | TDK VLS3015CX-1R5M-H | Same inductor as v2 (the earlier MLP2520 note was wrong) |

---

## 4. Firmware (`firmware/`)

PlatformIO, Arduino on pioarduino. Envs: `wifi_sensor`, and
`wifi_sensor_rollbacktest` (`1.0.99`, never reaches the cloud, must revert by
itself). Image is 1.54 MB of the 1.92 MB OTA slot. Files:

| File | Role |
|---|---|
| `config.h` | Pins, constants, version, defaults |
| `main.cpp` | Boot, mode selection, mains loop, battery cycle |
| `measure.*` | NTC (Steinhart-Hart, high side), battery, power source |
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

## 5. PCB layout (`pcb/`) — placed and routed, DRC clean

- 2-layer, **64 × 90 mm**, 1.6 mm. The length is set by the 18650 holder
  (77 × 21 mm), which runs the full length of the **back side**. The MINI-1U
  has no on-board antenna, so no keep-out constrains the layout.
- **Mounting: 4× M3 (3.2 mm NPTH, H1–H4), one per corner,** 3.0 mm in from the
  sides and 3.5 mm from top and bottom. The parts occupy a 50 mm wide strip, and
  the board has a 7 mm margin either side of it to hold the holes. The board
  sits on standoffs on the holder side. A 7 mm standoff at the right-hand holes
  clears the holder's courtyard by about 0.6 mm.
- Front, top to bottom: the MINI-1U, rotated 270° so that IO0/1, IO6–9 and
  IO18 face the crystal, button, pull-ups and J_PROG on the left, and the ADC
  pins face the dividers on the right, with its support parts (crystal, straps,
  LED, button RC) around it at the top; SW1 RESET / SW2 button below it; J_PROG at the left
  edge; the TPS63802 cluster in the middle with the BQ24074 to its right; USB-C,
  its fuse and TVS, and the probe terminal J3 on the bottom edge.
- **J1 (USB-C) overhangs the board edge by 0.5 mm.** That puts its face on the
  enclosure's inner wall face, so a cable overmold through the wall opening
  reaches the receptacle. Its 3D model (`3d/USB_C_Receptacle_HRO_TYPE-C-31-M-12.step`,
  the GrabCAD HRO model; KiCad 10 ships none) is set rotate 180° about X,
  offset (0, 3.65, 1.605).
- **J3 (probe terminal) sits 10 mm in from the edge and 4.9 mm toward the
  cell.** That leaves 12 mm between the gland and the terminal to strip and
  land the wires, and 17 mm from J1, so the M12 gland boss clears a USB-C
  overmold. It can't go further toward the cell, because its pins would land
  under the holder on the back.
- Cell protection sits next to the holder pads, so the 3 A paths stay short.
  The DW01A/FS8205A pair is at the top, by the cell − pad. The fuse and the
  reverse-polarity FET Q1 are at the bottom, by the + pad. Both pads join the
  front through clusters of 0.8/0.4 mm vias.
- **RT1 (the charger's TS thermistor) is on the front, next to the BQ24074,
  not under the cell.** It senses board temperature, which is what the charger
  heats. The cell is read only through that. If charging a cold cell turns out
  to matter, move RT1 onto a flying lead against the holder.
- u.FL is on the module, near the top edge. The pigtail goes to an SMA
  bulkhead in the enclosure.
- **Copper.** Signals are 0.25 mm. The `Power` netclass (VBUS, VBUS_IN, VSYS,
  VBAT, +3V3) is 0.5 mm. Minimum track width is 0.15 mm, because Freerouting
  narrows tracks at the module pins and JLCPCB's standard process allows 0.127.
  There are GND pours on both layers, tied with about 60 stitching vias. The
  BQ24074 connects to the pour solid (its GND pins are too narrow for two
  thermal spokes), and its thermal pad has a via.
- **Hand-routed and locked.** The TPS63802 loop, a copy of v2's geometry. The
  BQ24074 fan-out (0.5 mm pitch). The cell paths and the DW01A/FS8205A wiring.
  The 0.6 mm VSYS trunk, which goes around the regulator to C8. The VBUS trunk,
  which runs down the back past the VSYS trunk. Freerouting routed everything
  else.
- **Reproducible.** `pcb/routing/build.py auto` copies the live board, adds
  `handroutes.py`, pours, autoroutes (DSN → Freerouting 2.4.1 → SES), stitches,
  and runs DRC with schematic parity. It never touches the real board, and it
  takes about 2 minutes. If a part moves: fix `handroutes.py`, re-run, and copy
  `routing/work/sensor-wifi.kicad_pcb` and `.kicad_pro` over the project with KiCad
  closed. It runs under KiCad's bundled Python. Freerouting needs
  `--gui.enabled=false`, otherwise an exception dialog leaves an empty SES.
- **The UART is hand-routed too.** RXD and TXD leave the module's bottom row in
  the opposite order to J_PROG's pins. They swap under the module on F.Cu,
  between the pad row and the GND array, then run two lanes on B.Cu between the
  switches into the header's row gaps. Freerouting shorted RXD to +3V3 here.
  The module's centre GND array and the GND pads that the lanes wall in (U1
  pin 14 and corner pads 50/51, J2 pin 4, C11) each have their own via or tie.
- **VBAT is hand-routed end to end.** Freerouting dropped one branch or
  another on different runs. A broken battery divider reads as a flat cell, not
  a fault.
- **DRC:** 0 errors, 0 unconnected, parity clean. The 86 warnings are
  silkscreen overlaps (reference text, a GUI tidy job) plus 6
  `lib_footprint_mismatch`, all cosmetic. `sensor-wifi.kicad_dru` has one
  exception: J2's GND pin gets one back-side thermal spoke. +3V3 and BOOT box
  it in, the front pour reaches it fully, and it carries only programming
  current.
- Still to do before fab: tidy the silkscreen and mark pin 1 on J_PROG.
  Run a final DRC.

## 6. Enclosure (`enclosure/`) — base, lid, gasket and ports modelled

- Wall-mounted outside the fridge/freezer. The probe enters through the door
  gasket on a flat-section cable. The electronics, and above all the Li-ion
  cell, stay at room temperature: **Li-ion must not be charged below 0 °C**.
  The BQ24074 TS input enforces that through RT1, which reads board
  temperature next to the charger (see §5), not the cell's.
- `sensor-wifi-enclosure.sc` (SolidCraft 0.49), **the same construction as the
  hub and sensor-ntc v2 boxes**, with their parameter names. It is a base with
  a top lid, wall and floor 3 mm, corner radius 7, four corner screw pillars
  (M3 x 12 from below into blind lid bosses, so no screw heads on top), a seal
  tongue on the rim, a lid groove and lip, a printed gasket, and 0.4 mm reveals.
  Every size is a parameter.
- 97 x 86.6 x 41.1 mm. The pillars sit beside the board in Y, as on the hub.
  The height is set by the cell under the board: `stand_h` = cell axis drop
  (9.185) + 18.9/2 (largest protected cell) + 1 mm floor clearance = 19.6 mm
  standoffs (7 mm diameter rather than the house 6, because they are tall) on
  the PCB's M3 holes.
- -X end: the USB-C opening (12.6 x 7 stadium through the wall, for the
  overmold) and the probe gland, an **M12x1.5 thread modelled into a 16 mm
  boss**. The gland screws straight in, with no inner locknut (one would land
  on the PCB), and lines up with J3's wire entries.
- +X end: SMA bulkhead hole, 6.5 mm, as on the hub, 10 mm off-centre so the
  SMA body clears the module, with the nut under the lid lip.
- The board comes in as the linked STEP `enclosure/sensor-wifi-board.step`
  (`kicad-cli pcb export step --subst-models`, without tracks). After a board
  change, re-export it and run `component.update_links`. The STEP is generated
  and not committed. A reference 18650 body is in the design for clash checks.
  The interference check is clean apart from the standoff tops touching the PCB.
- Not done yet: wall-mount tabs (sensor-ntc's keyhole tab?), and a light pipe
  for the LED and a pin-hole for the button. The USB opening and the printed
  thread need a test print with a real cable and gland.

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
