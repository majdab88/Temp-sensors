"""Route sensor-wifi-v2 on a scratch copy.

  python build.py hand     hand routes + GND pours, then DRC
  python build.py auto     the above, then DSN -> Freerouting -> SES, stitching, DRC

Runs under KiCad's bundled Python (pcbnew). Never touches the real board: the
result is work/sensor-ntc-v3.kicad_pcb. To adopt it, close KiCad and copy it over
../sensor-ntc-v3.kicad_pcb. The input's copper is stripped first, so it can run
on the adopted (routed) board as well as on mkboard.py's unrouted output.
After a placement change: mkboard.py, fix handroutes.py, build.py auto, adopt.

Freerouting's result differs between runs. Everything whose loss would go
unnoticed or matter (the TPS63802 loop, all of 3V3, the stranded GND pads) is
hand-routed for that reason; a run is good when DRC reports 0 unconnected.

Adapted from sensor-ntc/pcb-v3/routing/build.py, itself from sensor-wifi v1.
"""
import json, math, os, shutil, subprocess, sys
from collections import Counter
import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)
NAME = 'sensor-wifi-v2'
WORK = os.path.join(HERE, 'work')
PCB = os.path.join(WORK, NAME + '.kicad_pcb')
JAVA = r'C:\Program Files\Eclipse Adoptium\jre-25.0.4.101-hotspot\bin\java.exe'
JAR = r'C:\Users\Majd\Documents\KiCad\10.0\3rdparty\plugins\app_freerouting_kicad-plugin\jar\freerouting-2.4.1.jar'
CLI = r'C:\Program Files\KiCad\10.0\bin\kicad-cli.exe'
GND = 'GND'

sys.path.insert(0, HERE)
import handroutes as H


def strip_copper(path):
    """The adopted board is itself routed: start from placement only, every time.
    Drops the top-level segment/arc/via/zone blocks as text (removing them through
    pcbnew leaves its SWIG net map broken). From sensor-wifi."""
    s = open(path, encoding='utf-8', newline='').read()
    out, i, depth, n = [], 0, 0, len(s)
    start = None
    while i < n:
        c = s[i]
        if c == '"':                      # skip quoted strings, honouring \"
            j = i + 1
            while s[j] != '"':
                j += 2 if s[j] == '\\' else 1
            i = j + 1; continue
        if c == '(':
            depth += 1
            if depth == 2 and s.startswith(('(segment', '(arc', '(via', '(zone'), i):
                start = i
        elif c == ')':
            if depth == 2 and start is not None:
                out.append((start, i + 1)); start = None
            depth -= 1
        i += 1
    keep, last = [], 0
    for a, z in out:
        a2 = s.rfind('\n', 0, a)
        keep.append(s[last:a2 if a2 >= last else a]); last = z
    keep.append(s[last:])
    open(path, 'w', encoding='utf-8', newline='').write(''.join(keep))


def fresh_copy():
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK)
    for f in [NAME + '.kicad_pcb', NAME + '.kicad_pro', NAME + '.kicad_sch',
              'fp-lib-table', 'sym-lib-table', NAME + '.kicad_sym']:
        shutil.copy(os.path.join(SRC, f), WORK)
    dru = os.path.join(SRC, NAME + '.kicad_dru')
    if os.path.exists(dru):
        shutil.copy(dru, WORK)
    shutil.copytree(os.path.join(SRC, NAME + '.pretty'), os.path.join(WORK, NAME + '.pretty'))
    strip_copper(PCB)


def mm(v): return pcbnew.FromMM(v)
def pt(x, y): return pcbnew.VECTOR2I(mm(x), mm(y))


