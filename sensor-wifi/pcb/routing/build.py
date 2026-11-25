"""Route sensor-wifi on a scratch copy.

  python build.py hand     hand routes + GND pours, then DRC
  python build.py auto     the above, then DSN -> Freerouting -> SES, then DRC

Runs under KiCad's bundled Python (pcbnew). Never touches the real board: the
result is work/sensor-wifi.kicad_pcb (+ .kicad_pro, which carries the netclasses).
To adopt it, close KiCad and copy both over ../sensor-wifi.kicad_pcb/.kicad_pro.

JAVA, JAR and CLI are this machine's install paths.
"""
import json, os, shutil, subprocess, sys
import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
# The real project; only read, never written. ROUTE_SRC routes a staged copy instead.
SRC = os.environ.get('ROUTE_SRC', os.path.dirname(HERE))
WORK = os.path.join(HERE, 'work')
PCB = os.path.join(WORK, 'sensor-wifi.kicad_pcb')
JAVA = r'C:\Program Files\Eclipse Adoptium\jre-25.0.4.101-hotspot\bin\java.exe'
JAR = r'C:\Users\Majd\Documents\KiCad\10.0\3rdparty\plugins\app_freerouting_kicad-plugin\jar\freerouting-2.4.1.jar'
CLI = r'C:\Program Files\KiCad\10.0\bin\kicad-cli.exe'

POWER = ['/VBUS', '/VBUS_IN', '/VSYS', '/VBAT', '+3V3']

sys.path.insert(0, HERE)
import handroutes as H


def strip_copper(path):
    """The real board is itself routed: start from placement only, every time.
    Drops the top-level segment/arc/via/zone blocks as text (removing them through
    pcbnew leaves its SWIG net map broken)."""
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
        a2 = s.rfind('\n', 0, a)          # take the block's leading indentation too
        keep.append(s[last:a2 if a2 >= last else a]); last = z
    keep.append(s[last:])
    open(path, 'w', encoding='utf-8', newline='').write(''.join(keep))


def fresh_copy():
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK)
    for f in ['sensor-wifi.kicad_pcb', 'sensor-wifi.kicad_pro', 'sensor-wifi.kicad_sch',
              'fp-lib-table', 'sym-lib-table', 'sensor-wifi.kicad_sym', 'sensor-wifi.kicad_dru']:
        shutil.copy(os.path.join(SRC, f), WORK)
    shutil.copytree(os.path.join(SRC, 'sensor-wifi.pretty'), os.path.join(WORK, 'sensor-wifi.pretty'))
    strip_copper(PCB)
    # Netclasses for the router: 0.25 mm signals, 0.5 mm power.
    pro = os.path.join(WORK, 'sensor-wifi.kicad_pro')
    d = json.load(open(pro))
    ns = d['net_settings']
    default = ns['classes'][0]
    default['track_width'] = 0.25
    power = dict(default, name='Power', track_width=0.5, priority=0)
    ns['classes'] = [default, power]
    ns['netclass_patterns'] = [{'netclass': 'Power', 'pattern': n} for n in POWER]
    # Freerouting necks tracks down to ~0.19 mm at the WROOM pins; JLCPCB's
    # standard process allows 0.127 mm.
    d['board']['design_settings']['rules']['min_track_width'] = 0.15
    json.dump(d, open(pro, 'w'), indent=2)


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
    """Board outline bounding box in mm, shrunk by inset."""
    bb = b.GetBoardEdgesBoundingBox()
    return (pcbnew.ToMM(bb.GetLeft()) + inset, pcbnew.ToMM(bb.GetTop()) + inset,
            pcbnew.ToMM(bb.GetRight()) - inset, pcbnew.ToMM(bb.GetBottom()) - inset)


def add_pours(b):
    # BQ24074 ground pins are too narrow for two thermal spokes; pour into them solid.
    for fp in b.GetFootprints():
        if fp.GetReference() == 'U2':
            fp.SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)
    gnd = b.GetNetsByName()['GND']
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


def islands(b):
    """Front-pour pieces with no via or through-hole GND pad: unstitched."""
    gnd = b.GetNetsByName()['GND'].GetNetCode()
    anchors = [t.GetPosition() for t in b.GetTracks()
               if t.GetClass() == 'PCB_VIA' and t.GetNetCode() == gnd]
    anchors += [p.GetPosition() for f in b.GetFootprints() for p in f.Pads()
                if p.GetNetCode() == gnd and p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH]
    for z in b.Zones():
        if z.GetLayer() != pcbnew.F_Cu: continue
        ps = z.GetFilledPolysList(pcbnew.F_Cu)
        for i in range(ps.OutlineCount()):
            if not any(ps.Contains(a, i) for a in anchors):
                bb = ps.Outline(i).BBox()
                print(f'  island {i}: ({pcbnew.ToMM(bb.GetLeft()):.1f},{pcbnew.ToMM(bb.GetTop()):.1f})'
                      f'-({pcbnew.ToMM(bb.GetRight()):.1f},{pcbnew.ToMM(bb.GetBottom()):.1f})')


