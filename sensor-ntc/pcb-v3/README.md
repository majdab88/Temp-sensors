# sensor-ntc v3 PCB

The v2 sensor board, redesigned around the **ESP32-C6-MINI-1U-H4** (the module
sensor-wifi uses), with the NTC back on the **high side** and a connector for the
**12 mm panel button with its LED ring**. KiCad 10 project, 2 layers, 1.6 mm.

Placed and routed. **DRC: 0 errors, 0 unconnected, schematic parity clean.** The
59 remaining findings are silkscreen text overlaps (a GUI tidy job) and two
reference labels near the board edge. Not yet fabricated.

## What changed from v2

| | v2 (NTC_SENSOR) | v3 |
|---|---|---|
| Module | ESP32-C6-WROOM-1U-N4 (not stocked at JLCPCB) | **ESP32-C6-MINI-1U-H4** (C20627095), −40…105 °C, u.FL |
| NTC | low side: `3V3 → R5 → ADC → NTC → GPIO22` | **high side**: `3V3 → NTC → ADC → R5 → GPIO22` |
| Panel button | none | `J_BTN` 4-pin JST XH + BSS138 low-side LED driver on GPIO23 |
| Passives | no LCSC numbers | every SMD part carries an `LCSC` field; all Basic/Preferred |
| Inductor | TDK VLS3015CX-1R5M-H (not stocked) | cjiang FNR3015S1R5MT (C167745), same 3×3 land |
| 22 µF | 1210 (Extended) | 1206 (C12891, Basic), same pad pitch |
| Outline, holes, power section | | **unchanged**: same 60 × 40 mm, same four holes, same TPS63802 placement and copper |

The outline and mounting holes are v2's, so the board drops into the existing
top-lid enclosure (`../enclosure/sensor-ntc-v2-toplid.sc`).

## Pin map

The same GPIOs as v2, so the firmware only needs the high-side formula and the
panel LED. The MINI does not bring out IO10/IO11; nothing used them.

| GPIO | MINI pin | Net | Function |
|---|---|---|---|
| 0 | 12 | `D0_BTN` | On-board SW2, panel button (`J_BTN` pin 3). 10 k pull-up, 100 nF. LP GPIO, deep-sleep wake |
| 1 | 13 | `NTC_ADC` | NTC divider midpoint, 100 nF to GND |
| 2 | 5 | `BAT_ADC` | Battery divider midpoint (100 k / 100 k), 10 nF |
| 5 | 10 | `LED` | On-board red LED via 1 k (bench indicator) |
| 8 | 22 | `GPIO8` | Strap: 10 k pull-up |
| 9 | 23 | `BOOT` | Strap: 10 k pull-up; `J_PROG` pin 6 |
| 21 | 27 | `DIV_EN` | Battery divider enable (LOW = on, Hi-Z in sleep) |
| 22 | 28 | `NTC_EN` | NTC divider enable (LOW = on, Hi-Z in sleep) |
| 23 | 29 | `PANEL_LED_G` | Panel LED: BSS138 gate, 100 k pull-down |
| 16 / 17 | 31 / 30 | `ESP_TXD` / `ESP_RXD` | `J_PROG` pins 3 / 5 |
| EN | 8 | `EN` | 10 k pull-up, 1 µF, SW1 RESET, `J_PROG` pin 1 |
| 3, 4, 6, 7, 12–15, 18–20 | | | unconnected (15 floats high: boot log on) |

**NTC formula on v3:** `R_ntc = r_series · (Vcc − V) / V`. That is the v1 form,
not v2's. A cold probe has a high resistance, which keeps the ADC low, where it is
accurate: −18 °C (81.9 kΩ) reads 0.36 V and +4 °C (26.8 kΩ) 0.90 V. One probe
wire carries 3V3 continuously. That is harmless on a floating battery board; it
mattered on sensor-wifi, which can be earthed through USB.

