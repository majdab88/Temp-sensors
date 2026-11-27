#pragma once
#include <Arduino.h>
#include "measure.h"

// WiFi, NTP and MQTT. The device speaks the hub's topic contract under its own
// MAC, with itself as the only sensor: sensors/<MAC>/data carries
// sensor_mac = <MAC>.

bool   cloudLoadCredentials();          // false = not provisioned
bool   wifiConnect(uint32_t timeoutMs);
void   wifiMaintain();                  // mains: reconnect, rate-limited
bool   wifiUp();
int8_t wifiRssi();

void   ntpStart();                      // non-blocking
bool   ntpWait(uint32_t timeoutMs);     // true once synced
bool   timeValid();
void   ntpMaintain();                   // mains: periodic re-sync

bool   cloudConnect(const Reading& r);  // connect, subscribe, publish status
bool   cloudConnected();
void   cloudLoop();
void   cloudMaintain(const Reading& last);   // mains: reconnect, rate-limited
void   cloudPublishStatus(const Reading& r, bool online, uint16_t nextS);
void   cloudPublishOtaStatus(const char* state, const char* ver, int pct, const char* err);
void   cloudDisconnect();
int    cloudLastState();                // PubSubClient state of the last attempt

// Upload pending log records oldest-first, each batch proven delivered by an
// MQTT round trip before it is marked. Returns records delivered, or -1 if the
// connection failed before everything was sent.
int    cloudDrainLog();

// Live mode (temporarily shorter interval). Survives deep sleep.
uint16_t effectiveIntervalS();
