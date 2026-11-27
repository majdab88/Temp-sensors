"""Build sensor-ntc-v3.kicad_pcb from the schematic's netlist: outline, footprints,
nets and placement. Unrouted; routing is build.py's job.

  python mkboard.py            (KiCad's bundled Python)

Regenerates the board from scratch every time, so edit the placement here, not in
the PCB editor, until the layout is frozen. The schematic is the source of truth:
the netlist is exported from it on each run.

Coordinates are the v2 board's (NTC_SENSOR), so the outline, the four mounting
holes and the whole power section land exactly where v2 had them and the board
drops into the existing top-lid enclosure:

  KiCad x 72.5..112.5 (40 mm)  ->  enclosure y  +20..-20   (ey = 92.5 - x)
  KiCad y 85..145     (60 mm)  ->  enclosure x  +28.5..-31.5 (ex = 113.5 - y)

so the top edge (y = 85) faces the +X end wall with the panel button, and the
right edge (x = 112.5) faces the -Y wall with the NTC probe.
"""
import os, subprocess, sys
import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
NAME = 'sensor-ntc-v3'
SCH = os.path.join(PROJ, NAME + '.kicad_sch')
PCB = os.path.join(PROJ, NAME + '.kicad_pcb')
NET = os.path.join(HERE, 'work-netlist.net')
CLI = r'C:\Program Files\KiCad\10.0\bin\kicad-cli.exe'
STOCK = r'C:\Program Files\KiCad\10.0\share\kicad\footprints'

sys.path.insert(0, HERE)
import sexpr

OUTLINE = (72.5, 85.0, 112.5, 145.0)

# ref: (x, y, rotation_deg). All on the front.
PLACE = {
    # ── Power section: v2's positions, unchanged (proven TPS63802 loop) ──────
    'BT1':     (81.5, 139.5, 0),
    'C1':      (79.0, 131.0, 0),
    'C_buf1':  (80.53, 125.0, 0),      # 1206 now (Basic part); same pad pitch as v2's 1210
    'C_in1':   (86.0, 123.95, -90),
    'U2':      (88.75, 124.0, 0),
    'L1':      (92.5, 122.5, -90),
    'R1':      (88.67, 126.5, 180),
    'R2':      (88.67, 128.0, 0),
    'C_out1':  (92.97, 126.5, 0),      # 1206, as C_buf1
    # Battery divider, as v2.
    'R3':      (86.0, 130.32, -90),
    'R4':      (88.83, 132.0, 0),
    'Cfb1':    (88.95, 130.0, 0),

    # ── Module: u.FL toward the top edge ─────────────────────────────────────
    'U1':      (90.0, 99.5, 0),
    'C_vdd_bulk1': (81.8, 96.3, 90),   # at 3V3 (pin 3, left column)
    'C_vdd_hf1':   (79.6, 96.3, 90),
    'R_en1':   (81.8, 100.9, 90),      # EN RC, by EN (pin 8)
    'C_en1':   (79.6, 100.9, 90),

    # Straps and button pull-up, below the bottom pad row.
    'R_gpio0': (85.6, 107.8, 90),      # IO0 = pin 12
    'C_d0':    (87.6, 107.8, 90),
    'Cfn1':    (89.8, 107.8, 90),      # at the ADC pin, IO1 = pin 13
    'R_boot1': (93.4, 107.8, 90),      # IO9 = pin 23
    'R_gpio8': (95.4, 107.8, 90),      # IO8 = pin 22

    # Status LED, right of the module (bench indicator only).
    'D1':      (99.0, 95.6, 90),
    'R_LED1':  (99.0, 99.0, 90),

    # ── Panel button connector at the top edge, facing the button wall ───────
    'J_BTN':   (85.0, 88.2, 0),        # pins 1..4 = LED+, LED-, SW, GND along +x
    'Q1':      (99.0, 88.6, 0),
    'R_bled1': (102.2, 88.6, 90),
    'R_gpd1':  (99.0, 91.9, 0),

    # ── NTC probe connector, right side near the probe hole ──────────────────
    # The probe enters through the -Y wall at y ~95.7. Its inside nut sweeps
    # x >= 109.5, y 90..101.5 just above the copper, so nothing tall may sit
    # there; TH1 starts below it.
    'TH1':     (103.5, 103.6, 0),      # pin 1 = 3V3 (high side), pin 2 = NTC_ADC
    'R5':      (99.2, 104.4, 90),      # NTC_ADC -> NTC_EN, the low-side series R

    # ── Programming header and buttons: v2 positions ────────────────────────
    'J_PROG':  (78.46, 111.72, 0),
    'SW2':     (88.0, 112.3, 0),       # D0
    'SW1':     (101.0, 110.8, 0),      # RESET

    # ── Mounting holes: v2 positions (the enclosure's PCB supports) ─────────
    'H1':      (75.5, 94.0, 0),
    'H2':      (109.0, 88.5, 0),
    'H3':      (75.5, 141.5, 0),
    'H4':      (109.0, 141.5, 0),
}


