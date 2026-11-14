# sensor-ntc v2 enclosure

Two-piece printed box for the v2 sensor: **a one-piece base holding a 2× AA
(L91) battery holder on the floor with the PCB deck above it, and a lid that
closes on a tongue-and-groove seal, screwed from underneath.** A keyhole tab
on the processor end hangs it on a wall screw. Outside size 89 × 48 × 39 mm,
107 mm long with the tab.

The current design is the SolidCraft model `sensor-ntc-v2-toplid.sc`. The
FreeCAD macros in this folder are the earlier bottom-door design — see
[Previous design](#previous-design-freecad).

## The model

Open `sensor-ntc-v2-toplid.sc` in SolidCraft. Every driving dimension is a
named parameter and every feature reads it by expression, so **change a
parameter and the model follows** — no rebuild.

| body | what it is |
|---|---|
| `Base` | the box: walls, floor, seal tongue, PCB supports, ports, screw wells, wall-mount tab |
| `Lid` | 3 mm plate + 3 mm rim, gasket groove, four screw bosses |
| `BatteryHolder_ref` | reference block for the 2× AA holder (`bat_l × bat_w × bat_h`); not printed |
| `PCB` | the KiCad board imported from `esp32c6.step`, for clearance checks; not printed |

### Main parameters

| parameter | value | meaning |
|---|---|---|
| `L`, `W` | 89, 48 | outside length and width |
| `wall`, `floor_t` | 3, 3 | wall and floor thickness |
| `z_rim` | 33 | height of the base up to the seal rim |
| `lid_plate`, `lid_rim` | 3, 3 | lid top thickness and rim depth |
| `bat_l/w/h` | 68 / 30 / 15 | battery holder envelope; `bat_x0`, `bat_cy` place it |
| `pcb_z` | `floor_t + bat_h + bat_gap` = 21 | underside of the PCB |
| `pcb_cx` | −1.5 | PCB centre offset in X |
| `tongue_w/h`, `groove_gap`, `lip_w` | 1.2 / 1.5, 0.6, 1.2 | seal tongue on the base and the lid groove around it |
| `btn_d`, `port_z` | 12, 24.5 | panel button hole in the +X end wall |
| `sens_d`, `sens_x`, `sens_z` | 6, 17.8, 27.5 | probe hole in the front (−Y) wall |
| `screw_inset` | 5.5 | lid screw centres from the outside corners |
| `lid_screw_d`, `lid_pilot_d` | 3.4, 2.5 | lid screw clearance in the base, pilot in the lid boss |
| `well_d`, `seat_z` | 6.5, 24 | screw-head well from underneath, and where the head seats |
| `boss_d`, `boss_h`, `lid_skin` | 6, 5, 2 | lid bosses and the skin left over the pilot (lid top stays closed) |
| `pcb_pilot_d`, `pcb_pilot_depth` | 1.7, 7 | PCB screw pilots in the supports |
| `mount_w`, `mount_len`, `mount_t` | 18, 18, 3 | wall-mount tab: width, reach past the +X wall, thickness |
| `mount_r`, `mount_blend`, `mount_root_r` | 4, 4, 1 | tab tip corners, concave side blends into the wall, root fillet |
| `mount_hole_d`, `mount_slot_w`, `mount_slot_len` | 8, 4.2, 7 | keyhole entry (clears the screw head), slot (screw shank), slot length |

### Features worth knowing

- **Probe hole** is centred in front of the ESP32-C6 module
  (`sens_x = pcb_cx + 19.3 mm`), where there is about 11 mm clear between the
  module's front pads and the wall. Its centre sits 2.5 mm below the seal rim.
  The probe connector (TH1) is at the other end of the board, so the cable
  routes across inside.
- **Lid screws** go in from the bottom: a Ø6.5 well runs up through the corner
  pillar to a seat at `seat_z`, a Ø3.4 passage continues to the rim, and the
  screw threads into a lid boss that drops into a pocket in the base. The pilot
  stops `lid_skin` short of the lid top, so no screw heads show on top. From
  the seat to the end of the pilot is 13 mm.
- **Seal:** the base carries a 1.2 × 1.5 mm tongue; the lid groove is 0.6 mm
  wider and 1.5 mm deeper than the tongue, leaving room for a gasket.
- **PCB** sits on four supports beside the battery holder, screwed into Ø1.7
  pilots. The battery holder is under the board, so changing cells means
  lifting the PCB out.
- **Wall mount:** a 3 mm tab off the +X (processor) end, flush with the box
  bottom so the bottom sits flat against the wall. Mount it with **+X up**:
  put the Ø8 entry over a screw head and let the box drop, and the shank
  slides up the slot, so the box hangs from the tab instead of balancing on
  the screw. That is why the entry is nearest the box and the slot runs
  outboard. The profile is buried `mount_r` into the end wall with R4
  concave blends in the sketch, and an R1 fillet along the top of the root,
  where a cantilever carrying the box would otherwise crack along a print
  layer. The bottom faces the wall, so unhook the box to reach the lid
  screws.
- A 0.4 mm chamfer on each half at the parting line gives a reveal so the seam
  reads as intentional.

## Export

Print files are in `export/`:

| file | body |
|---|---|
| `TopLid_Base.step`, `TopLid_Base.3mf` | Base |
| `TopLid_Lid.step`, `TopLid_Lid.3mf` | Lid |

Re-export after any change from SolidCraft (export the `Base` or `Lid` body by
name). `toplid-section*.png` are section views of the assembly.

## Before printing

- Material: PETG, ABS or ASA. Not PLA: it turns brittle at freezer
  temperatures.
- Fasteners: four M3 for the lid (3.4 clearance, 2.5 pilot, up to 13 mm long
  from the seat); PCB screws into the 1.7 mm pilots (M2 thread-forming).
  Wall screw: head under 8 mm, shank under 4.2 mm (e.g. a 3.5 or 4 mm pan
  head), with the underside of the head set about 3.5 mm off the wall so the
  3 mm tab slides behind it.
- Gasket: not yet test-fitted. Check the groove depth against whatever cord or
  foam you use before relying on the seal.
- Check `bat_l/w/h` against the actual battery holder before printing — the
  holder is a reference block, not a model of the part.

## Reference geometry

`esp32c6.step` (the KiCad board export) is imported into the model as the `PCB`
body, and `NTC_SENSOR.kicad_pcb` is a copy of the board file. Both are large
local inputs listed in the repository root `.gitignore`.

## Previous design (FreeCAD)

The macros here build the earlier design: battery bay underneath with a screwed
bottom door, PCB above, screwed and gasketed lid. It is no longer being
developed; its exports are `export/Body_Main.step`, `Body_Lid.step` and
`Body_Door.step`.

To rebuild it, point FreeCAD's macro path at this folder and run
**`build-all.FCMacro`**, which chains:

| macro | what it does |
|---|---|
| `sensor-ntc-v2-enclosure.FCMacro` | new document with `Body_Main`, `Body_Lid`, `Body_Door` and the `params` spreadsheet |
| `round-rims.FCMacro` | fillets the horizontal rims |
| `assembly.FCMacro` | wraps the parts in an `Enclosure` container and adds the `explode` parameter |
| `tidy-view.FCMacro` | hides sketches and superseded features |

Dimensions live in the `params` spreadsheet. `sensor-ntc-v2-enclosure.scad` is
the original OpenSCAD model, older still, kept only for reference.