def add_hand(b):
    nets = b.GetNetsByName()
    def net(n):
        if not nets.has_key(n): raise SystemExit(f'no net {n}')
        return nets[n]
    for name, layer, w, pts in H.T:
        for a, c in zip(pts, pts[1:]):
            tr = pcbnew.PCB_TRACK(b)
            tr.SetStart(pt(*a)); tr.SetEnd(pt(*c))
            tr.SetWidth(mm(w)); tr.SetLayer(b.GetLayerID(layer))
            tr.SetNet(net(name)); tr.SetLocked(True)
            b.Add(tr)
    for name, x, y, size, drill in H.V:
        vi = pcbnew.PCB_VIA(b)
        vi.SetPosition(pt(x, y)); vi.SetWidth(mm(size)); vi.SetDrill(mm(drill))
        vi.SetNet(net(name)); vi.SetLocked(True)
        b.Add(vi)


def edges(b, inset):
    bb = b.GetBoardEdgesBoundingBox()
    return (pcbnew.ToMM(bb.GetLeft()) + inset, pcbnew.ToMM(bb.GetTop()) + inset,
            pcbnew.ToMM(bb.GetRight()) - inset, pcbnew.ToMM(bb.GetBottom()) - inset)


def add_pours(b):
    gnd = b.GetNetsByName()[GND]
    x0, y0, x1, y1 = edges(b, 0.3)
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        z = pcbnew.ZONE(b)
        z.SetLayer(layer); z.SetNet(gnd)
        z.SetLocalClearance(mm(0.25))
        z.SetMinThickness(mm(0.25))
        z.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
        z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
        z.SetThermalReliefGap(mm(0.3))
        z.SetThermalReliefSpokeWidth(mm(0.4))
        o = z.Outline(); o.NewOutline()
        for x, y in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]:
            o.Append(mm(x), mm(y))
        b.Add(z)


def fill(b):
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())


def _gnd_anchors(b):
    gnd = b.GetNetsByName()[GND].GetNetCode()
    a = [t.GetPosition() for t in b.GetTracks()
         if t.GetClass() == 'PCB_VIA' and t.GetNetCode() == gnd]
    a += [p.GetPosition() for f in b.GetFootprints() for p in f.Pads()
          if p.GetNetCode() == gnd and p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH]
    return a


def _fills(b, layer):
    gnd = b.GetNetsByName()[GND].GetNetCode()
    return [z.GetFilledPolysList(layer) for z in b.Zones()
            if z.GetLayer() == layer and z.GetNetCode() == gnd]


def _fits(b, x, y, r=0.45):
    """A via disc of radius r at (x, y) lies wholly inside GND fill on both
    layers. The fills already keep clearance to all other copper."""
    pts = [(x, y)] + [(x + r * math.cos(a * math.pi / 4), y + r * math.sin(a * math.pi / 4)) for a in range(8)]
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        polys = _fills(b, layer)
        for px, py in pts:
            q = pcbnew.VECTOR2I(mm(px), mm(py))
            if not any(ps.Contains(q) for ps in polys):
                return False
    return True


def _add_via(b, x, y):
    vi = pcbnew.PCB_VIA(b)
    vi.SetPosition(pt(x, y)); vi.SetWidth(mm(0.6)); vi.SetDrill(mm(0.3))
    vi.SetNet(b.GetNetsByName()[GND])
    b.Add(vi)


