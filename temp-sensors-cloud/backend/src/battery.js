// Battery percentage from the pack voltages, by chemistry.
//
// Sensors (NTC from 1.1.16) report two pack voltages: at rest (bat_mv) and
// the lowest seen with the radio on (bat_load_mv). Which one tells how much is
// left depends on what is in the holder, so the type is set per sensor
// (sensors.battery_type) and picks the table here. The tables live in the
// cloud so they can be corrected with a backend deploy alone.
//
// lithium -- 2x L91 (Li-FeS2). The resting voltage stays high until the pack
//   is nearly empty, and a worn pair rests at 1.5 V a cell while collapsing on
//   every transmit. The buck-boost on the board draws constant power, so a
//   sagging input pulls more current and sags further; the cold the node sits
//   in adds to it. Only the voltage under load shows it.
//
// alkaline -- 2x AA alkaline. The resting voltage falls steadily over the
//   whole discharge, so it is a fair gauge on its own. The voltage under load
//   is not: alkaline sags far more on a transmit than lithium does even when
//   full, and read through the lithium table a fresh pack showed 6 %.
//
// PROVISIONAL, both: shaped from the datasheet curves, not yet from this
// hardware. Correct them from the readings table (the voltages against how
// long a pack lasted, and where nodes stopped). The sensor keeps a copy of the
// lithium table (sensor-ntc/src/main.cpp, batteryTable) for the hub's local
// page and for readings with no voltages.
const TABLES = {
  lithium: {
    field: 'loadMv',
    rows: [
      [3300, 100], [3200, 90], [3100, 75], [3000, 55],
      [2900, 35],  [2800, 20], [2700, 12], [2600, 7],
      [2400, 3],   [2200, 0],
    ],
  },
  alkaline: {
    field: 'restMv',
    rows: [
      [3150, 100], [2900, 85], [2700, 65], [2500, 45],
      [2350, 25],  [2250, 15], [2150, 7],  [2050, 2],
      [2000, 0],
    ],
  },
};

const BATTERY_TYPES = Object.keys(TABLES);
const DEFAULT_BATTERY_TYPE = 'lithium';

function interpolate(rows, mv) {
  if (mv >= rows[0][0]) return 100;
  for (let i = 0; i < rows.length - 1; i++) {
    const [vHi, pHi] = rows[i];
    const [vLo, pLo] = rows[i + 1];
    if (mv <= vHi && mv > vLo) return Math.floor(pLo + ((mv - vLo) / (vHi - vLo)) * (pHi - pLo));
  }
  return 0;
}

/**
 * Percentage for a pack of `type` from its voltages in mV, or null when the
 * voltage that type is judged by was not reported (sensors before 1.1.16).
 */
function batteryPct(type, { restMv, loadMv }) {
  const t = TABLES[type] || TABLES[DEFAULT_BATTERY_TYPE];
  const mv = t.field === 'restMv' ? restMv : loadMv;
  if (!Number.isFinite(mv) || mv <= 0) return null;
  return interpolate(t.rows, mv);
}

module.exports = { batteryPct, BATTERY_TYPES, DEFAULT_BATTERY_TYPE };
