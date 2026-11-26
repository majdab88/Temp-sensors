"""Build sensor-wifi-v2.kicad_pcb from the schematic's netlist: outline,
footprints, fields, nets and placement. Unrouted; routing is build.py's job.

  python mkboard.py            (KiCad's bundled Python)

Regenerates the board from scratch every time, so edit placement here until the
layout is frozen. Coordinates are v1's (../pcb): the outline, the mounting holes,
the 18650 holder on the back and every part v2 kept sit exactly where v1 had them,
so v1's enclosure and v1's hand routes still fit. What changed is the power entry:
the TP4056 module replaces J1 (USB-C), the BQ24074 charger and the cell protection.
"""
import os, subprocess, sys
import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
NAME = 'sensor-wifi-v2'
SCH = os.path.join(PROJ, NAME + '.kicad_sch')
PCB = os.path.join(PROJ, NAME + '.kicad_pcb')
NET = os.path.join(HERE, 'work-netlist.net')
CLI = r'C:\Program Files\KiCad\10.0\bin\kicad-cli.exe'
STOCK = r'C:\Program Files\KiCad\10.0\share\kicad\footprints'

sys.path.insert(0, HERE)
import sexpr

OUTLINE = (93.0, 100.0, 157.0, 190.0)

# ref: (x, y, rotation_deg, side)
PLACE = {
    # ── Kept from v1, at v1's positions ──────────────────────────────────────
    'BT1': (139.0, 145.0, 90.0, 'B'),
    'C10': (122.725, 147.6, 0.0, 'F'),
    'C11': (126.2, 104.5, 0.0, 'F'),
    'C12': (120.4, 102.9, 0.0, 'F'),
    'C13': (106.0, 105.3, 0.0, 'F'),
    'C14': (102.2, 112.3, 0.0, 'F'),
    'C15': (102.2, 114.3, 0.0, 'F'),
    'C16': (102.2, 110.2, 0.0, 'F'),
    'C17': (130.0, 106.8, 0.0, 'F'),
    'C7': (133.5, 103.6, 90.0, 'F'),
    'C8': (115.75, 140.95, -90.0, 'F'),
    'C9': (122.725, 144.1, 0.0, 'F'),
    'D4': (102.2, 108.2, 0.0, 'F'),
    'D5': (130.0, 108.9, 0.0, 'F'),
    'F3': (118.0, 177.4, -90.0, 'F'),
    'H1': (96.0, 103.5, 0.0, 'F'),
    'H2': (154.0, 103.5, 0.0, 'F'),
    'H3': (96.0, 186.5, 0.0, 'F'),
    'H4': (154.0, 186.5, 0.0, 'F'),
    'J2': (104.0, 139.5, 0.0, 'F'),
    'J3': (122.9, 174.0, 0.0, 'F'),
    'L1': (122.95, 139.3, -90.0, 'F'),
    'Q1': (139.5, 174.5, 0.0, 'F'),
    'R10': (136.0, 171.6, 180.0, 'F'),
    'R11': (136.6, 174.5, -90.0, 'F'),
    'R15': (130.0, 102.6, 0.0, 'F'),
    'R16': (130.0, 104.6, 0.0, 'F'),
    'R17': (118.425, 143.5, 180.0, 'F'),
    'R18': (118.425, 145.0, 0.0, 'F'),
    'R19': (102.2, 104.2, 0.0, 'F'),
    'R20': (106.0, 119.5, 0.0, 'F'),
    'R21': (106.0, 116.7, 0.0, 'F'),
    'R22': (106.0, 107.6, 0.0, 'F'),
    'R23': (106.0, 109.6, 0.0, 'F'),
    'R24': (130.0, 111.4, 0.0, 'F'),
    'SW1': (113.0, 126.0, 0.0, 'F'),
    'SW2': (102.5, 126.0, 0.0, 'F'),
    'U1': (117.0, 111.0, -90.0, 'F'),
    'U4': (118.5, 141.0, 0.0, 'F'),
    'Y1': (106.3, 113.1, 90.0, 'F'),

    # ── New in v2 ────────────────────────────────────────────────────────────
    # TP4056 module where J1 was, USB-C out of the bottom edge. Its receptacle
    # face lands where J1's did (board edge + 1.05 mm, on the enclosure wall).
    # Pads: + (101.85, 172.5), B- (111.61, 172.5), OUT- (114.15, 172.5),
    # NC (104.39, 172.5), IN+ (101.85, 186.5), IN- (114.15, 186.5).
    'U2': (108.0, 180.4, 180.0, 'F'),
    # Input bulk beside the module's + pad (C4/C5 were the charger's caps).
    'C4': (105.0, 163.4, 90.0, 'F'),
    'C5': (108.0, 163.4, 90.0, 'F'),
    # Low-side reverse-cell FET beside the holder's - contact (top), where the
    # DW01A / 8205A sat in v1. Its gate resistor R12 reaches to CELL_P; R13
    # holds it off.
    'Q2': (138.0, 120.0, 0.0, 'F'),
    'R13': (135.0, 120.0, 90.0, 'F'),
    'R12': (135.0, 123.5, 90.0, 'F'),
    # USB-present divider (module IN+ -> GPIO7), left of the module.
    'R8': (97.5, 177.0, 90.0, 'F'),
    'R9': (97.5, 174.0, 90.0, 'F'),
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
    missing, extra = set(comps) - set(PLACE), set(PLACE) - set(comps)
    if missing or extra:
        raise SystemExit(f'placement table out of step: missing {sorted(missing)}, extra {sorted(extra)}')

    b = pcbnew.BOARD()
    b.SetFileName(PCB)
    b.GetDesignSettings().SetBoardThickness(mm(1.6))
    x0, y0, x1, y1 = OUTLINE
    r = pcbnew.PCB_SHAPE(b)
    r.SetShape(pcbnew.SHAPE_T_RECT)
    r.SetStart(pcbnew.VECTOR2I(mm(x0), mm(y0))); r.SetEnd(pcbnew.VECTOR2I(mm(x1), mm(y1)))
    r.SetLayer(pcbnew.Edge_Cuts); r.SetWidth(mm(0.05))
    b.Add(r)

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
        for k, v in c['fields'].items():
            if k in ('Footprint', 'Reference', 'Value'):
                continue
            fp.SetField(k, v)
            f = fp.GetField(k)
            if f is not None and k not in ('Datasheet', 'Description'):
                f.SetVisible(False)
                f.SetLayer(pcbnew.F_Fab)
        # Symbols are all in the BOM; a mounting-hole footprint ships excluded.
        fp.SetExcludedFromBOM(False)
        for p in fp.Pads():
            n = pin_net.get((ref, p.GetNumber()))
            if n:
                p.SetNet(netinfo[n])
        # Add before moving: flipping a footprint that has no board crashes pcbnew.
        b.Add(fp)
        x, y, rot, side = PLACE[ref]
        fp.SetPosition(pcbnew.VECTOR2I(mm(x), mm(y)))
        if side == 'B':
            fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
        fp.SetOrientationDegrees(rot)

    b.Save(PCB)
    print(f'wrote {PCB}: {len(comps)} footprints, {len(nets)} nets')


if __name__ == '__main__':
    main()
