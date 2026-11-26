"""Write the TP4056 Mini (Type-C) charger module's footprint and symbol.

  python mkfp_tp4056.py        (any Python 3)

Geometry is from the vendor model 'TP4056 Mini.STEP' (GrabCAD), measured with
FreeCAD: board 14.0 x 17.5 x 1.0 mm, six plated holes of 1.0 mm, the USB-C
receptacle 9.2 mm wide and overhanging the board's USB end by 1.9 mm. Pad names
are from the module's silkscreen (photos in the same download).

Footprint frame: origin at the module board's centre, USB end toward -y,
seen from the component side (the module sits flat on our board, parts up).
Its holes take a cut-down pin header, or solder fills them onto our pads.

Pad 5 is the unlabelled hole beside '+'. It is probably a second '+', but that
is unconfirmed, so it is an isolated pad (mechanical strength only) until a
continuity check says otherwise.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)

W, H = 14.0, 17.5            # module board
USB_W, USB_OUT = 9.2, 1.9    # receptacle width, overhang past the board's USB end
DRILL, PAD = 1.0, 1.8
# STEP coordinates of the board centre, so hole positions can be copied verbatim.
CX, CY = -1.786, -0.389
HOLES = [  # number, name, STEP x, STEP y
    ('1', 'IN+', 4.364, -6.489),
    ('2', 'IN-', -7.936, -6.489),
    ('3', 'OUT-', -7.936, 7.511),
    ('4', 'B-', -5.396, 7.511),
    ('5', 'NC', 1.824, 7.511),
    ('6', '+', 4.364, 7.511),
]


def r(v): return round(v, 3)


def footprint():
    x0, x1, y0, y1 = -W / 2, W / 2, -H / 2, H / 2
    yu = y0 - USB_OUT
    out = ['(footprint "TP4056_Mini_TypeC"', '\t(version 20241229)', '\t(generator "mkfp_tp4056.py")',
           '\t(layer "F.Cu")',
           '\t(descr "TP4056 Mini Type-C Li-ion charger module with protection, 14x17.5 mm, soldered flat; '
           'holes 1.0 mm. From the vendor STEP (GrabCAD TP4056 Mini).")',
           '\t(tags "TP4056 charger module")',
           '\t(attr through_hole)',
           f'\t(property "Reference" "REF**" (at 0 {r(y1 + 1.5)} 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))',
           '\t(property "Value" "TP4056_Mini_TypeC" (at 0 0 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))']

    def rect(layer, ax, ay, bx, by, w):
        return f'\t(fp_rect (start {r(ax)} {r(ay)}) (end {r(bx)} {r(by)}) (stroke (width {w}) (type solid)) (fill no) (layer "{layer}"))'
    out.append(rect('F.Fab', x0, y0, x1, y1, 0.1))
    out.append(rect('F.Fab', -USB_W / 2, yu, USB_W / 2, y0 + 5.1, 0.1))     # receptacle body
    out.append(rect('F.SilkS', x0 - 0.12, y0 - 0.12, x1 + 0.12, y1 + 0.12, 0.12))
    out.append(rect('F.CrtYd', x0 - 0.25, yu - 0.25, x1 + 0.25, y1 + 0.25, 0.05))
    out.append(f'\t(fp_text user "USB-C" (at 0 {r(y0 + 1.5)} 0) (layer "F.Fab") (effects (font (size 0.8 0.8) (thickness 0.1))))')
    for num, name, sx, sy in HOLES:
        x, y = sx - CX, sy - CY
        shape = 'rect' if num == '1' else 'circle'
        out.append(f'\t(pad "{num}" thru_hole {shape} (at {r(x)} {r(y)}) (size {PAD} {PAD}) (drill {DRILL}) '
                   f'(layers "*.Cu" "*.Mask") (pinfunction "{name}"))')
        out.append(f'\t(fp_text user "{name}" (at {r(x)} {r(y + (-1.6 if y < 0 else 1.6))} 0) (layer "F.Fab") '
                   f'(effects (font (size 0.6 0.6) (thickness 0.1))))')
    # 3D: the vendor STEP has its parts on -Z with the board's bare face at
    # z = 21.52. Turned 180 deg about X its parts face up and its USB end stays
    # at the footprint's -y; the offset centres the board on the origin with its
    # bare face on our board. The STEP is not committed (GrabCAD licence).
    out.append(f'\t(model "${{KIPRJMOD}}/3d/TP4056_Mini.step" (offset (xyz {r(-CX)} {r(CY)} 21.52)) '
               f'(scale (xyz 1 1 1)) (rotate (xyz 180 0 0)))')
    out.append(')')
    return '\n'.join(out) + '\n'


def symbol():
    pins = [('1', 'IN+', 'power_in', -10.16, 2.54, 0), ('2', 'IN-', 'power_in', -10.16, -2.54, 0),
            ('6', '+', 'passive', 10.16, 5.08, 180), ('4', 'B-', 'passive', 10.16, 0.0, 180),
            ('3', 'OUT-', 'passive', 10.16, -5.08, 180), ('5', 'NC', 'no_connect', 10.16, -7.62, 180)]
    p = ['\t(symbol "TP4056_Mini_TypeC"', '\t\t(exclude_from_sim no) (in_bom yes) (on_board yes)',
         '\t\t(property "Reference" "U" (at 0 10.16 0) (effects (font (size 1.27 1.27))))',
         '\t\t(property "Value" "TP4056_Mini_TypeC" (at 0 -10.16 0) (effects (font (size 1.27 1.27))))',
         '\t\t(property "Footprint" "sensor-wifi-v2:TP4056_Mini_TypeC" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))',
         '\t\t(property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))',
         '\t\t(property "Description" "TP4056 Mini Type-C Li-ion charger with protection (module). + is B+ and OUT+ (one node); OUT- is system ground; IN- = OUT-." (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))',
         '\t\t(symbol "TP4056_Mini_TypeC_0_1"',
         '\t\t\t(rectangle (start -7.62 7.62) (end 7.62 -8.89) (stroke (width 0.254) (type default)) (fill (type background)))',
         '\t\t)', '\t\t(symbol "TP4056_Mini_TypeC_1_1"']
    for num, name, kind, x, y, ang in pins:
        p.append(f'\t\t\t(pin {kind} line (at {x} {y} {ang}) (length 2.54) (name "{name}" (effects (font (size 1.27 1.27)))) '
                 f'(number "{num}" (effects (font (size 1.27 1.27)))))')
    p += ['\t\t)', '\t)']
    return '\n'.join(p)


open(os.path.join(PROJ, 'sensor-wifi-v2.pretty', 'TP4056_Mini_TypeC.kicad_mod'), 'w', encoding='utf-8').write(footprint())
sym_path = os.path.join(PROJ, 'sensor-wifi-v2.kicad_sym')
s = open(sym_path, encoding='utf-8').read()
if '(symbol "TP4056_Mini_TypeC"' not in s:
    i = s.rstrip().rfind(')')
    s = s[:i].rstrip() + '\n' + symbol() + '\n)\n'
    open(sym_path, 'w', encoding='utf-8').write(s)
print('footprint and symbol written')
