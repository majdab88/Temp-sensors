#pragma once
#include <Arduino.h>

// What the cloud configures: interval and calibration. Same fields and meaning
// as a sensor-ntc config, so the dashboard's sensor config panel drives it.
struct Settings {
  uint16_t cfgVer;      // fingerprint from the cloud; 0 = compiled defaults
  uint16_t intervalS;
  float    shA, shB, shC;
  float    rSeries;
};

void            settingsLoad();
const Settings& settings();

// Validates and, if acceptable, persists and applies. Returns nullptr on
// success, otherwise the reason (for the log and config/state).
const char*     settingsApply(const Settings& s);

bool shCoefficientsSane(float a, float b, float c);   // measure.cpp
