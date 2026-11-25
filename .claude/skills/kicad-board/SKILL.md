---
name: kicad-board
description: Working on the NTC_SENSOR PCB (the v2 sensor board for this repo) — reading or editing its board or schematic, tracking what changed, the panel-button respin, or the enclosure's board geometry. Use whenever the task touches NTC_SENSOR .kicad_pcb/.kicad_sch files. Covers where the three copies of this board live, its established nets and free GPIOs, and pending work. Load the global kicad-copperpour skill too for how to drive KiCad through the MCP server.
---

# NTC_SENSOR board work

Facts about this one board. **How to drive KiCad through Copperpour (connection
checks, verifying writes, the zoned-board sync refusal, DRC hygiene, broken
tools) lives in the global `kicad-copperpour` skill. Load it as well.**

---

## 0. Status — hold, as of 2026-09-08

**Nothing has been applied to the real project.** `Documents\Temp32\NTC_SENSOR\`
still sits at its two baseline commits. The panel-button change is built,
placed, routed and DRC-clean on the **sandbox only**.

It stays there until the physical button arrives and its LED current is
measured at 3.3 V. That one measurement decides the topology: at or below
~10 mA, GPIO23 can drive the ring directly and `Q1`/`R_gpd1` are unnecessary.
Above it, the low-side FET is required. Porting the sandbox work across before
then risks building the circuit around an assumption.

Firmware changes are likewise agreed but unapplied. The enclosure side is
further along: the SolidCraft model already has the 12 mm button port and a
button reference part (see §4, Enclosure).

---

## 1. Where the board actually lives

There are **three** copies. Confusing them is the first mistake available.

| Path | What it is | Git |
|---|---|---|
| `Documents\Temp32\NTC_SENSOR\` | **The real project.** Edit this one. | own repo, `main` |
| `Documents\Temp32\NTC_SENSOR_sandbox\` | Throwaway copy for exercising the MCP server | own repo, `main` |
| `Temp-sensors\sensor-ntc\enclosure\NTC_SENSOR.kicad_pcb` | **Manually-synced copy** for the enclosure; the SolidCraft model (`sensor-ntc-v2-toplid.sc`) imports its STEP export, `esp32c6.step`, as the `PCB` component | gitignored on purpose |

The real project is **outside** the `Temp-sensors` repo and had no version
control until 2026-09-07. It now has its own repo whose first commit is the
as-fabricated baseline.

The enclosure copy is gitignored deliberately: the `.gitignore` comment says
tracking it would let the two drift. It drifts anyway. **It goes stale the moment
the real board is edited**, and the enclosure model then measures old geometry.
After any layout change, re-copy it, re-export `esp32c6.step`
(`kicad-cli pcb export step --subst-models --include-tracks`) and replace the
`PCB` import in the SolidCraft model, then run the clash check.

The sandbox and the real project both keep the internal project name
`NTC_SENSOR`, so they look identical in KiCad's recent-projects list and only the
folder differs. **Never rename one to tell them apart** (see the global skill).

`fp-lib-table` resolves footprints from
`Documents\KiCad_Custom_Libraries\Footprints.pretty`, which is **outside** the
repo, so a clone alone does not reconstitute the design.
`esp32-c6-wroom-u1.kicad_sym` in the project is an **empty stub** (header, no
symbols). The WROOM symbol comes from the schematic's embedded `lib_symbols`
cache.

**Sandbox first** for anything unfamiliar. Reset with
`git checkout <baseline> -- NTC_SENSOR.kicad_pcb`.

---

## 2. Board-specific consequences of the general rules

- **Two GND pours (F.Cu and B.Cu)**, so `update_pcb_from_schematic` refuses
  every pad-net change on this board. Use F8. KiCad applied the change the tool
  refused (`U1` pad 21 to `PANEL_LED_G`) without complaint.
- **4× `MountingHole_2.5mm`** give false `copper_edge_clearance` positives. They
  were `REF**` and tripped `duplicate_board_reference` and the DSN export, so
  they are annotated `H1`–`H4` on the sandbox. Harmless otherwise: no nets,
  excluded from pos files and BOM, absent from the June CPL.
- **Thermal reliefs:** both zones shipped relief-for-everything with
  `thermal_gap 0.5` / `thermal_bridge_width 0.5`. `R2`, `Cfb1` and
  **`C_vdd_bulk1`** were left with a single spoke. `C_vdd_bulk1` is the bulk cap
  sourcing the WROOM's 200 mA TX burst. The PTH-only fix is applied on the
  sandbox and **still outstanding on the real board**.
- **Do not autoroute.** `U2`/`L1_ext1`/`C_in1`/`C_out1` (the TPS63802 cluster)
  is packed tight for switching-loop area, which decides whether the node
  survives a TX burst on cold cells. The panel-button block was six connections
  routed by hand.
- **DRC baseline:** the pristine board reports `unconnected_items: 0`. During
  layout, `bat_ADC` silently lost its `U1` pad 27 → B.Cu connection and was
  caught only against that baseline. A broken battery divider reads as a flat
  cell, not a fault.
- Every part is single-unit (`U1`, `U2`, `J1`, `SW1`), so the old `(units …)`
  bug had low impact here.

---

## 3. Board facts already established

33 nets: `3v3, GND, V_bat, D0_BTN, NTC_ADC, NTC_EN, DIV_EN, bat_ADC, EN, Boot,
ESP_TXD, ESP_RXD, LED, GPIO8` plus the TPS63802 feedback nets. 144 trace
segments, 2 zones, 12,291 lines. Only 10 `filled_polygon` blocks, so **diffs
stay readable**: a move is one changed `(at …)` line.

**Free GPIOs** (confirmed `unconnected-…` on the live board): 4, 6, 7, 10, 11,
18, 19, 20, **23**. Avoid 8, 9, 15 (straps) and 12/13 (USB). GPIO4 and GPIO5 are
also listed as C6 strapping pins (SDIO mode). That is unverified from local
sources, so prefer others. The existing LED works on GPIO5 because an LED to GND
is an open circuit below Vf and does not pull the strap; a FET gate with a
pulldown would.

`U1` pad 21 = **GPIO23**, at board position **(102.5, 96.19)**.

Status-LED chain: `GPIO5 → R_LED1 (1 kΩ) → D1 (samacSys:LEDC1608X85N) → GND`.
`D1` pad 1 → `GND`, pad 2 → `Net-(D1-A)`.

Connectors are only `J1` (2×3 IDC programming) and two 2-pin JST XH (`BT1`
battery, `TH1` probe). `SW1`/`SW2` are on-board 6 mm THT tactiles. **Nothing
brings 4 wires out to a panel.**

Two footprints come from SamacSys/SnapEDA (`LEDC1608X85N`, `VLS3015`). The older
Python KiCAD-MCP-Server crashed on such symbols (its `kicad-skip` parser). The
Rust parser should not, but that is untested here.

---

## 4. Pending work — illuminated panel button

Agreed design. **Built and proven on the sandbox**; **not applied to the real
board** (see Status above). The sandbox is a recipe to repeat, not a thing to
copy across.

**Button:** 12 mm metal momentary, **3–8 V**, **red** ring. Use red or yellow
only: blue, white and green have Vf 3.0–3.2 V and barely light off 3V3. The LED
half has an **internal resistor** (that is what the "3–8 V" range means). Verify
on the bench at 3.3 V with a 25 mA limit. Brightness can only be reduced, never
raised.

**PCB:**

- Panel LED on its **own GPIO** (`GPIO23`), not shared with `D1`, so `D1` stays
  a bench indicator showing everything while the panel ring shows only the
  user-facing subset.
- `GPIO23 → BSS138 gate`, **100 kΩ gate pulldown** (defines "off" through deep
  sleep, reset and brownout), `3V3 → LED+ → LED− → drain`, source to GND.
  Direct drive is acceptable instead if measured current is ≤ 10 mA.
- `R_bled` 0 Ω in series is the only brightness trim available.
- 4-pin JST: LED+, LED−, SW, SW-GND. The switch pair parallels the existing
  tactile on `D0_BTN`.

**Firmware** (`sensor-ntc/src/main.cpp`), agreed but **not applied**:

- Panel LED shows: pairing search, pairing success (5×), factory reset (15×),
  button-press ack (3×). It does **not** show the per-reading TX flash.
- Delete the delivered-flash at the `✓ Delivered!` branch. It fires on all 96
  timer wakes a day for a light nobody can see.
- Reshape the pairing blink to 500 ms solid on entry, then 100 ms on / 400 ms
  off, and **force the LED dark across each `esp_now_send` plus a ~20 ms
  guard**. The old 50 % toggle could stay lit through a 200 mA TX burst, and on
  cold L91s that causes the brownout the guard in `setup()` exists to recover
  from.

**Enclosure** (SolidCraft `sensor-ntc-v2-toplid.sc`, checked 2026-11-21): the
button goes in the 12 mm port (`btn_d`, `port_z`) in the **+X end wall**, not the
lid, so the old FreeCAD headroom problem no longer applies. The reference part
is a GrabCAD 12 mm LED button (`models/button-12mm-mini.step`) that reaches
13.5 mm behind a 3 mm wall, with a sealing ring and nut inside. It clears the
PCB, battery holder and lid in the clash check. It is a stand-in, not the
bought part: re-check the clash when the real button arrives. A longer model
(23.6 mm) was tried first and dropped.

**Probe hole and the board edge:** the M6 NTC probe's inside nut (10 mm A/F)
sits right over the PCB's front edge. `sens_z` is therefore an expression,
`pcb_z + pcb_t + ntc_nut_af/2 + 0.3 mm`, so the nut's bottom flat clears the
board top by 0.3 mm; `sens_d` is 6.3 mm for M6 clearance. Its corners still
sweep below the board while it turns, so the probe is tightened before the PCB
goes in. If the board moves or gets thicker, the probe follows, but re-check
that the nut top stays under `z_rim`.

---

## Maintaining this skill

Update it when a board fact is established by measurement rather than
assumption, or when the respin lands. At that point GPIO23 belongs in the v2 pin
table in `CLAUDE.md`, not only here. General Copperpour/KiCad findings go in the
global `kicad-copperpour` skill.