## Connectors (all hand-soldered, like v2)

| Ref | Part | Pins |
|---|---|---|
| `BT1` | JST XH 2-pin | 1 `V_BAT`, 2 GND (as v2) |
| `TH1` | JST XH 2-pin | 1 3V3, 2 `NTC_ADC` (probe is not polarised) |
| `J_BTN` | JST XH 4-pin | 1 LED+ (3V3), 2 LED− (to the FET via `R_bled1`), 3 SW (`D0_BTN`), 4 GND |
| `J_PROG` | 2×3 IDC, ESP-PROG UART | 1 EN, 2 3V3, 3 TXD, 4 GND, 5 RXD, 6 IO0 (= GPIO9) |
| `SW1` / `SW2` | 6 mm THT tactile | RESET / D0 |
| `C1` | 1000 µF 6.3 V radial Ø8 | cell-side bulk, as v2 |

**Panel LED.** The 12 mm button's ring has its own series resistor (that is what
"3–8 V" on such buttons means). `R_bled1` (0 Ω) is the only brightness trim:
fit a resistor there to dim it. The FET's 100 k gate pull-down keeps the LED
off through reset, deep sleep and brown-out. Use a red or yellow ring: blue,
white and green have Vf 3.0–3.2 V and barely light from 3.3 V.

## JLCPCB parts

Every SMD part is from JLCPCB's catalogue, Basic or Preferred where one exists.
The three **Extended** parts have no Basic equivalent at all: JLCPCB's Basic
library has no RF module, no buck-boost, no power inductor at this rating, and no
connectors. Stock figures are from the catalogue snapshot of 2026-11-25.

| Refs | Value | LCSC | Part | Library | Stock |
|---|---|---|---|---|---|
| U1 | ESP32-C6-MINI-1U-H4 | C20627095 | Espressif | **Extended** | 3 500 |
| U2 | TPS63802DLAR | C2845237 | TI | **Extended** | 14 934 |
| L1 | 1.5 µH, 2.7 A sat, 65 mΩ | C167745 | cjiang FNR3015S1R5MT | **Extended** | 5 340 |
| C_buf1, C_out1 | 22 µF 25 V X5R 1206 | C12891 | Samsung CL31A226KAHNNNE | Basic | |
| C_in1, C_vdd_bulk1 | 10 µF 25 V X5R 0805 | C15850 | Samsung CL21A106KAYNNNE | Basic | |
| C_en1 | 1 µF X7R 0805 | C28323 | Samsung | Basic | |
| C_d0, C_vdd_hf1, Cfn1 | 100 nF X7R 0805 | C49678 | Yageo | Basic | |
| Cfb1 | 10 nF X7R 0805 | C1710 | Samsung | Basic | |
| R1 | 560 k 1 % 0603 | C23203 | Uniroyal | Preferred | |
| R2, R3, R4, R_gpd1 | 100 k 1 % 0603 | C25803 | Uniroyal | Basic | |
| R5, R_boot1, R_en1, R_gpio0, R_gpio8 | 10 k 1 % 0603 | C25804 | Uniroyal | Basic | |
| R_LED1 | 1 k 0603 | C21190 | Uniroyal | Basic | |
| R_bled1 | 0 Ω 0603 | C21189 | Uniroyal | Basic | |
| D1 | red LED 0603 | C2286 | KENTO KT-0603R | Basic | |
| Q1 | BSS138 SOT-23 | C7420339 | hongjiacheng | Preferred | |

X5R is rated to −55 °C, so the Basic X5R 10 µF and 22 µF parts are fine in a
freezer. **Check before ordering:** the FNR3015's recommended land pattern
against the `VLS3015` footprint (both are two-terminal 3 × 3 mm; the pads are
1 × 3 mm at ±1 mm), and that stock still covers the build.

