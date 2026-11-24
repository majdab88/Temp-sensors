#pragma once
#include <Arduino.h>

// Flash ring log. Every reading is written here before any upload is tried, so
// an outage that takes the router down with the mains loses nothing.
//
// 16-byte records in the 128 KiB "datalog" partition: 8192 readings, 28 days at
// a 5-minute interval. Records are uploaded oldest-first; marking one uploaded
// clears a single byte (0xFF -> 0x00), which flash allows without an erase.

#define LOG_TEMP_ERROR  INT16_MIN

#define LOGF_BATTERY   0x01   // taken while running on the cell
#define LOGF_CHARGING  0x02

struct __attribute__((packed)) LogRec {
  uint32_t seq;        // 0xFFFFFFFF = erased slot
  uint32_t ts;         // UTC epoch seconds; 0 = clock not set yet
  int16_t  tempC100;   // degC x 100, LOG_TEMP_ERROR = probe fault
  uint16_t batMv;
  uint8_t  batPct;     // 255 = read error
  int8_t   rssi;       // 0 = not connected at the time
  uint8_t  flags;
  uint8_t  state;      // 0xFF pending, 0x00 uploaded
};
static_assert(sizeof(LogRec) == 16, "log record must stay 16 bytes");

bool     logInit();
bool     logAppend(LogRec rec);              // assigns seq, state
uint32_t logPending();
// Copies up to max of the oldest pending records. Returns how many.
int      logPeek(LogRec* out, int max);
// Marks the oldest n pending records uploaded.
void     logMarkUploaded(int n);
