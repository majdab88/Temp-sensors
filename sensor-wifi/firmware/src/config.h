#pragma once
// sensor-wifi — pins, constants and defaults. See ../../DESIGN.md.

#include <Arduino.h>

// --- FIRMWARE VERSION ---
// Wrapped in #ifndef so a build env can override (the rollbacktest env does).
#ifndef FW_MAJOR
#define FW_MAJOR 1
#endif
#ifndef FW_MINOR
#define FW_MINOR 0
#endif
#ifndef FW_PATCH
#define FW_PATCH 0
#endif
#define STR_(x) #x
#define STR(x)  STR_(x)
#define FW_VERSION STR(FW_MAJOR) "." STR(FW_MINOR) "." STR(FW_PATCH)

// Greppable marker. The registry uses it to check an uploaded image's kind and
// version; ota.cpp refuses any downloaded image that lacks it, which is what
// stops a hub image (same signing key) being installed on this board.
#define FW_TAG_PREFIX  "TEMPWIFI_FW="
#define FW_VERSION_TAG FW_TAG_PREFIX FW_VERSION

// Reported in the status payload so the cloud can tell this from a hub.
#define DEVICE_KIND "wifi"

// --- PINS (ESP32-C6-WROOM-1U, u.FL antenna; no RF switch to drive) ---
// GPIO0/1 carry the 32.768 kHz crystal and must not be touched.
#define BAT_ADC_PIN         2   // ADC1_CH2, 100k/100k divider from the cell
#define NTC_ADC_PIN         3   // ADC1_CH3, R_series/NTC midpoint
#define CHG_PIN             4   // BQ24074 /CHG, open drain, LOW = charging
#define LED_PIN             5
#define BUTTON_PIN          6   // active low, LP GPIO (deep-sleep wake)
#define PGOOD_PIN           7   // BQ24074 /PGOOD, LOW = USB power present; LP GPIO
#define BAT_DIV_EN_PIN     21   // LOW enables the battery divider, Hi-Z otherwise
#define NTC_EN_PIN         22   // LOW enables the NTC divider, Hi-Z otherwise

// --- NTC ---
// High side, as the original v1 design: 3V3 -> NTC -> ADC -> R_series -> enable.
//   R_ntc = r_series * (VCC - V) / V
// sensor-ntc v2 is the other way round. Using the wrong formula is invisible in
// review and obvious in the field: it read a +4 C probe as +41 C.
// A cold probe's high resistance keeps the ADC low, in its accurate region:
// -18 C ~0.36 V, +4 C ~0.90 V, +25 C ~1.65 V with 10k.
#define NTC_VCC            3.3f     // TPS63802 output, independent of the cell
#define NTC_SAMPLES        20
#define DEFAULT_R_SERIES   10000.0f
// Steinhart-Hart defaults: the deployed sensor-ntc cold-range fit. Expected to
// be replaced per device from the dashboard.
#define DEFAULT_SH_A       2.535e-3f
#define DEFAULT_SH_B       3.01e-5f
#define DEFAULT_SH_C       7.23e-7f

// --- REPORTING ---
#define DEFAULT_INTERVAL_S 300
// Same bounds the cloud enforces for sensors (sensor-config.js). The ceiling is
// a self-rescue limit on battery: commands only land while connected.
#define CFG_INTERVAL_MIN   300
#define CFG_INTERVAL_MAX   3600
#define CFG_COEF_ABS_MAX   1e-1f
#define CFG_RSERIES_MIN    1000.0f
#define CFG_RSERIES_MAX    1000000.0f

// Live mode: a temporarily shorter interval, as on sensor-ntc.
#define LIVE_MIN_INTERVAL_S 20
#define LIVE_MAX_DURATION_S 300

// --- BATTERY (1S Li-ion) ---
#define BAT_DIVIDER_RATIO     2.0f
#define BAT_MIN_WIFI_V        3.45f  // below: log only, no WiFi attempts
#define BAT_HIBERNATE_V       3.30f  // below: sleep until USB returns or button
#define BAT_ERROR_V           2.50f  // below: the divider is not reading a cell

// --- POWER SOURCE ---
// /PGOOD must stay high this long before mains mode gives up, so a connector
// wiggle does not start a battery cycle.
#define PGOOD_DEBOUNCE_MS     500

// --- BATTERY-MODE UPLOAD BACK-OFF ---
// After a failed upload, wait this many wakes before the next attempt, doubling
// up to the cap. Logging continues every wake regardless.
#define BACKOFF_MAX_WAKES     6      // 6 x 5 min = 30 min

// --- NETWORK ---
#define WIFI_CONNECT_TIMEOUT_MS   30000   // provisioning, generous
#define WIFI_WAKE_TIMEOUT_MS      8000    // battery wake, cached channel/BSSID
#define MQTT_RECONNECT_MS         5000
#define WIFI_RECONNECT_MS         30000
#define NTP_RESYNC_MS             (6UL * 3600UL * 1000UL)
#define NTP_WAIT_MS               3000
#define ECHO_TIMEOUT_MS           4000
#define UPLOAD_BATCH              20      // records per barrier
// How long a battery wake listens after subscribing, so retained commands
// (config, OTA) are received before it disconnects.
#define RETAINED_WAIT_MS          600

// The clock runs on UTC; nothing on the device needs local time.
#define NTP_SERVER   "pool.ntp.org"

// --- BUTTON ---
#define RESET_HOLD_MS 3000

// --- BLE GATT UUIDs — identical to the hub, so the app and ble-provision.html
// work unchanged. ---
#define PROV_SERVICE_UUID  "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define PROV_CHAR_WIFI     "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define PROV_CHAR_CLOUD    "1c95d5e3-d8f7-413a-bf3d-7a2e5d7be87e"
#define PROV_CHAR_STATUS   "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
#define PROV_CHAR_NETWORKS "d5913036-2d8a-41ee-85b9-4e361aa5c8a3"
#define PROV_CHAR_INFO     "a9b12301-bc5d-4e8a-9c23-c5d1b3f4a5e6"

// --- OTA ---
#define OTA_MAX_BOOT_TRIES    3
#define OTA_VERIFY_WINDOW_MS  300000UL
#define OTA_HTTP_TIMEOUT_MS   20000
#define OTA_BUF_SIZE          1024

// Own MAC as "AA:BB:CC:DD:EE:FF"; set once in setup().
extern char g_macStr[18];
