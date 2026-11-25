"""Print every pad (net, centre, size, layer) of a board: the coordinates handroutes.py routes to.
   python dump.py <board.kicad_pcb>"""
import pcbnew, json, sys
b=pcbnew.LoadBoard(sys.argv[1])
out={}
for fp in b.GetFootprints():
    ref=fp.GetReference()
    for p in fp.Pads():
        pos=p.GetPosition(); sz=p.GetSize()
        # size in board orientation
        ang=(p.GetOrientationDegrees())%180
        w,h=pcbnew.ToMM(sz.x),pcbnew.ToMM(sz.y)
        if abs(ang-90)<1: w,h=h,w
        out.setdefault(ref,[]).append(dict(n=p.GetNumber(),net=p.GetNetname(),x=round(pcbnew.ToMM(pos.x),3),y=round(pcbnew.ToMM(pos.y),3),w=round(w,2),h=round(h,2),L='B' if p.IsOnLayer(pcbnew.B_Cu) and not p.IsOnLayer(pcbnew.F_Cu) else ('T' if p.GetAttribute()==pcbnew.PAD_ATTRIB_PTH else ('N' if p.GetAttribute()==pcbnew.PAD_ATTRIB_NPTH else 'F'))))
json.dump(out,open('pads.json','w'),indent=0)
for ref in sorted(out):
    if ref=='U1': continue
    print(ref, ' '.join(f"{d['n']}:{d['net'].lstrip('/')}@({d['x']},{d['y']}){d['w']}x{d['h']}{d['L']}" for d in out[ref]))
