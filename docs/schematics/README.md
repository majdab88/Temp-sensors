# Schematics

Visual SVG schematics for each board in this project.

| File | Board |
|------|-------|
| `hub.svg` | Hub — XIAO ESP32-C6 (USB-powered receiver / dashboard) |
| `sensor-sht40.svg` | Sensor node with SHT40 temperature + humidity |
| `sensor-ntc.svg` | Sensor node v1 — XIAO ESP32-C6 carrier + HT7333 LDO (legacy revision) |
| `sensor-ntc-v2.svg` | Sensor node v2 — bare ESP32-C6-WROOM-1U + TPS63802 buck-boost + ESP-PROG header (current) |

## v1 vs v2 (sensor-ntc)

The v2 design replaces the XIAO ESP32-C6 carrier with a discrete WROOM-1U module on a custom PCB.
Key differences:

- **No USB-C connector.** Saves cost, board area, and a moisture ingress point. Flashed via an external
  Espressif **ESP-PROG** programmer plugged into a 2×3 IDC header.
- **Discrete TPS63802 buck-boost** (V_in 1.3–5.5 V → 3.3 V, ~11 µA Iq in PFM) replaces the HT7333 LDO.
  Unlocks the full L91 / TL-4903 discharge curve instead of browning out at the LDO dropout voltage.
- **Cell-side buffer cap** (1000 µF electrolytic + 22 µF ceramic) acts as an HLC substitute, holding
  the cell voltage steady during ESP-NOW TX bursts.
- **u.FL external antenna** wired directly to the WROOM-1U RF pin (no GPIO14 RF switch).
- **Status LED moved from GPIO15 → GPIO5** to avoid the C6's log-print strap pin.

Firmware change is minimal: delete the XIAO-specific GPIO3/14 antenna-switch block and bump `LED_PIN`
from 15 to 5. Everything else (ESP-NOW, sleep handling, NTC + battery monitoring) ports as-is.

## Viewing

Open any `.svg` file directly in a web browser (Chrome / Firefox / Safari / Edge) — they render as vector graphics and scale cleanly at any zoom. You can also drop them into KiCad / Inkscape / Figma for further editing.

## Editing

These are hand-drawn SVGs (not exported from an EDA tool). They're intended as reference drawings, not as a source of truth for PCB fabrication. To produce Gerbers for manufacturing, recreate the schematic in **KiCad** using these as a guide.
