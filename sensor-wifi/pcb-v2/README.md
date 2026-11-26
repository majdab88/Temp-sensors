# sensor-wifi PCB v2 — TP4056 module instead of the on-board charger

Same board as v1 (`../pcb`), with the USB-C receptacle, the BQ24074 charger and
the DW01A/8205A cell protection replaced by a **TP4056 Mini Type-C charger
module** (14 × 17.5 mm, with its own protection) soldered flat onto the PCB.
The point is cost: JLCPCB's Extended parts drop from 11 to **4**. The v1 design
is kept unchanged in `../pcb`.

**Status:** placed and routed. ERC clean; DRC 0 errors, 0 unconnected,
schematic parity clean. The 45 warnings are silkscreen overlaps. Not built.

## What changed from v1

| | v1 | v2 |
|---|---|---|
| USB input | J1 USB-C, F1 PTC, D1 TVS, CC and shield parts | the module's own USB-C (J1's place, same enclosure wall) |
| Charging | BQ24074, 0.5 A, power path, TS thermistor | module's TP4056 (4056H), **~0.6 A** (its R_PROG is 2 kΩ) |
| Cell protection | DW01A + 8205A + F2 3 A fuse | module's single-chip protector |
| Reverse cell | Q1 (P-FET, + side), DW01A fed through D2 | **Q1 + Q2** (N-FET, − side), see below |
| USB present | BQ24074 `/PGOOD` → GPIO7, active **low** | **100 k / 100 k from module IN+ → GPIO7, active high** |
| Charging status | `/CHG` → GPIO18 | none (GPIO18 unused) |
| Everything else | | unchanged and at v1's positions: module, TPS63802 loop, NTC, buttons, J_PROG, crystal, holder |

**Firmware:** `USB_DET` (GPIO7) is HIGH when USB is present, the opposite of
`/PGOOD`; GPIO7 is still an LP GPIO, so it still wakes from deep sleep. Drop the
`/CHG` reading. The battery divider (GPIO2/GPIO21) is unchanged and now sits on
VSYS, which is the cell through Q1 (≈ 4.2 V while USB charges).

## The module

`TP4056_Mini_TypeC` footprint and symbol come from `routing/mkfp_tp4056.py`,
measured from the vendor STEP (`3d/TP4056_Mini.step`, GrabCAD, **not committed**:
its licence does not allow redistribution). Six plated holes, 1.0 mm:

| Pad | Name | Net | Position on the board |
|---|---|---|---|
| 1 | IN+ | `VBUS_IN` (divider only) | 101.85, 186.5 |
| 2 | IN− | GND | 114.15, 186.5 |
| 3 | OUT− | GND | 114.15, 172.5 |
| 4 | B− | `BATN` (Q2 source) | 111.61, 172.5 |
| 5 | (unlabelled) | **isolated**, mechanical only | 104.39, 172.5 |
| 6 | + | `VSYS` | 101.85, 172.5 |

- **Solder it** with cut-down pin-header pins through both boards, or let solder
  fill its holes onto our pads. The 18650 holder is on the back but clear of
  the module, so the joints are reachable from below.
- **Pad 5 is not connected** until a continuity check confirms it is a second
  "+" (it probably is). Beep pad 5 to pad 6 on a real module.
- **Check IN− to OUT− continuity**: the USB-detect divider assumes they are the
  same node (they are on standard TP4056 boards).
- **CC resistors**: look for two 5.1 kΩ (512) resistors by the module's USB-C.
  Without them it charges only from USB-A-to-C cables, not C-to-C.
- **No power path**: the ESP draws from the cell node the TP4056 charges. Once the
  cell is full it terminates, the load draws it down to ~4.05 V, and it tops up:
  shallow cycles near full, accepted for this load.
- **No cold-charge cutoff**: the module grounds the TP4056's TEMP pin.
- **Enclosure**: the module's receptacle face is where J1's was (board edge
  + 1.05 mm), but its centre is ~2.6 mm above our board (it sits on the module's
  own PCB), about 1 mm higher than J1's. Move the enclosure's USB opening up to
  match before printing.

## Reverse-cell protection (Q1 + Q2)

With the module, a P-FET on the + side alone (v1's Q1) is not enough. The module's
protector sits between B− and ground and is powered from the charger, so with a
reversed cell **and** USB present Q1 would turn on and the charger would drive
current through the reversed cell. v2 adds an N-FET on the − side:

- **Q1** (AO3401A, P): drain = holder +, source = VSYS, gate via R10 (10 k) to
  holder −, R11 (1 M) to source.
- **Q2** (AO3400A, N, Basic C20917): drain = holder −, source = module B−
  (`BATN`), gate via R12 (10 k) to holder +, R13 (1 M) to source.

| Cell | USB | Q1 | Q2 | Result |
|---|---|---|---|---|
| correct | no / yes | on | on | normal; charge and discharge both ways through both |
| reversed | no | off | off | no path |
| reversed | yes | off | off | each would need the other already on to turn on; no current |

The reversed rows are reasoned, not measured. **Bench-test them** (reversed cell
on a current-limited supply, with and without USB: zero current, no heating)
before trusting the board. This is a safety path.

## JLCPCB parts

21 part numbers: **15 Basic, 2 Preferred, 4 Extended** (U1 ESP32-C6-MINI-1U-H4,
U4 TPS63802, L1 inductor, F3 probe-line PTC). Every SMD part carries `LCSC`, `MPN`
and `Manufacturer`. Hand-soldered: the TP4056 module, BT1 holder (back side),
J2, J3, SW1, SW2.

## Layout

- v1's outline (64 × 90 mm), M3 holes and every kept part at v1's coordinates.
- **Module** where J1 was: centre (108, 180.4), rotated 180°, USB-C out of the
  bottom edge.
- **Q2, R12, R13** beside the holder's − contact (top right), where the DW01A and
  8205A were. **C4/C5** (10 µF) beside the module's + pad. **R8/R9** (USB detect)
  left of the module.
- **Hand-routed** (`routing/handroutes.py`): v1's TPS63802 loop, UART lanes and
  GND ties unchanged; the cell paths (holder + → Q1; holder − → Q2 on 0.8 mm;
  Q2 → module B− on 1 mm down the back); the VSYS trunk from the module's + pad to
  the regulator, Q1 and the battery divider (v1's pinned path for the last part);
  all of EN (Freerouting left a link open); and a back-side tie for C16's ground
  via. Freerouting routed the rest.
- The holder's three plastic pegs go through the board at (131, 172.6),
  (147, 117.4) and (147, 181.1); the VSYS trunk passes the first with 0.8 mm.

## Reproducing it

Same tooling as sensor-ntc v3. Under KiCad's bundled Python:

1. `routing/mkfp_tp4056.py` (any Python) writes the module footprint and symbol.
2. `routing/mkboard.py` builds the unrouted board from the schematic's netlist
   and the placement table.
3. `routing/build.py auto` hand-routes, autoroutes, pours, stitches and runs
   DRC on a copy in `routing/work/`. Good when it reports 0 unconnected; adopt by
   copying `routing/work/sensor-wifi-v2.kicad_pcb` over the project file with
   KiCad closed. `routing/drc-baseline.json` is the adopted board's DRC.

## Before fab

- Continuity checks on a real module: pad 5 ↔ pad 6, IN− ↔ OUT−; CC resistors.
- Move the enclosure's USB opening up ~1 mm for the module's receptacle.
- Tidy the silkscreen; mark pin 1 on J_PROG.
- Bench-test the reverse-cell rows after assembly.