def mm(v): return pcbnew.FromMM(v)


def load_fp(fpid):
    lib, name = fpid.split(':', 1)
    path = os.path.join(PROJ, NAME + '.pretty') if lib == NAME else os.path.join(STOCK, lib + '.pretty')
    fp = pcbnew.FootprintLoad(path, name)
    if fp is None:
        raise SystemExit(f'footprint not found: {fpid}')
    fp.SetFPID(pcbnew.LIB_ID(lib, name))
    return fp


def main():
    subprocess.run([CLI, 'sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', NET, SCH],
                   check=True, capture_output=True)
    comps, nets = sexpr.netlist(NET)
    missing = set(comps) - set(PLACE)
    extra = set(PLACE) - set(comps)
    if missing or extra:
        raise SystemExit(f'placement table out of step: missing {sorted(missing)}, extra {sorted(extra)}')

    b = pcbnew.BOARD()
    b.SetFileName(PCB)
    ds = b.GetDesignSettings()
    ds.SetBoardThickness(mm(1.6))

    # Outline.
    x0, y0, x1, y1 = OUTLINE
    r = pcbnew.PCB_SHAPE(b)
    r.SetShape(pcbnew.SHAPE_T_RECT)
    r.SetStart(pcbnew.VECTOR2I(mm(x0), mm(y0))); r.SetEnd(pcbnew.VECTOR2I(mm(x1), mm(y1)))
    r.SetLayer(pcbnew.Edge_Cuts); r.SetWidth(mm(0.05))
    b.Add(r)

    # Nets.
    netinfo = {}
    for name in nets:
        ni = pcbnew.NETINFO_ITEM(b, name)
        b.Add(ni)
        netinfo[name] = ni
    pin_net = {(ref, pin): name for name, nodes in nets.items() for ref, pin in nodes}

    for ref, c in sorted(comps.items()):
        fp = load_fp(c['footprint'])
        fp.SetReference(ref)
        fp.SetValue(c['value'])
        fp.SetPath(pcbnew.KIID_PATH('/' + c['uuid']))
        fp.SetSheetname('/')
        fp.SetSheetfile(NAME + '.kicad_sch')
        # Carry the symbol's fields (LCSC, MPN, Description, ...) so schematic
        # parity holds and the fab outputs can read them from the board.
        for k, v in c['fields'].items():
            if k in ('Footprint', 'Reference', 'Value'):
                continue
            fp.SetField(k, v)
            f = fp.GetField(k)
            if f is not None and k not in ('Datasheet', 'Description'):
                f.SetVisible(False)
                f.SetLayer(pcbnew.F_Fab)
        # The symbols are all in the BOM (the JLCPCB BOM is filtered by its own
        # rules); a mounting-hole footprint ships excluded, so match the symbol.
        fp.SetExcludedFromBOM(False)
        x, y, rot = PLACE[ref]
        fp.SetPosition(pcbnew.VECTOR2I(mm(x), mm(y)))
        fp.SetOrientationDegrees(rot)
        for p in fp.Pads():
            n = pin_net.get((ref, p.GetNumber()))
            if n:
                p.SetNet(netinfo[n])
        b.Add(fp)

    b.Save(PCB)
    print(f'wrote {PCB}: {len(comps)} footprints, {len(nets)} nets')


if __name__ == '__main__':
    main()
