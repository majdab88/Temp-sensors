// ============================================================
// sensor-ntc v2 enclosure — batteries under the board
// 2x AA (L91) bay at the bottom, PCB deck above, bottom door.
// Contacts: Keystone-style leaf contacts sliding into printed
// slots (2x single w/ PCB pin at one end, 1x dual jumper at the
// other). Matches the cross-section illustration.
//
// !! SUPERSEDED by sensor-ntc-v2-enclosure.FCMacro, which is now the
// master model. This file was the bridge into FreeCAD before the native
// build existed and it is BEHIND on: rounded corners, the reworked door
// (5.5 mm lip, 3 mm plate, four corner screws with counterbores), and
// the interior sizing that keeps a full wall around the door recess.
// Print from the macro, not from here.
//
// Import into FreeCAD: OpenSCAD workbench -> File > Open .scad
// (set the OpenSCAD executable path in FreeCAD preferences).
// Or edit the parameters below and preview in OpenSCAD itself.
//
// !! Before printing for real:
//   - set bay_l and the slot dims from the Keystone datasheet
//     (recommended compartment length + slot geometry)
//   - print the battery bay alone first and test cell fit
//   - material: PETG / ABS / ASA (not PLA — freezer duty)
// ============================================================

// ---------- what to render ----------
part = "assembly"; // "assembly" | "body" | "lid" | "door" | "print"
explode = 14;      // assembly explode distance (0 = closed)

// ---------- cells ----------
cell_d      = 14.5;   // AA diameter
cell_l      = 50.5;   // AA length (info only; bay_l governs)
cell_clear  = 0.6;    // radial clearance around each cell

// ---------- battery bay ----------
bay_l       = 57.5;   // contact face to contact face  <-- FROM DATASHEET
bay_w_rib   = 3;      // center rib between the two cells
bay_h       = 16;     // bay ceiling height above door inner face

// contact slots (printed pockets the leaf contacts slide into)
slot_t      = 1.8;    // slot thickness (contact metal + spring room)
slot_depth  = 2.0;    // how far the slot bites into the end wall
slot_w_single = 11;   // width of each single-contact slot
slot_w_dual   = 24;   // width of the dual-jumper slot (23.98 per dwg)

// battery wire pass-through in the floor, beside BT1 (JST-XH)
bat_wire_d  = 5.0;
bat_wire_x  = -24.5;
bat_wire_y  = 4.0;

// ---------- PCB ----------
pcb_l       = 60;     // from NTC_SENSOR.kicad_pcb outline
pcb_w       = 40;     // from NTC_SENSOR.kicad_pcb outline
pcb_t       = 1.6;
pcb_clear   = 0.4;    // per-side slop in the PCB pocket
pcb_lift    = 2.5;    // THT leads reach 1.9 mm below the board
headroom    = 12;     // components reach ~9 mm above board (measured STEP)
pcb_pilot   = 2.05;   // M2.5 self-tap pilot — board holes are 2.5 mm
mount_holes = [[21, 17], [26.5, -16.5], [-26.5, 17], [-26.5, -16.5]];
probe_x     = -15;    // probe hole X — lined up with TH1 (JST-XH)

// ---------- shell ----------
wall        = 2.5;
floor_t     = 1.8;    // bay ceiling / electronics floor
lid_t       = 2.5;
lid_lip     = 2.0;    // lid lip depth
door_t      = 2.2;
door_rib_h  = 1.6;    // ribs on the door that press the cells up
screw_pilot = 1.8;    // pilot for #2 / M2 self-tappers

$fn = 48;

// ---------- derived ----------
cell_pitch = cell_d + cell_clear*2 + bay_w_rib;      // cell center-to-center
bay_w      = 2*(cell_d + cell_clear*2) + bay_w_rib;  // bay interior width
in_l       = max(bay_l + 2*slot_depth + 2*pcb_clear, pcb_l + 2*pcb_clear);
in_w       = max(bay_w, pcb_w + 2*pcb_clear);
out_l      = in_l + 2*wall;
out_w      = in_w + 2*wall;

z_door     = door_t;                       // bay floor = door inner face
z_bayTop   = z_door + bay_h;
z_pcb      = z_bayTop + floor_t + pcb_lift; // PCB underside
z_top      = z_pcb + pcb_t + headroom;      // interior ceiling / body top
out_h      = z_top + lid_t;

cellY = cell_pitch/2;                       // cell axis offset from center

echo(str("outer envelope: ", out_l, " x ", out_w, " x ", out_h, " mm"));