def stitch(b):
    """Via every unanchored pour island, then a sparse grid, refilling as we go."""
    added = 0
    for _ in range(4):
        anchors = _gnd_anchors(b)
        todo = 0
        for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
            for ps in _fills(b, layer):
                for i in range(ps.OutlineCount()):
                    if any(ps.Contains(a, i) for a in anchors):
                        continue
                    todo += 1
                    bb = ps.Outline(i).BBox()
                    x0, x1 = pcbnew.ToMM(bb.GetLeft()), pcbnew.ToMM(bb.GetRight())
                    y0, y1 = pcbnew.ToMM(bb.GetTop()), pcbnew.ToMM(bb.GetBottom())
                    done = False
                    # A comfortable margin first; then the via's own radius
                    # (0.3) plus a hair on a finer grid. The fills already hold
                    # clearance to other copper, so 0.32 is still DRC-clean.
                    for r, steps in ((0.45, 12), (0.32, 40)):
                        for ix in range(steps + 1):
                            for iy in range(steps + 1):
                                x = x0 + (x1 - x0) * ix / steps; y = y0 + (y1 - y0) * iy / steps
                                if ps.Contains(pt(x, y), i) and _fits(b, x, y, r):
                                    _add_via(b, x, y); added += 1; done = True; break
                            if done: break
                        if done: break
                    if not done:
                        print(f'  could not stitch island ({x0:.1f},{y0:.1f})-({x1:.1f},{y1:.1f}) on {b.GetLayerName(layer)}')
        fill(b)
        if todo == 0:
            break
    # Sparse grid: tie the two pours together every ~5 mm where a via fits.
    x0, y0, x1, y1 = edges(b, 2.0)
    for i in range(int((x1 - x0) // 5) + 1):
        for j in range(int((y1 - y0) // 5) + 1):
            gx, gy = x0 + 5 * i, y0 + 5 * j
            if _fits(b, gx, gy, 0.6):
                _add_via(b, gx, gy); added += 1
    fill(b)
    print(f'  stitching vias added: {added}')


def islands(b):
    """Pour pieces on either layer with no GND via or through-hole GND pad."""
    anchors = _gnd_anchors(b)
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        for ps in _fills(b, layer):
            for i in range(ps.OutlineCount()):
                if not any(ps.Contains(a, i) for a in anchors):
                    bb = ps.Outline(i).BBox()
                    print(f'  island on {b.GetLayerName(layer)}: ({pcbnew.ToMM(bb.GetLeft()):.1f},{pcbnew.ToMM(bb.GetTop()):.1f})'
                          f'-({pcbnew.ToMM(bb.GetRight()):.1f},{pcbnew.ToMM(bb.GetBottom()):.1f})')


COSMETIC = {'silk_overlap', 'silk_over_copper', 'silk_edge_clearance', 'lib_footprint_mismatch',
            'lib_footprint_issues'}


def drc(tag):
    out = os.path.join(WORK, f'drc_{tag}.json')
    subprocess.run([CLI, 'pcb', 'drc', '--format', 'json', '--severity-all',
                    '--schematic-parity', '-o', out, PCB], capture_output=True)
    r = json.load(open(out, encoding='utf-8'))
    vio = r.get('violations', [])
    unc = r.get('unconnected_items', [])
    par = r.get('schematic_parity', [])
    print(f'[{tag}] violations {len(vio)}: {dict(Counter(v["type"] for v in vio))}')
    print(f'[{tag}] unconnected {len(unc)}, parity {len(par)}')
    for v in vio:
        if v['type'] not in COSMETIC:
            print('   ', v['type'], '|', ' / '.join(i['description'] for i in v['items']))
    for u in unc[:30]:
        print('    unconnected |', ' / '.join(i['description'] for i in u['items']))
    return r


def main(mode):
    fresh_copy()
    b = pcbnew.LoadBoard(PCB)
    add_hand(b)
    add_pours(b)
    fill(b)
    b.Save(PCB)
    if mode == 'hand':
        drc('hand')
        return
    dsn = os.path.join(WORK, 'r.dsn'); ses = os.path.join(WORK, 'r.ses')
    if not pcbnew.ExportSpecctraDSN(b, dsn):
        raise SystemExit('DSN export failed')
    # --gui.enabled=false is required: otherwise an exception dialog blocks the
    # run and the SES comes out empty.
    p = subprocess.run([JAVA, '-jar', JAR, '--gui.enabled=false', '-de', dsn, '-do', ses,
                        '-mp', '40', '-mt', '4'], capture_output=True, text=True, timeout=1800)
    print(p.stdout[-1200:]); print(p.stderr[-800:])
    if not os.path.exists(ses):
        raise SystemExit('no SES produced')
    if not pcbnew.ImportSpecctraSES(b, ses):
        raise SystemExit('SES import failed')
    fill(b)
    stitch(b)
    b.Save(PCB)
    islands(b)
    drc('auto')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'hand')