def _fills(b, layer):
    gnd = b.GetNetsByName()['GND'].GetNetCode()
    return [z.GetFilledPolysList(layer) for z in b.Zones()
            if z.GetLayer() == layer and z.GetNetCode() == gnd]


def _fits(b, x, y, r=0.45):
    """A via disc of radius r at (x, y) lies wholly inside GND fill on both layers.
    The fills already keep clearance to every other copper item, so this is safe."""
    import math
    pts = [(x, y)] + [(x + r * math.cos(a * math.pi / 4), y + r * math.sin(a * math.pi / 4)) for a in range(8)]
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        polys = _fills(b, layer)
        for px, py in pts:
            q = pcbnew.VECTOR2I(pcbnew.FromMM(px), pcbnew.FromMM(py))
            if not any(ps.Contains(q) for ps in polys):
                return False
    return True


def _add_via(b, x, y):
    vi = pcbnew.PCB_VIA(b)
    vi.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y)))
    vi.SetWidth(pcbnew.FromMM(0.6)); vi.SetDrill(pcbnew.FromMM(0.3))
    vi.SetNet(b.GetNetsByName()['GND'])
    b.Add(vi)


def stitch(b):
    """Via every unanchored pour island, then a sparse grid, refilling as we go."""
    added = 0
    for _ in range(4):
        gnd = b.GetNetsByName()['GND'].GetNetCode()
        anchors = [t.GetPosition() for t in b.GetTracks()
                   if t.GetClass() == 'PCB_VIA' and t.GetNetCode() == gnd]
        anchors += [p.GetPosition() for f in b.GetFootprints() for p in f.Pads()
                    if p.GetNetCode() == gnd and p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH]
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
                    steps = 12
                    for ix in range(steps + 1):
                        for iy in range(steps + 1):
                            x = x0 + (x1 - x0) * ix / steps; y = y0 + (y1 - y0) * iy / steps
                            q = pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y))
                            if ps.Contains(q, i) and _fits(b, x, y):
                                _add_via(b, x, y); added += 1; done = True; break
                        if done: break
                    if not done:
                        print(f'  could not stitch island ({x0:.1f},{y0:.1f})-({x1:.1f},{y1:.1f}) on {b.GetLayerName(layer)}')
        fill(b)
        if todo == 0:
            break
    # Sparse grid: tie the two pours together every ~6 mm where a via fits.
    x0, y0, x1, y1 = edges(b, 3.0)
    for i in range(int((x1 - x0) // 6) + 1):
        for j in range(int((y1 - y0) // 6) + 1):
            gx, gy = x0 + 6 * i, y0 + 6 * j
            if _fits(b, gx, gy, 0.6):
                _add_via(b, gx, gy); added += 1
    fill(b)
    print(f'  stitching vias added: {added}')


def drc(tag):
    out = os.path.join(WORK, f'drc_{tag}.json')
    subprocess.run([CLI, 'pcb', 'drc', '--format', 'json', '--severity-all',
                    '--schematic-parity', '-o', out, PCB], capture_output=True)
    r = json.load(open(out))
    vio = r.get('violations', [])
    unc = r.get('unconnected_items', [])
    par = r.get('schematic_parity', [])
    from collections import Counter
    print(f'[{tag}] violations {len(vio)}: {dict(Counter(v["type"] for v in vio))}')
    print(f'[{tag}] unconnected {len(unc)}, parity {len(par)}')
    return r


def main(mode):
    fresh_copy()
    b = pcbnew.LoadBoard(PCB)
    add_hand(b)
    add_pours(b)
    fill(b)
    b.Save(PCB)
    if mode == 'hand':
        r = drc('hand')
        for v in r['violations']:
            if v['type'] in ('clearance', 'shorting_items', 'tracks_crossing', 'hole_clearance',
                             'copper_edge_clearance', 'track_dangling', 'via_dangling'):
                print('  ', v['type'], '|', ' / '.join(i['description'] for i in v['items']))
        return
    dsn = os.path.join(WORK, 'r.dsn'); ses = os.path.join(WORK, 'r.ses')
    if not pcbnew.ExportSpecctraDSN(b, dsn):
        raise SystemExit('DSN export failed')
    p = subprocess.run([JAVA, '-jar', JAR, '--gui.enabled=false', '-de', dsn, '-do', ses, '-mp', '40', '-mt', '4'],
                       capture_output=True, text=True, timeout=1800)
    print(p.stdout[-1500:]); print(p.stderr[-1500:])
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