// ============================================================
// BODY
// ============================================================
module body() {
  difference() {
    // outer block, open top
    translate([-out_l/2, -out_w/2, 0]) cube([out_l, out_w, z_top]);

    // electronics cavity (from bay ceiling up)
    translate([-in_l/2, -in_w/2, z_bayTop + floor_t])
      cube([in_l, in_w, z_top]);

    // battery cavity (open to the bottom for the door)
    translate([-bay_l/2, -bay_w/2, -1])
      cube([bay_l, bay_w, z_bayTop + 1]);

    // door recess (door sits flush in the bottom face)
    translate([-(bay_l+8)/2, -(bay_w+8)/2, -0.01])
      cube([bay_l+8, bay_w+8, door_t + 0.01]);

    // contact slots — PCB end (x = -bay_l/2): two singles
    for (y = [-cellY, cellY])
      translate([-bay_l/2 - slot_depth, y - slot_w_single/2, z_door])
        cube([slot_depth + 0.5, slot_w_single, bay_h]);

    // contact slot — far end (x = +bay_l/2): one dual jumper
    translate([bay_l/2 - 0.5, -slot_w_dual/2, z_door])
      cube([slot_depth + 0.5, slot_w_dual, bay_h]);

    // battery wire pass-through in the floor, beside BT1 (JST-XH)
    translate([bat_wire_x, bat_wire_y, z_bayTop - 1])
      cylinder(d = bat_wire_d, h = floor_t + 2);

    // lid lip rebate around the top rim
    translate([-in_l/2 - 1, -in_w/2 - 1, z_top - lid_lip])
      difference() {
        cube([in_l + 2, in_w + 2, lid_lip + 1]);
        translate([2, 2, -1]) cube([in_l - 2, in_w - 2, lid_lip + 3]);
      }

    // door screw pilots (into the side walls, outside the bay)
    for (y = [-1, 1])
      translate([0, y*(bay_w/2 + 1.2), -1])
        cylinder(d = screw_pilot, h = door_t + 8);

    // NTC probe wire hole (side wall), lined up with TH1
    translate([probe_x, -out_w/2 - 1, z_pcb + pcb_t + 4])
      rotate([-90, 0, 0]) cylinder(d = 6.5, h = wall + 2);
  }

  // PCB standoff pads with pilot holes, at the board's real mounting holes
  for (h = mount_holes)
    translate([h[0], h[1], z_bayTop + floor_t])
      difference() {
        cylinder(d = 6, h = pcb_lift);
        translate([0, 0, -1]) cylinder(d = pcb_pilot, h = pcb_lift + 2);
      }

  // center rib between the cells (bay ceiling down to mid-cell)
  translate([-bay_l/2, -bay_w_rib/2, z_door + cell_d/2 + cell_clear])
    cube([bay_l, bay_w_rib, z_bayTop - z_door - cell_d/2 - cell_clear]);
}

// ============================================================
// LID (flat cap with inner lip)
// ============================================================
module lid() {
  translate([-out_l/2, -out_w/2, z_top]) cube([out_l, out_w, lid_t]);
  translate([-in_l/2 + 0.3, -in_w/2 + 0.3, z_top - lid_lip])
    difference() {
      cube([in_l - 0.6, in_w - 0.6, lid_lip]);
      translate([1.8, 1.8, -1]) cube([in_l - 4.2, in_w - 4.2, lid_lip + 2]);
    }
}

// ============================================================
// DOOR (flush bottom plate, ribs press the cells up)
// ============================================================
module door() {
  fit = 0.3; // per-side print clearance in the recess
  difference() {
    translate([-(bay_l+8)/2 + fit, -(bay_w+8)/2 + fit, 0])
      cube([bay_l + 8 - 2*fit, bay_w + 8 - 2*fit, door_t]);
    for (y = [-1, 1])   // countersunk screw holes
      translate([0, y*(bay_w/2 + 1.2), -1]) {
        cylinder(d = 2.4, h = door_t + 2);
        translate([0, 0, 1 + door_t - 1.2]) cylinder(d1 = 2.4, d2 = 4.6, h = 1.21);
      }
  }
  // two ribs across both cells
  for (x = [-bay_l/4, bay_l/4])
    for (y = [-cellY, cellY])
      translate([x - 5, y - 4, door_t]) cube([10, 8, door_rib_h]);
}

// ============================================================
// reference geometry (assembly view only)
// ============================================================
module cells() {
  for (y = [-cellY, cellY])
    translate([-cell_l/2, y, z_door + door_rib_h + cell_d/2])
      rotate([0, 90, 0]) cylinder(d = cell_d, h = cell_l);
}
module pcb() {
  translate([-pcb_l/2, -pcb_w/2, z_pcb]) cube([pcb_l, pcb_w, pcb_t]);
  translate([-2, -13, z_pcb + pcb_t]) cube([20, 26, 3.2]); // WROOM-1U
}

// ============================================================
// render
// ============================================================
if (part == "assembly") {
  color("tan")            body();
  color("tan", 0.85)      translate([0, 0,  explode]) lid();
  color("tan", 0.85)      translate([0, 0, -explode]) door();
  color("steelblue", 0.8) cells();
  color("darkseagreen")   translate([0, 0, explode/3]) pcb();
} else if (part == "body") {
  body();
} else if (part == "lid") {
  lid();
} else if (part == "door") {
  door();
} else if (part == "print") { // all three, print-oriented
  body();
  translate([0, out_w + 12, z_top + lid_t]) rotate([180, 0, 0]) lid();
  translate([0, -out_w - 4, 0]) door();
}
