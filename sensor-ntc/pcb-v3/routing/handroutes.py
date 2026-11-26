# Hand-routed copper: what an autorouter would get wrong. Locked, so Freerouting
# treats it as fixed.
# T(net, layer, width, [points]) is a polyline; V(net, x, y, size, drill) a via.

T, V = [], []
def t(net, layer, w, *pts): T.append((net, layer, w, pts))
def v(net, x, y, size=0.6, drill=0.3): V.append((net, x, y, size, drill))

F, B = 'F.Cu', 'B.Cu'

# ── TPS63802 cluster: v2's copper, copied segment for segment ────────────────
# Same parts at the same positions as v2 (NTC_SENSOR), so the switching loops
# keep the geometry that survived the TX burst on cold cells.
# Cell + : BT1 -> C1 -> C_buf1 -> C_in1 -> U2 VIN/EN, and the battery divider top.
t('/V_BAT', F, 0.5, (81.5, 139.0), (80.5, 139.0), (79.0, 137.5), (79.0, 131.0))
t('/V_BAT', F, 0.5, (79.0, 131.0), (79.0, 130.0), (79.05, 129.95), (79.05, 125.0))
t('/V_BAT', F, 0.5, (79.05, 125.0), (81.05, 123.0), (86.0, 123.0))
t('/V_BAT', F, 0.5, (86.0, 123.0), (86.075, 122.925), (89.5, 122.925))
t('/V_BAT', F, 0.5, (79.0, 131.0), (80.5, 129.5), (86.0, 129.5))
# U2 grounds (pins 2, 3, 8) and C_in1's ground, joined under the part.
t('/GND', F, 0.2, (89.3, 124.0), (87.0, 124.0), (86.9, 124.0), (86.0, 124.9))
t('/GND', F, 0.2, (87.85, 123.5), (87.85, 124.0))
# Feedback divider.
t('/FB', F, 0.2, (87.85, 124.5), (87.529, 124.5), (87.25, 124.779), (87.25, 125.9), (87.85, 126.5))
t('/FB', F, 0.2, (87.85, 126.5), (87.85, 128.0))
# VOUT -> R1 -> C_out1.
t('/+3V3', F, 0.5, (89.5, 125.075), (89.5, 126.5), (91.5, 126.5))
# Inductor.
t('/SW_L1', F, 0.4, (92.5, 121.5), (91.7, 121.5), (90.35, 122.85), (90.35, 123.263), (90.113, 123.5))
t('/SW_L2', F, 0.4, (92.5, 123.5), (91.5, 124.5), (90.113, 124.5))
# Ground vias around the cluster, as v2.
for x, y in [(84.0, 125.0), (84.0, 126.5), (86.0, 126.5), (86.0, 127.5),
             (86.0, 121.5), (89.0, 121.5), (95.0, 123.5), (91.5, 128.5)]:
    v('/GND', x, y)

# ── Module centre GND array (U1 pad 49 at 90, 99.5) ──────────────────────────
# Walled in by the pad ring, so the front pour cannot reach it: tie it to the
# back pour through the pad, as sensor-wifi does.
for dx, dy in [(0, 0), (-1.98, -1.98), (1.98, -1.98), (-1.98, 1.98), (1.98, 1.98)]:
    v('/GND', 90.0 + dx, 99.5 + dy)

# ── 3V3 trunk: regulator -> module ───────────────────────────────────────────
# Freerouting left the regulator's output joined to nothing on the first run
# (it does not reliably connect wide power nets). Out of the cluster the way v2
# went, down to B.Cu, up the channel between SW2 and SW1, under the module's
# bottom edge, and up beside the module to C_vdd_bulk1 and U1 pin 3.
t('/+3V3', F, 0.5, (91.5, 126.5), (93.3, 128.3), (95.6, 128.3))
v('/+3V3', 95.6, 128.3)
t('/+3V3', B, 0.5, (95.6, 128.3), (97.6, 126.3), (97.6, 106.3), (83.1, 106.3), (83.1, 97.25))
v('/+3V3', 83.1, 97.25)
t('/+3V3', F, 0.4, (79.6, 97.25), (81.8, 97.25), (83.1, 97.25), (84.1, 97.1))

# ── GND pads the pours cannot reach ──────────────────────────────────────────
# U1 pads 11 and 14 sit between signal pads: join them to the centre array
# under the module.
t('/GND', F, 0.3, (84.1, 103.5), (85.0, 103.5), (87.0, 101.5), (88.02, 101.48))
t('/GND', F, 0.3, (86.8, 104.4), (86.8, 103.2), (88.02, 101.48))
# U1 corner pad 51: out to its own via.
t('/GND', F, 0.3, (95.95, 104.45), (96.9, 105.4))
v('/GND', 96.9, 105.4)
# D1 cathode: own via (tracks fence it off from the pour).
t('/GND', F, 0.3, (99.0, 96.388), (100.5, 96.4))
v('/GND', 100.5, 96.4)
# R2 (feedback divider bottom): a solid tie to the cluster's GND via instead of
# a single thermal spoke.
t('/GND', F, 0.3, (89.495, 128.0), (91.5, 128.5))
# The UART lines, J_PROG and the 3V3 trunk fence off a pocket of B.Cu left of
# and below the module; island removal empties it, so these front-side grounds
# cannot be stitched there. Tie them to grounded neighbours instead.
t('/GND', F, 0.3, (79.6, 99.95), (78.3, 99.95), (78.3, 95.35), (79.6, 95.35))   # C_en1 -> C_vdd_hf1
t('/GND', F, 0.25, (87.6, 106.85), (87.6, 105.6), (86.8, 104.8), (86.8, 104.4))  # C_d0 -> U1 pad 14
t('/GND', F, 0.3, (87.6, 106.85), (89.8, 106.85))                                # Cfn1 -> C_d0

# ── Rest of 3V3, by hand: Freerouting drops one branch or another per run ────
# Pull-ups R_gpio0 / R_boot1 / R_gpio8 on one rail under them, onto the trunk.
t('/+3V3', F, 0.4, (85.6, 108.62), (85.6, 110.0), (97.6, 110.0))
t('/+3V3', F, 0.4, (93.4, 108.62), (93.4, 110.0))
t('/+3V3', F, 0.4, (95.4, 108.62), (95.4, 110.0))
v('/+3V3', 97.6, 110.0)
# NTC high side (TH1 pin 1).
t('/+3V3', B, 0.4, (97.6, 106.3), (100.8, 106.3), (103.5, 103.6))
# J_PROG pin 2.
t('/+3V3', B, 0.5, (83.1, 106.3), (83.1, 109.62), (81.0, 111.72))
# EN pull-up R_en1.
v('/+3V3', 83.1, 101.7)
t('/+3V3', F, 0.3, (83.1, 101.7), (81.8, 101.7))
# Panel button LED+ (J_BTN pin 1), up the left of the module on B.Cu.
t('/+3V3', B, 0.5, (83.1, 97.25), (83.1, 90.1), (85.0, 88.2))
# U1 corner pad 50: own via (the top-row fan-out leaves it one spoke).
t('/GND', F, 0.3, (95.95, 94.55), (96.9, 93.6))
v('/GND', 96.9, 93.6)