The JLCPCB BOM and placement file can come from the Fabrication Toolkit plugin
(as v2's order did); it reads the `LCSC` field, which is on every footprint.

## Layout

- **Power section** (bottom left): v2's parts at v2's positions, with v2's
  copper copied segment for segment (`routing/handroutes.py`). That loop is
  the part of the board that decides whether a node survives a TX burst on cold
  cells.
- **Module** in the middle, u.FL toward the top edge. Decoupling and the EN RC on
  its left, straps and the D0/NTC filter caps under it.
- **`J_BTN` on the top edge**, which faces the +X end wall and the panel button.
- **`TH1` on the right**, near the probe hole in the −Y wall. The probe's inside
  M6 nut sweeps `x ≥ 109.5, y 90…101.5` just above the copper (enclosure
  coordinates: probe axis `ex 17.8`). Nothing tall sits there, and TH1 starts
  below it.
- **Copper.** Signals are 0.25 mm. `Power` (V_BAT, 3V3) is 0.5 mm. Minimum track
  width is 0.15 mm. GND pours on both layers, about 50 stitching vias.
- **Hand-routed and locked** (Freerouting's result differs between runs and
  dropped one branch or another): the TPS63802 cluster, **all of 3V3** (trunk
  from the regulator down B.Cu between SW2 and SW1, under the module's bottom
  edge, up to U1 pin 3 and its caps, with branches to the pull-ups, TH1,
  J_PROG, R_en1 and J_BTN), the module's centre GND array (vias in pad), and
  ground ties for pads that tracks fence off from the pour (U1 pads 11, 14, 50,
  51, C_en1, C_d0, Cfn1, D1, R2).
- **`sensor-ntc-v3.kicad_dru`** has one exception: J_BTN's GND pin gets one
  back-side thermal spoke. The front pour reaches it fully.
- **The B.Cu pour has three voids** (left of the module around J_PROG, and above
  SW2), fenced off by tracks and removed as islands. Every GND pad is still
  connected (DRC: 0 unconnected); it is ground-plane area lost, not a fault.

## Reproducing it

All of it runs under KiCad's bundled Python (`C:\Program Files\KiCad\10.0\bin\python.exe`).

1. **Schematic** (`sensor-ntc-v3.kicad_sch`) is the source of truth. It was
   authored with Copperpour and is ERC-clean.
2. **`routing/mkboard.py`** builds the *unrouted* board from the schematic's
   netlist: outline, footprints, fields, nets, and the placement table. It
   overwrites `sensor-ntc-v3.kicad_pcb`, so edit placement there, not in the PCB
   editor, until the layout is frozen.
3. **`routing/build.py auto`** copies the board to `routing/work/`, strips any
   copper, adds `handroutes.py`, pours, autoroutes (DSN → Freerouting 2.4.1 →
   SES), stitches, and runs DRC with schematic parity. About 2 minutes. A run is
   good when it reports 0 unconnected. Adopt it by copying
   `routing/work/sensor-ntc-v3.kicad_pcb` over the project file with KiCad closed.
4. `routing/drc-baseline.json` is the DRC of the adopted board. Compare against
   it, not against zero, after any change.

## Before fab

- Tidy the silkscreen (reference text overlaps), mark pin 1 on `J_PROG`.
- Check the u.FL plug and its cable clear `J_BTN` (the plug sits about 2.5 mm
  from the connector body; the cable exits sideways).
- **Clash-check against the enclosure**: export the STEP
  (`kicad-cli pcb export step --subst-models --include-tracks`) and replace the
  `PCB` import in the SolidCraft model. TH1 and J_BTN are new positions. Also check
  the M2 screw head at H2 against the probe nut's corners (inherited from v2,
  about 1 mm apart).
- Firmware: a `BOARD_REV 3` with v2's pins, the high-side NTC formula, and the
  panel LED on GPIO23.
- 3D models: `L1` and `U2` still point at absolute paths on the dev machine, as
  in v2 and sensor-wifi. `U1`'s is in `3d/`.
