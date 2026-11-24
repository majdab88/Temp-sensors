#pragma once
#include <Arduino.h>

#define TEMP_ERROR -999.0f   // probe open, shorted or out of range

struct Reading {
  float    temp;       // degC, or TEMP_ERROR
  float    batV;       // cell voltage; < BAT_ERROR_V means unreadable
  uint8_t  batPct;     // 0-100, 255 = read error
  bool     onMains;
  bool     charging;
};

void   measureInitPins();
bool   mainsPresent();       // /PGOOD low
bool   isCharging();         // /CHG low
float  readNtc();            // uses the calibration in settings
float  readBatteryV();
uint8_t batteryPct(float v);
Reading takeReading();
