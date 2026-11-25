"""Studio renders of the sensor-ntc v2 top-lid enclosure, headless in Blender.

This PC's Intel HD 4600 cannot run Blender's interface, but Cycles renders on
the CPU without it, so everything here runs in background mode:

    blender -b --factory-startup --python render.py -- [options]

Options (all optional):
    --glb PATH        model exported from SolidCraft (default: next to this file)
    --out DIR         where the PNGs go (default: next to this file)
    --shots a,b       which shots to render (default: all; see SHOTS)
    --res WxH         image size (default 1600x1200)
    --samples N       Cycles samples (default 128; denoised)

Export the GLB from SolidCraft with every body (File > Export, .glb): it keeps
each body's colour, which is what the material rules below key on.
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))

# Bodies in the model that are not real parts.
HIDE = {"BatteryHolder_ref", "placementOutline"}

# Plastic colours for the printed parts. The SolidCraft colours are kept by
# default; change these to preview another filament.
BASE_RGB = None   # None = the colour assigned in SolidCraft
LID_RGB = None


# --------------------------------------------------------------------------
# Materials
# --------------------------------------------------------------------------

def srgb(r, g, b):
    """0-255 sRGB to linear."""
    def f(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (f(r), f(g), f(b), 1.0)


def principled(name, color, metal=0.0, rough=0.5, coat=0.0, bump=0.0,
               bump_scale=4000.0, alpha=1.0, transmission=0.0, emission=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = color
    b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    b.inputs["Coat Weight"].default_value = coat
    b.inputs["Coat Roughness"].default_value = 0.08
    b.inputs["Transmission Weight"].default_value = transmission
    if emission is not None:
        b.inputs["Emission Color"].default_value = emission[0]
        b.inputs["Emission Strength"].default_value = emission[1]
    if alpha < 1.0:
        b.inputs["Alpha"].default_value = alpha
    if bump > 0:
        # Fine noise: the slightly grainy surface of a printed or moulded part,
        # which keeps large flat faces from looking like perfect CG.
        tc = nt.nodes.new("ShaderNodeTexCoord")
        nz = nt.nodes.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = bump_scale
        nz.inputs["Detail"].default_value = 2.0
        bp = nt.nodes.new("ShaderNodeBump")
        bp.inputs["Strength"].default_value = bump
        bp.inputs["Distance"].default_value = 0.00005
        nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
        nt.links.new(nz.outputs["Fac"], bp.inputs["Height"])
        nt.links.new(bp.outputs["Normal"], b.inputs["Normal"])
    return m


def base_color(mat):
    b = mat.node_tree.nodes.get("Principled BSDF") if mat and mat.use_nodes else None
    return tuple(b.inputs["Base Color"].default_value) if b else (0.5, 0.5, 0.5, 1.0)


def build_library():
    L = {}
    L["solder_mask"] = principled("Solder mask", srgb(18, 74, 40), rough=0.35, coat=0.6)
    L["gold"] = principled("ENIG gold", srgb(232, 190, 110), metal=1.0, rough=0.22)
    L["tin"] = principled("Tin plating", srgb(205, 205, 200), metal=1.0, rough=0.3)
    L["shield"] = principled("Nickel silver shield", srgb(215, 215, 210), metal=1.0,
                             rough=0.18, bump=0.15, bump_scale=900.0)
    L["aluminium"] = principled("Aluminium can", srgb(200, 200, 205), metal=1.0, rough=0.28)
    L["stainless"] = principled("Stainless steel", srgb(195, 195, 192), metal=1.0, rough=0.2)
    L["zinc"] = principled("Zinc-plated steel", srgb(185, 188, 192), metal=1.0, rough=0.35)
    L["epoxy"] = principled("Black epoxy", srgb(22, 22, 24), rough=0.45)
    L["black_plastic"] = principled("Black plastic", srgb(18, 18, 18), rough=0.55)
    L["ceramic"] = principled("Ceramic MLCC", srgb(120, 92, 70), rough=0.5)
    L["ivory_nylon"] = principled("Ivory nylon", srgb(235, 228, 205), rough=0.5)
    L["white_plastic"] = principled("White plastic", srgb(240, 240, 236), rough=0.4)
    L["cap_sleeve"] = principled("Capacitor sleeve", srgb(28, 70, 150), rough=0.3, coat=0.3)
    L["rubber_black"] = principled("Black rubber", srgb(14, 14, 14), rough=0.8)
    L["silicone_red"] = principled("Red silicone", srgb(150, 20, 18), rough=0.6)
    L["tpu"] = principled("Black TPU", srgb(20, 20, 20), rough=0.7, bump=0.3)
    L["led_lens"] = principled("LED lens", srgb(255, 240, 225), rough=0.1,
                               transmission=0.7)
    return L


def printed_plastic(name, rgba):
    return principled(name, rgba, rough=0.55, bump=0.25)


def material_for(obj_name, mat, L):
    """Pick a realistic material from the body name and the source colour.

    The source colours are KiCad's and the vendors' flat RGB codes; the names
    below are what came through the GLB for this board.
    """
    n = mat.name if mat else ""
    r, g, b, _ = base_color(mat)

    # Printed enclosure parts.
    if obj_name == "Base":
        return printed_plastic("Base PETG", BASE_RGB or (r, g, b, 1.0))
    if obj_name == "Lid":
        return printed_plastic("Lid PETG", LID_RGB or (r, g, b, 1.0))
    if obj_name == "Gasket":
        return L["tpu"]

    # NTC probe hardware.
    if obj_name == "NTC probe":
        return L["stainless"]
    if obj_name == "NTC nut":
        return L["zinc"]
    if obj_name == "NTC seal ring":
        return L["rubber_black"]

    # Panel push button (stainless body, nickel nut, red seal, LED ring).
    if obj_name.startswith("Push_btn_nut"):
        return L["zinc"]
    if obj_name.startswith("Sealing_ring"):
        return L["silicone_red"]
    if obj_name.startswith("Push_btn"):
        if n.startswith("Push_btn") or n == "Custom(145,140,130)":
            return L["stainless"]
        if n in ("Custom(255,255,255)", "Custom(255,227,105)"):
            return L["led_lens"]

    # Board and components.
    if obj_name == "NTC_SENSOR_PCB":
        return L["solder_mask"]
    if obj_name.startswith("ESP32-WROOM-32U_Shieldingcase"):
        return L["shield"]
    if obj_name.startswith("I-IPEX"):
        return L["gold"]
    if n in ("pad", "Custom(212,176,56)", "Custom(219,188,126)"):
        return L["gold"]
    if n == "Custom(176,169,152)":
        return L["aluminium"]
    if n == "Custom(35,103,185)":
        return L["cap_sleeve"]
    if n == "Custom(97,69,55)":
        return L["ceramic"]
    if n == "Custom(228,227,207)":
        return L["ivory_nylon"]
    if n in ("Custom(202,209,238)", "Custom(210,209,199)", "Custom(192,192,192)",
             "Custom(170,170,170)", "VLS3015CX-1R5M-H") or n.startswith("TPS63802DLAR ("):
        if n == "TPS63802DLAR (2)":
            return L["epoxy"]
        return L["tin"]
    if n in ("white", "APT1608SURCK (3)"):
        return L["white_plastic"]
    if n.startswith("Custom(0,192,0)") or n.startswith("Custom(255,192,0)") \
            or n.startswith("Custom(255,255,192)"):
        return L["led_lens"]
    if max(r, g, b) < 0.25:
        return L["epoxy"]
    return None  # keep the imported material


def apply_materials(objs):
    L = build_library()
    for o in objs:
        for slot in o.material_slots:
            new = material_for(o.name, slot.material, L)
            if new is not None:
                slot.material = new


# --------------------------------------------------------------------------
# Scene
# --------------------------------------------------------------------------

def import_model(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = []
    for o in list(bpy.data.objects):
        if o.type != "MESH":
            continue
        if o.name in HIDE:
            o.hide_render = True
            continue
        meshes.append(o)
    return meshes


def bounds(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector([min(p[i] for p in pts) for i in range(3)])
    hi = Vector([max(p[i] for p in pts) for i in range(3)])
    return lo, hi


def add_backdrop(facing_yaw):
    """A seamless studio sweep: floor curving up into a back wall, turned so
    the wall is behind the model as seen from a camera at `facing_yaw`."""
    import bmesh
    me = bpy.data.meshes.new("Sweep")
    bm = bmesh.new()
    rad, depth, height, width = 0.25, 0.6, 0.8, 2.0
    prof = [(-depth, 0.0), (0.0, 0.0)]
    for i in range(1, 17):
        a = i / 16 * math.pi / 2
        prof.append((rad * math.sin(a), rad * (1 - math.cos(a))))
    prof.append((rad, height))
    ring = []
    for y, z in prof:
        ring.append((bm.verts.new((-width / 2, y + 0.18, z)),
                     bm.verts.new((width / 2, y + 0.18, z))))
    for (a0, a1), (b0, b1) in zip(ring, ring[1:]):
        bm.faces.new((a0, a1, b1, b0))
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new("Sweep", me)
    bpy.context.collection.objects.link(ob)
    # The wall stands on +Y; turn it to face the camera.
    ob.rotation_euler = (0, 0, facing_yaw + math.pi / 2)
    mat = principled("Backdrop", srgb(232, 232, 230), rough=0.9)
    me.materials.append(mat)
    return ob


def add_area(name, loc, target, size, power, color=(1, 1, 1)):
    d = bpy.data.lights.new(name, "AREA")
    d.shape = "DISK"
    d.size = size
    d.energy = power
    d.color = color
    ob = bpy.data.objects.new(name, d)
    bpy.context.collection.objects.link(ob)
    ob.location = loc
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    return ob


def setup_world():
    w = bpy.data.worlds.new("Studio")
    bpy.context.scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    hdr = os.path.join(os.path.dirname(bpy.app.binary_path),
                       "%d.%d" % bpy.app.version[:2],
                       "datafiles", "studiolights", "world", "studio.exr")
    if os.path.exists(hdr):
        env.image = bpy.data.images.load(hdr)
        nt.links.new(env.outputs["Color"], nt.nodes["Background"].inputs["Color"])
    nt.nodes["Background"].inputs["Strength"].default_value = 0.15


def setup_render(res, samples):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.max_bounces = 8
    sc.cycles.transparent_max_bounces = 8
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.film_transparent = False
    sc.view_settings.view_transform = "AgX"
    for look in ("AgX - Medium High Contrast", "AgX - Base Contrast", "None"):
        try:
            sc.view_settings.look = look
            break
        except TypeError:
            continue


def place_camera(objs, yaw_deg, pitch_deg, lens=85.0, margin=1.12, aspect=4 / 3):
    lo, hi = bounds(objs)
    centre = (lo + hi) / 2
    yaw, pitch = math.radians(yaw_deg), math.radians(pitch_deg)
    direction = Vector((math.cos(pitch) * math.cos(yaw),
                        math.cos(pitch) * math.sin(yaw),
                        math.sin(pitch)))
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = lens
    cam_data.sensor_width = 36.0
    cam_data.clip_start = 0.005
    cam_data.clip_end = 10.0
    cam = bpy.data.objects.new("Cam", cam_data)
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    # Fit: project the bounding box corners into the camera's view plane and
    # back the camera off until the widest of them fits the frame.
    rot = (-direction).to_track_quat("-Z", "Y")
    right = rot @ Vector((1, 0, 0))
    up = rot @ Vector((0, 1, 0))
    corners = [Vector((x, y, z)) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z)]
    half_w = max(abs((c - centre).dot(right)) for c in corners)
    half_h = max(abs((c - centre).dot(up)) for c in corners)
    depth = max(abs((c - centre).dot(direction)) for c in corners)
    tan_x = (cam_data.sensor_width / 2) / lens
    tan_y = tan_x / aspect
    dist = max(half_w / tan_x, half_h / tan_y) * margin + depth
    cam.location = centre + direction * dist
    cam.rotation_euler = rot.to_euler()
    return cam, centre, dist


def light_rig(centre, yaw_deg):
    """Key, fill and rim, placed relative to the camera so every shot is lit
    the same way: key high on the camera's left, fill low on its right, rim
    behind to put an edge on the dark plastic."""
    c = Vector(centre)

    def at(rel_yaw, pitch, dist):
        y, p = math.radians(yaw_deg + rel_yaw), math.radians(pitch)
        return c + Vector((math.cos(p) * math.cos(y), math.cos(p) * math.sin(y), math.sin(p))) * dist

    add_area("Key", at(40, 50, 0.45), c, 0.35, 3.0, (1.0, 0.97, 0.93))
    add_area("Fill", at(-60, 20, 0.5), c, 0.5, 1.0, (0.93, 0.96, 1.0))
    add_area("Rim", at(170, 35, 0.4), c, 0.25, 3.0)
    add_area("Top", c + Vector((0, 0, 0.5)), c, 0.6, 1.0)


# --------------------------------------------------------------------------
# Shots
# --------------------------------------------------------------------------

def lift(objs, names, dz):
    for o in objs:
        if o.name in names:
            o.matrix_world = Matrix.Translation((0, 0, dz)) @ o.matrix_world


def hide(objs, names):
    for o in objs:
        if o.name in names:
            o.hide_render = True


# yaw: angle of the camera around the model (0 = +X end with the button and
# wall tab, -90 = the front with the NTC probe). pitch: elevation.
SHOTS = {
    # Closed box, front three-quarter: probe face and button end.
    "closed":   dict(yaw=-45, pitch=22, setup=None),
    # Lid and gasket lifted to show the board inside.
    "exploded": dict(yaw=-50, pitch=28, setup=lambda o: (lift(o, {"Lid"}, 0.045),
                                                         lift(o, {"Gasket"}, 0.022)),
                     margin=1.08),
    # Lid off, looking down into the box at the board.
    "open":     dict(yaw=-70, pitch=55, setup=lambda o: hide(o, {"Lid", "Gasket"})),
    # The back: wall tab, keyhole and panel button on the +X end, seen past
    # the +Y side.
    "back":     dict(yaw=35, pitch=30, setup=None),
}


def render_shot(name, spec, glb, out, res, samples):
    objs = import_model(glb)
    apply_materials(objs)
    if spec["setup"]:
        spec["setup"](objs)
    visible = [o for o in objs if not o.hide_render]
    setup_render(res, samples)
    setup_world()
    cam, centre, dist = place_camera(visible, spec["yaw"], spec["pitch"],
                                     margin=spec.get("margin", 1.12),
                                     aspect=res[0] / res[1])
    add_backdrop(math.radians(spec["yaw"]))
    light_rig(centre, spec["yaw"])
    path = os.path.join(out, f"sensor-ntc-v2-{name}.png")
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f"RENDERED {path}")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opt = {"glb": os.path.join(HERE, "sensor-ntc-v2-toplid.glb"), "out": HERE,
           "shots": ",".join(SHOTS), "res": "1600x1200", "samples": "128"}
    for i in range(0, len(argv), 2):
        opt[argv[i].lstrip("-")] = argv[i + 1]
    res = tuple(int(v) for v in opt["res"].split("x"))
    for name in opt["shots"].split(","):
        render_shot(name, SHOTS[name], opt["glb"], opt["out"], res, int(opt["samples"]))


main()
