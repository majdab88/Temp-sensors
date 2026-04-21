# Schematics

Visual SVG schematics for each board in this project.

| File | Board |
|------|-------|
| `hub.svg` | Hub — XIAO ESP32-C6 (USB-powered receiver / dashboard) |
| `sensor-sht40.svg` | Sensor node with SHT40 temperature + humidity |
| `sensor-ntc.svg` | Sensor node with NTC probe + LS14500 battery + HT7333 regulator |

## Viewing

Open any `.svg` file directly in a web browser (Chrome / Firefox / Safari / Edge) — they render as vector graphics and scale cleanly at any zoom. You can also drop them into KiCad / Inkscape / Figma for further editing.

## Editing

These are hand-drawn SVGs (not exported from an EDA tool). They're intended as reference drawings, not as a source of truth for PCB fabrication. To produce Gerbers for manufacturing, recreate the schematic in **KiCad** using these as a guide.
