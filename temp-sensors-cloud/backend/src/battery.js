// Battery percentage from the pack voltage under load.
//
// Sensors (NTC from 1.1.16) report the lowest pack voltage seen with the radio
// on. That, not the resting voltage, is what tells how much a pair of L91
// lithium cells has left: their resting voltage stays high until they are
// nearly empty, and a worn pair rests at 1.5 V a cell while collapsing on every
// transmit. The buck-boost on the board draws constant power, so a sagging
// input pulls more current and sags further; the cold the node sits in adds to
// it.
//
// PROVISIONAL: shaped from the L91 discharge curve, not yet from this hardware.
// Correct it from the readings table (bat_load_mv against how long a pack
// lasted, and where nodes stopped) -- it is the one the dashboard uses, so a
// change here needs only a backend deploy. The sensor keeps a copy
// (sensor-ntc/src/main.cpp, batteryTable) for the hub's local page and for
// readings it stored while out of reach, which carry no voltage.
const TABLE = [
  [3300, 100], [3200, 90], [3100, 75], [3000, 55],
  [2900, 35],  [2800, 20], [2700, 12], [2600, 7],
  [2400, 3],   [2200, 0],
];

/** Percentage for a voltage under load in mV, or null when none was given. */
function batteryPctFromLoadMv(mv) {
  if (!Number.isFinite(mv) || mv <= 0) return null;
  if (mv >= TABLE[0][0]) return 100;
  for (let i = 0; i < TABLE.length - 1; i++) {
    const [vHi, pHi] = TABLE[i];
    const [vLo, pLo] = TABLE[i + 1];
    if (mv <= vHi && mv > vLo) return Math.floor(pLo + ((mv - vLo) / (vHi - vLo)) * (pHi - pLo));
  }
  return 0;
}

module.exports = { batteryPctFromLoadMv };
