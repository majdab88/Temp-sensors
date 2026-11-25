"""Make ESP32-C6-MINI-1U from KiCad's ESP32-C6-MINI-1: same land pattern
(datasheet v1.5 fig. 11-2), body trimmed at the antenna end, no keep-out."""
import re, uuid, sys

SRC = r"C:\Program Files\KiCad\10.0\share\kicad\footprints\RF_Module.pretty\ESP32-C6-MINI-1.kicad_mod"
DST = sys.argv[1]
s = open(SRC, encoding='utf-8').read()


def blocks(s):
    out, depth, start, i, n = [], 0, None, 0, len(s)
    while i < n:
        c = s[i]
        if c == '"':
            j = i + 1
            while s[j] != '"':
                j += 2 if s[j] == '\\' else 1
            i = j + 1
            continue
        if c == '(':
            depth += 1
            if depth == 2:
                start = i
        elif c == ')':
            if depth == 2:
                out.append((start, i + 1))
            depth -= 1
        i += 1
    return out


bl = blocks(s)
head = s[:bl[0][0]]
keep = []
for a, z in bl:
    b = s[a:z]
    if b.startswith(('(fp_line', '(fp_poly', '(zone', '(model', '(fp_rect', '(fp_circle', '(descr')):
        continue
    if b.startswith('(fp_text user') and ('Keepout' in b or 'Antenna' in b):
        continue
    keep.append(b)
head = head.replace('"ESP32-C6-MINI-1"', '"ESP32-C6-MINI-1U"')
U = lambda: str(uuid.uuid4())


def line(x1, y1, x2, y2, layer, w):
    return (f'(fp_line (start {x1:g} {y1:g}) (end {x2:g} {y2:g}) (stroke (width {w}) (type solid)) '
            f'(layer "{layer}") (uuid "{U()}"))')


T, Bt, L, R = -6.9, 5.6, -6.6, 6.6      # body: 13.2 x 12.5, bottom edge as on MINI-1
g = ['(descr "ESP32-C6-MINI-1U, u.FL antenna, 13.2x12.5x2.4 mm. Land pattern as MINI-1 '
     '(datasheet v1.5 fig. 11-2); body trimmed at the antenna end. '
     'https://documentation.espressif.com/esp32-c6-mini-1_mini-1u_datasheet_en.pdf")']
for a in [(L, T + 1, L + 1, T), (L + 1, T, R, T), (R, T, R, Bt), (R, Bt, L, Bt), (L, Bt, L, T + 1)]:   # chamfer = pin 1
    g.append(line(*a, 'F.Fab', 0.1))
o = 0.15
for a in [(L - o, T - o, R + o, T - o), (R + o, T - o, R + o, Bt + o), (R + o, Bt + o, L - o, Bt + o), (L - o, Bt + o, L - o, T - o)]:
    g.append(line(*a, 'F.SilkS', 0.12))
c = 0.25
for a in [(L - c, T - c, R + c, T - c), (R + c, T - c, R + c, Bt + c), (R + c, Bt + c, L - c, Bt + c), (L - c, Bt + c, L - c, T - c)]:
    g.append(line(*a, 'F.CrtYd', 0.05))
# u.FL receptacle: 1.70 from the left edge, 1.55 from the top (datasheet fig. 10-2)
g.append(f'(fp_circle (center -4.9 -5.35) (end -4.1 -5.35) (stroke (width 0.1) (type solid)) (fill no) '
         f'(layer "F.Fab") (uuid "{U()}"))')
g.append(f'(fp_text user "u.FL" (at -2.9 -5.35 0) (layer "F.Fab") (uuid "{U()}") '
         f'(effects (font (size 0.6 0.6) (thickness 0.1))))')
hdr = [b for b in keep if b.startswith(('(version', '(generator', '(layer'))]
rest = [b for b in keep if b not in hdr]
out = head + '\n\t'.join(hdr + g + rest) + '\n)\n'
out = out.replace('"ESP32-C6-MINI-1"', '"ESP32-C6-MINI-1U"')
open(DST, 'w', encoding='utf-8').write(out)
print('pads', out.count('(pad '))
