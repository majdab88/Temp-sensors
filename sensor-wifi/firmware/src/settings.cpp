#include "settings.h"
#include "config.h"
#include <Preferences.h>

static Settings s_settings = {
  0, DEFAULT_INTERVAL_S, DEFAULT_SH_A, DEFAULT_SH_B, DEFAULT_SH_C, DEFAULT_R_SERIES
};

const Settings& settings() { return s_settings; }

void settingsLoad() {
  Preferences p;
  p.begin("cfg", true);
  // Absent on a fresh device, which is normal; reading an absent key logs an
  // error line that looks like a failure.
  if (p.isKey("blob") && p.getBytesLength("blob") == sizeof(Settings)) {
    Settings tmp;
    p.getBytes("blob", &tmp, sizeof(tmp));
    s_settings = tmp;
  }
  p.end();
  Serial.printf("[CFG] v%u interval=%us A=%.4e B=%.4e C=%.4e Rs=%.0f\n",
                s_settings.cfgVer, s_settings.intervalS, s_settings.shA,
                s_settings.shB, s_settings.shC, s_settings.rSeries);
}

// Bounds on what is physically impossible, not on what looks unusual: an
// earlier invented range rejected a legitimate negative B. The curve check is
// what actually decides.
const char* settingsApply(const Settings& n) {
  if (n.cfgVer == 0)                                        return "cfg_ver 0";
  if (n.intervalS < CFG_INTERVAL_MIN || n.intervalS > CFG_INTERVAL_MAX)
                                                            return "interval out of range";
  if (!isfinite(n.shA) || !isfinite(n.shB) || !isfinite(n.shC) ||
      fabsf(n.shA) > CFG_COEF_ABS_MAX || fabsf(n.shB) > CFG_COEF_ABS_MAX ||
      fabsf(n.shC) > CFG_COEF_ABS_MAX)                      return "coefficient magnitude";
  if (!isfinite(n.rSeries) || n.rSeries < CFG_RSERIES_MIN || n.rSeries > CFG_RSERIES_MAX)
                                                            return "r_series out of range";
  if (!shCoefficientsSane(n.shA, n.shB, n.shC))             return "coefficients do not form an NTC curve";

  s_settings = n;
  Preferences p;
  p.begin("cfg", false);
  p.putBytes("blob", &s_settings, sizeof(s_settings));
  p.end();
  Serial.printf("[CFG] Applied v%u\n", n.cfgVer);
  return nullptr;
}
