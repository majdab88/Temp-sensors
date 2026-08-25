#include <Arduino.h>

#include <esp_now.h>
#include <WiFi.h>
#include <Preferences.h>
#include <esp_wifi.h>
#include <esp_sleep.h>   // Explicit include needed on C6
#include <esp_ota_ops.h>   // OTA partition write + rollback state
#include <mbedtls/md.h>      // SHA-256 over the received image
#include <mbedtls/pk.h>      // ECDSA P-256 signature verification

// --- BOARD REVISION ---
// Set by platformio.ini build_flags. Controls hardware-specific bits like
// LED pin assignment and the XIAO antenna-switch code in setup().
//   1 = XIAO ESP32-C6 carrier
//   2 = bare WROOM-1U PCB
#ifndef BOARD_REV
#define BOARD_REV 1
#endif

// --- POWER TOPOLOGY ---
// Independent of BOARD_REV — describes whether an external 3.3 V regulator
// (e.g., TPS63802 buck-boost) sits between battery and the C6's 3V3 pin.
//   0 = battery is wired directly to the 3V3 pin (VCC = bat_v, swings with cell)
//   1 = regulated 3.3 V (VCC is constant regardless of cell voltage)
//
// Three valid combinations:
//   BOARD_REV=1, HAS_REGULATOR=0  → XIAO direct-from-battery (original setup)
//   BOARD_REV=1, HAS_REGULATOR=1  → XIAO + external TPS63802 module (hybrid)
//   BOARD_REV=2, HAS_REGULATOR=1  → custom WROOM PCB with onboard TPS63802
//
// If not set by build_flags, default depends on BOARD_REV: v1 assumes no
// regulator (legacy default), v2 always has the regulator on-PCB.
#ifndef HAS_REGULATOR
#if BOARD_REV == 2
#define HAS_REGULATOR 1
#else
#define HAS_REGULATOR 0
#endif
#endif

// --- PIN DEFINITIONS ---
#if BOARD_REV == 2
#define LED_PIN             5   // v2 PCB: GPIO5 (moved off GPIO15 which is a strap pin)
#else
#define LED_PIN            15   // v1 XIAO: built-in LED on GPIO15
#endif
#define RESET_PIN           0   // External reset button on D0 (GPIO0 — LP GPIO, supports deep sleep wakeup)
#define BAT_ADC_PIN         2   // GPIO2 — ADC input (battery resistor divider midpoint)
#define DIVIDER_ENABLE_PIN 21   // GPIO21 — battery divider GND switch; LOW enables divider, INPUT (Hi-Z) during sleep
#define NTC_PIN             1   // GPIO1 — ADC input for NTC voltage divider midpoint
#define NTC_ENABLE_PIN     22   // GPIO22 — NTC divider GND switch; LOW enables divider, INPUT (Hi-Z) during sleep

// --- NTC PROBE PARAMETERS ---
#define SERIES_RESISTOR 10000   // Accurate 10kΩ resistor (measured ≈ nominal)

// Which leg of the divider the NTC sits on. The v2 WROOM PCB wires this the
// opposite way round to the v1/XIAO design the firmware originally assumed:
//
//   v1/XIAO:  3V3 -> NTC -> ADC tap -> R_series -> GND switch   (NTC high side)
//   v2 WROOM: 3V3 -> R_series -> ADC tap -> NTC -> GND switch   (NTC low side)
//
// Getting this wrong inverts the computed resistance. The error is small where
// R_ntc is near R_series -- about 2 C at room temperature, easy to miss -- and
// grows sharply away from it: a probe at +4 C (26.8 kOhm) was being reported as
// +41 C. The "ADC nonlinearity" previously blamed for over-reading in the cold
// was this.
#ifndef NTC_ON_LOW_SIDE
#if BOARD_REV == 2
#define NTC_ON_LOW_SIDE 1
#else
#define NTC_ON_LOW_SIDE 0
#endif
#endif
#define NTC_SAMPLES        20   // ADC readings to average for stable result

// Full Steinhart-Hart equation: 1/T(K) = A + B·ln(R) + C·(ln(R))³
// Default coefficients are derived from the simplified beta equation (B=3950, R0=10kΩ, T0=25°C).
// Replace with probe-measured values for best accuracy.
//
// To calibrate with 3 points:
//   1. Stabilize probe at 3 reference temperatures (cold / mid / warm).
//      The serial log already prints R_ntc — record that and the true °C at each point.
//   2. Compute A, B, C (T in Kelvin = °C + 273.15):
//        L1=ln(R1), L2=ln(R2), L3=ln(R3)
//        Y1=1/(T1+273.15), Y2=1/(T2+273.15), Y3=1/(T3+273.15)
//        g21=(Y2-Y1)/(L2-L1),  g31=(Y3-Y1)/(L3-L1)
//        C = (g21-g31) / ((L2-L3)*(L1+L2+L3))
//        B = g21 - C*(L2²+L1·L2+L1²)
//        A = Y1 - L1*(B + C·L1²)
//      Or paste the 3 (°C, Ω) pairs into any online Steinhart-Hart calculator.
#define NTC_SH_A  2.535e-3f    // Steinhart-Hart A (K⁻¹) — cold-range fit (deployment range only):
#define NTC_SH_B  3.01e-5f     // Steinhart-Hart B (K⁻¹) — (-18.2°C/81911Ω, -7.2°C/47214Ω, +4°C/26811Ω)
#define NTC_SH_C  7.23e-7f     // Steinhart-Hart C (K⁻¹) — SHT40 reference, cold-board operation
                               // All 3 anchors inside fridge/freezer range → tight interpolation in deployment


// PCB circuit (for reference):
//   3.3V ─── SERIES_RESISTOR ─── NTC_PIN (ADC) ─── NTC probe ─── NTC_ENABLE_PIN (GND switch)
//                                  │
//                                  └── 100 nF filter cap (Cfn) ── GND
// NTC_ENABLE_PIN driven LOW to enable divider; INPUT (Hi-Z) during sleep to cut quiescent current.
// Cfn low-pass filters the ADC input (RC ≈ 0.5 ms with ~5 kΩ source impedance).
// The existing 10 ms settling delay after enabling the divider covers the filter-cap charge-up.

// --- FIRMWARE VERSION ---
// Sent to the hub in every data frame and forwarded to the cloud. Bump on every
// release; the cloud uses it to tell which nodes still need updating.
#define FW_MAJOR 1
#define FW_MINOR 1
#define FW_PATCH 6
#define STR_(x) #x
#define STR(x)  STR_(x)

// Greppable marker so the registry can check an uploaded image really is sensor
// firmware of the version it is being labelled with. Deliberately distinct from
// the hub marker: sending a hub image to a sensor would give it the wrong pins
// and no sleep, and on a v2 board that needs an ESP-PROG to undo.
// Printed at boot so the linker cannot discard it.
#define FW_VERSION_TAG "TEMPSENS_FW=" STR(FW_MAJOR) "." STR(FW_MINOR) "." STR(FW_PATCH)

// --- SLEEP SETTINGS ---
#define SLEEP_TIME 900  // Seconds — compiled default, overridden by cloud config

// --- REMOTE CONFIG LIMITS ---
// Clamped here, on the device, not only in the cloud. The cloud-side check is
// UX; this one survives a backend bug, a bad migration or a malformed frame.
//
// The sleep ceiling is a self-rescue constraint rather than a preference: a
// config change can only land while the sensor is awake, so a 24 h interval
// would put every correction 24 h away. One hour keeps recovery bounded.
#define CFG_SLEEP_MIN     300
#define CFG_SLEEP_MAX     3600
// Steinhart-Hart coefficients are not clamped to narrow numeric windows. The
// deployed fit is a restricted cold-range one (A=2.535e-3, B=3.01e-5,
// C=7.23e-7) and looks nothing like textbook values, so any tight bound would
// reject a legitimate recalibration. Only absurd magnitudes are refused; the
// real check is the physical plausibility test below.
// Magnitude only, and generous. Sign conventions from textbook fits do not
// hold for restricted-range ones: the coefficients trade off against each
// other, and a perfectly good cold-range fit can have a negative B compensated
// by a larger C. A real fit measured on this hardware --
// A=5.678e-3, B=-4.038e-4, C=1.919e-6 -- was rejected by a positive-only bound.
//
// These limits only catch garbage. The physical check below is what actually
// decides whether a set of coefficients is usable.
#define CFG_COEF_ABS_MAX 1e-1f
// The divider resistor is a design choice, not a fixed 10k. Raising it moves
// the whole voltage range down, which is how a low-side board buys back cold
// headroom before the ADC saturates -- so the bound has to be wide enough to
// allow that. Anything from a few k to ~1M is physically reasonable; past that,
// ADC input leakage starts to matter more than the divider.
//
// A wrong value here scales computed resistance linearly, and the existing
// -55..125 C check at read time rejects the result of a serious typo.
#define CFG_RSERIES_MIN 1000.0f
#define CFG_RSERIES_MAX 1000000.0f

// How long to keep the radio up after the log burst, waiting for a config the
// hub may be sending. Costs roughly 30 mAh/year at a 15 min interval (~1% of
// the pack); returns early the moment a config arrives.
#define CFG_WAIT_MS 60

// --- RETRY SETTINGS ---
#define MAX_RETRIES    5
#define RETRY_DELAY_MS 100
#define TX_TIMEOUT_MS  500

// --- FAILURE HANDLING / HIBERNATE MODE ---
// If TX fails N consecutive wake cycles in a row, the sensor enters "hibernate
// mode" — the timer wake is disabled and the device sleeps until the user
// presses the D0 button. This protects battery life when the hub is offline
// or unreachable for extended periods.
//
// Rationale: each failed wake cycle spends ~7-10 seconds at high current
// (retries + optional rescan). Compared to a normal ~500 ms successful cycle,
// that's ~15× the energy per wake. Without this policy, a 24 h hub outage
// would drain ~15 mAh instead of ~1 mAh — nearly half a percent of pack
// capacity for one outage.
//
// The user manually re-enters normal operation once connectivity is restored
// by pressing the D0 button (short press). The LED blinks 3× to confirm.
#define MAX_FAILED_WAKES_BEFORE_HIBERNATE 4  // 4 × 15 min ≈ 1 h of outage tolerated
#define RESCAN_ON_FAILURE_AT_COUNT       2   // Try one channel rescan at this failure count
                                             // (hub may have moved to a different channel)

// RTC_DATA_ATTR variables persist across deep sleep. Reset on power-on and
// (usually) on brownout — both events look like a fresh start where TX
// should be attempted again, so that's the correct behavior.
RTC_DATA_ATTR uint32_t consecutive_failed_wakes = 0;
RTC_DATA_ATTR bool     in_hibernate_mode        = false;

// --- COMMUNICATION CHANNEL ---
#define ESPNOW_CHANNEL 0          // 0 = auto-detect
#define HUB_AP_SSID   "TempHub-AP"  // hub's hidden AP — always on the ESP-NOW channel
#define FALLBACK_CHANNEL 1        // used when neither hub AP nor any router is visible

// --- REMOTE LOG (over ESP-NOW to hub) ---
// Sensor sends its log buffer to the hub via the existing encrypted ESP-NOW peer.
// The hub stores the latest log per sensor and exposes it at http://<hub>/logs.
// Costs ~50 ms per wake — orders of magnitude cheaper than connecting to a WiFi AP.
#define LOG_BUF_SIZE     1024
#define LOG_CHUNK_DATA    240   // bytes of log payload per ESP-NOW packet (max 250)

// --- BATTERY MONITOR ---
#define ADC_SAMPLES      20  // Readings to average for a stable result

// ---------------------------------------------------------------------------
// NTC VCC reference — chosen based on power topology (HAS_REGULATOR)
// ---------------------------------------------------------------------------
// The NTC voltage divider is fed from the chip's 3V3 rail. Whether that rail
// matches the battery or is regulated depends on whether an external 3.3 V
// regulator is in the design (controlled by HAS_REGULATOR, set above):
//
//   HAS_REGULATOR == 0  (battery direct to 3V3 pin):
//     VCC = bat_v (tracks the battery voltage). The S-H calibration was done
//     under this assumption, so the coefficients absorb whatever bat_v sat at
//     during calibration. Used by the original XIAO setup.
//
//   HAS_REGULATOR == 1  (TPS63802 buck-boost between battery and 3V3):
//     VCC = 3.3 V (constant, regulated). The TPS63802 holds 3.3 V across
//     V_in 1.3–5.5 V, so the 3V3 rail is independent of battery voltage.
//     Using bat_v here would introduce a growing error as the cell drains
//     (firmware would think VCC is dropping when it actually isn't).
//
// LDO_DROPOUT_V is a leftover from the original v1 HT7333 era — kept at 0 V
// because no LDO sits between battery and VCC on any current configuration.
//
// NOTE: switching HAS_REGULATOR from 0 → 1 shifts the computed R_ntc by the
// ratio (bat_v_at_calibration / 3.3 V), typically a few percent. This causes
// a corresponding few-degree offset in the readings until you recalibrate
// the S-H coefficients at the new (constant) VCC = 3.3 V operating point.
// ---------------------------------------------------------------------------
#if HAS_REGULATOR
#define NTC_VCC_REGULATED  1     // External regulator provides fixed 3.3 V to NTC divider
#define NTC_VCC_FIXED      3.3f  // Use this instead of bat_v in readNTC()
#else
#define NTC_VCC_REGULATED  0     // No regulator: VCC tracks battery
#endif

#define LDO_DROPOUT_V  0.0f
#define LOW_BATTERY_PCT  15  // "LOW" status below this %
#define CRITICAL_PCT      5  // Sleep immediately below this % to protect the cell

// --- MESSAGE TYPES ---
#define MSG_PAIRING 1
#define MSG_DATA    2
#define MSG_LOG     3
#define MSG_CONFIG  4   // Hub -> sensor: new configuration

// --- SENSOR OTA (hub -> sensor firmware update) ---
// Frames are sized by the hub, which knows whether ESP-NOW v2 (1470 B) is
// available; the sensor handles whatever length arrives. The offer itself is
// kept under the v1 250-byte limit because it is the first contact, before
// either side knows what the other supports.
#define MSG_OTA_OFFER 5   // hub -> sensor: here is an image
#define MSG_OTA_REQ   6   // sensor -> hub: accept or decline
#define MSG_OTA_DATA  7   // hub -> sensor: one chunk
#define MSG_OTA_ACK   8   // sensor -> hub: next sequence expected
#define MSG_OTA_DONE  9   // sensor -> hub: final result

#define OTA_MAX_CHUNK      1024   // largest payload the sensor will accept
#define OTA_DATA_HDR          4   // msgType + seq(2) + reserved
#define OTA_WINDOW_TIMEOUT_MS 4000
#define OTA_TOTAL_TIMEOUT_MS  120000

// Decline reasons, reported to the hub. Anything non-zero means the transfer
// never started.
#define OTA_DECLINE_VERSION   1
#define OTA_DECLINE_BATTERY   2
#define OTA_DECLINE_PARTITION 3
#define OTA_DECLINE_SIZE      4
#define OTA_DECLINE_BUSY      5

#define OTA_RESULT_OK          0
#define OTA_RESULT_HASH        1
#define OTA_RESULT_SIGNATURE   2
#define OTA_RESULT_WRITE       3
#define OTA_RESULT_WRONG_IMAGE 4
#define OTA_RESULT_TIMEOUT     5

// A brownout midway is survivable -- the old image still boots -- but it wastes
// a full transfer and the operator's time, so refuse up front instead.
#define OTA_MIN_BATTERY_PCT 40

typedef struct __attribute__((packed)) {
  uint8_t  msgType;
  uint8_t  schema;
  uint16_t chunkSize;
  uint32_t imageSize;
  uint8_t  sha256[32];
  uint8_t  sigLen;
  uint8_t  sig[72];
  char     version[16];
} ota_offer_message;

typedef struct __attribute__((packed)) {
  uint8_t msgType;
  uint8_t accept;
  uint8_t reason;
  uint8_t pad;
} ota_req_message;

typedef struct __attribute__((packed)) {
  uint8_t  msgType;
  uint8_t  status;     // 0 = in order, 1 = retransmit from nextSeq
  uint16_t nextSeq;
} ota_ack_message;

typedef struct __attribute__((packed)) {
  uint8_t msgType;
  uint8_t result;
  uint8_t pad[2];
} ota_done_message;



// --- ESP-NOW ENCRYPTION ---
// IMPORTANT: These keys must be identical on all devices (hub + all sensors)
// Change both bytes below to your own secret values before deploying
static const uint8_t PMK_KEY[16] = {
  0x4A, 0x2F, 0x8C, 0x1E, 0x7B, 0x3D, 0x9A, 0x5F,
  0x6E, 0x2C, 0x4B, 0x8D, 0x1A, 0x7F, 0x3E, 0x9C
};
static const uint8_t LMK_KEY[16] = {
  0xE3, 0x4A, 0x7C, 0x91, 0xB5, 0x2D, 0xF8, 0x6E,
  0x1A, 0x9F, 0x3C, 0x72, 0xD4, 0x5B, 0x8E, 0x20
};

// --- BATTERY LOOKUP TABLE ---
// {voltage, percentage} for 2× Energizer Ultimate Lithium (L91, Li-FeS₂, AA)
// in SERIES. Nominal pack voltage 3.0 V; fresh ≈ 3.4 V, dead ≈ 1.8 V.
// NOTE: The HT7333-A LDO drops out below ~3.5 V under load, so the node
// will brown out long before the cells are physically empty. Useful pack
// voltage range with this regulator is roughly 3.6 V → 3.4 V.
struct BatteryPoint {
  float voltage;
  int   percentage;
};
const BatteryPoint batteryTable[] = {
  { 3.40, 100 }, { 3.30,  90 }, { 3.20,  80 }, { 3.10,  70 },
  { 3.00,  60 }, { 2.90,  50 }, { 2.80,  40 }, { 2.65,  30 },
  { 2.45,  20 }, { 2.20,  10 }, { 2.00,   5 }, { 1.85,   2 },
  { 1.80,   0 }
};
const int TABLE_SIZE = sizeof(batteryTable) / sizeof(batteryTable[0]);

struct BatteryInfo {
  float       voltage;
  int         percentage;
  const char* status;
};

// --- MESSAGE STRUCTURE ---
// IMPORTANT: must be byte-for-byte identical on hub and all sensors
// hum is sent as -999 — the hub should display "N/A" for NTC-only nodes
typedef struct struct_message {
  uint8_t  msgType;
  float    temp;
  float    hum;
  uint8_t  battery;   // 0–100 %; 255 = read error
  uint8_t  fw_major;  // firmware version of this node
  uint8_t  fw_minor;
  uint8_t  fw_patch;
  uint16_t cfg_ver;   // config version currently applied; 0 = compiled defaults
} struct_message;

// --- LOG MESSAGE STRUCTURE ---
// Sent over the same encrypted ESP-NOW peer as the data message.
// Chunked because ESP-NOW max payload is 250 bytes; one wake cycle's log
// is typically a few hundred bytes — usually fits in 1–2 chunks.
// --- CONFIG MESSAGE (hub -> sensor) ---
// Fixed size with explicit spare bytes so a parameter can be added later
// without a new wire format: older sensors ignore what they do not know, and
// only sensors that must *act* on a new field need new firmware.
typedef struct config_message {
  uint8_t  msgType;       // MSG_CONFIG
  uint8_t  schema;        // 1 = the fields below
  uint16_t cfg_ver;       // version being pushed
  uint16_t sleep_secs;    // reporting interval
  uint16_t pad;
  float    sh_a;          // Steinhart-Hart A (K^-1)
  float    sh_b;          // Steinhart-Hart B (K^-1)
  float    sh_c;          // Steinhart-Hart C (K^-1)
  float    r_series;      // divider resistor, ohms — per-board tolerance trim
  uint8_t  reserved[16];
} config_message;

typedef struct log_message {
  uint8_t msgType;            // MSG_LOG = 3
  uint8_t seq;                // chunk index (0-based)
  uint8_t total;              // total chunks in this log
  uint8_t len;                // valid bytes in data[] for this chunk
  char    data[LOG_CHUNK_DATA];
} log_message;

// --- GLOBALS ---
Preferences preferences;
esp_now_peer_info_t peerInfo;
struct_message myData;

uint8_t hubMac[6];
bool isPaired = false;
uint8_t broadcastAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

volatile bool tx_success  = false;
volatile bool tx_complete = false;

static float g_bat_v = 3.3f; // Set by getBatteryInfo(); used in readNTC() for VCC estimation

// Config version applied on this node. Bumped by the hub-pushed config handler;
// 0 means no config has ever been applied and the compiled defaults are in use.
// Reported to the hub every cycle so the dashboard can tell whether a pending
// change has actually landed.
// Public half of the firmware signing key, identical to the one the hub
// carries. It can verify a signature and never create one, so it is safe in
// the image and safe to extract from a device.
static const uint8_t FW_PUBLIC_KEY[] = {
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02,
  0x01, 0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03,
  0x42, 0x00, 0x04, 0xDB, 0x0E, 0x6F, 0x8E, 0x68, 0x68, 0x91, 0x13, 0x37,
  0x01, 0xC0, 0xDF, 0x60, 0x13, 0x37, 0xCC, 0x34, 0xF4, 0xE5, 0xFD, 0xE2,
  0x56, 0xCB, 0x2A, 0x2D, 0xE8, 0xF8, 0x21, 0xAF, 0x8B, 0xB5, 0x2C, 0xA0,
  0x5F, 0x76, 0x14, 0x52, 0xE3, 0x31, 0xB3, 0x26, 0x15, 0x44, 0xFB, 0xF4,
  0xA5, 0x98, 0x17, 0x13, 0xEE, 0xD2, 0x0A, 0x72, 0xB1, 0x71, 0xF1, 0x1F,
  0x20, 0x60, 0x01, 0x69, 0x65, 0xDC, 0x2C,
};


static uint16_t g_cfg_ver = 0;

// Live configuration. Compiled defaults until the hub pushes something.
static uint16_t g_sleepSecs = SLEEP_TIME;
static float    g_shA      = NTC_SH_A;
static float    g_shB      = NTC_SH_B;
static float    g_shC      = NTC_SH_C;
static float    g_rSeries  = SERIES_RESISTOR;

// Set by OnDataRecv when a config frame is accepted, so goToSleep() can stop
// waiting early and sleep for the new interval straight away.
static volatile bool g_configApplied = false;

// Stamp the fields that identify this node into the outgoing message. Must run
// before any send — pairing broadcasts carry them too, so the hub learns a
// node's firmware version at pairing time rather than one cycle later.
void loadIdentity() {
  preferences.begin("config", true);
  g_cfg_ver    = preferences.getUShort("cfg_ver", 0);
  g_sleepSecs = preferences.getUShort("sleep", SLEEP_TIME);
  g_shA       = preferences.getFloat ("sh_a",  NTC_SH_A);
  g_shB       = preferences.getFloat ("sh_b",  NTC_SH_B);
  g_shC       = preferences.getFloat ("sh_c",  NTC_SH_C);
  g_rSeries   = preferences.getFloat ("rser",  SERIES_RESISTOR);
  preferences.end();

  myData.fw_major = FW_MAJOR;
  myData.fw_minor = FW_MINOR;
  myData.fw_patch = FW_PATCH;
  myData.cfg_ver  = g_cfg_ver;
}

// --- LOG BUFFER ---
static char s_logBuf[LOG_BUF_SIZE];
static int  s_logLen = 0;

// ulog() — drop-in for Serial.printf; also appends to the in-memory log buffer
// that's sent to the hub over ESP-NOW just before deep sleep.
void ulog(const char *fmt, ...) {
  char tmp[256];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(tmp, sizeof(tmp), fmt, ap);
  va_end(ap);
  Serial.print(tmp);
  int rem = (int)sizeof(s_logBuf) - s_logLen - 1;
  if (rem > 0) {
    int n = (int)strlen(tmp);
    if (n > rem) n = rem;
    memcpy(s_logBuf + s_logLen, tmp, n);
    s_logLen += n;
    s_logBuf[s_logLen] = '\0';
  }
}

// sendLogToHub() — chunk the accumulated log buffer and ship it over ESP-NOW.
// Fire-and-forget per chunk: log delivery is best-effort by design (a missing
// chunk just leaves a gap in the hub's view; we don't retry to keep the wake
// cycle short and the energy budget tight).
void sendLogToHub() {
  if (!isPaired || s_logLen == 0) return;
  int total = (s_logLen + LOG_CHUNK_DATA - 1) / LOG_CHUNK_DATA;
  if (total > 255) total = 255;  // seq/total are uint8_t

  log_message msg;
  msg.msgType = MSG_LOG;
  msg.total   = (uint8_t)total;

  for (int i = 0; i < total; i++) {
    int offset    = i * LOG_CHUNK_DATA;
    int chunk_len = s_logLen - offset;
    if (chunk_len > LOG_CHUNK_DATA) chunk_len = LOG_CHUNK_DATA;
    msg.seq = (uint8_t)i;
    msg.len = (uint8_t)chunk_len;
    memcpy(msg.data, s_logBuf + offset, chunk_len);
    esp_now_send(hubMac, (uint8_t*)&msg, sizeof(msg));
    delay(40);  // pacing — let the previous packet leave the radio queue
  }
}

// Keep the radio up briefly after the log burst so a config pushed by the hub
// can land. The hub replies within a few ms of the data frame, and the log
// send above usually covers that already, so this normally returns at once.
// Coefficients can be individually plausible and still nonsense together — a
// transposed or mis-scaled fit is the realistic failure. An NTC's resistance
// must fall as temperature rises, so check the curve behaves like one across
// the deployment range rather than trusting three numbers in isolation.
bool shCoefficientsSane(float a, float b, float c) {
  const float probes[3] = { 5000.0f, 20000.0f, 80000.0f };
  float prev = 999.0f;
  for (int i = 0; i < 3; i++) {
    float lnR = log(probes[i]);
    float denom = a + b * lnR + c * lnR * lnR * lnR;
    if (denom <= 0.0f) return false;
    float t = 1.0f / denom - 273.15f;
    if (t < -60.0f || t > 100.0f) return false;   // implausible for this probe
    if (t >= prev) return false;                  // must decrease as R rises
    prev = t;
  }
  return true;
}

void waitForConfig() {
  if (!isPaired) return;
  unsigned long start = millis();
  while (!g_configApplied && millis() - start < CFG_WAIT_MS) {
    delay(2);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SENSOR OTA RECEIVER
// ─────────────────────────────────────────────────────────────────────────────
//
// The node is reachable only for the brief window after it transmits, so an
// update is offered then and runs to completion in one go. There is no resume
// across sleep cycles: at close range the transfer takes seconds, and
// restarting it costs less than the state needed to resume.
//
// Offered on a button-press wake only. A timer wake never listens for one, so
// the normal duty cycle is untouched and this costs nothing until asked for.

static uint8_t           otaRxBuf[OTA_MAX_CHUNK];
static volatile uint16_t otaRxLen   = 0;
static volatile bool     otaRxReady = false;
static volatile bool     otaActive  = false;
static volatile bool     otaOffered = false;
static ota_offer_message otaOffer;
static uint32_t          otaRxSeq   = 0;
static uint32_t          otaRxBytes = 0;

// App-level rollback, mirroring the hub. The bootloader on this hardware does
// not arm its own -- images boot straight to VALID -- so an image that cannot
// deliver a reading has to be backed out by the firmware itself.
#define OTA_MAX_BOOT_TRIES 3
static bool otaUnconfirmed = false;

void otaLoadState() {
  Preferences p;
  p.begin("otastate", false);
  bool    unconf = p.getBool("unconf", false);
  uint8_t tries  = p.getUChar("tries", 0);

  if (unconf) {
    tries++;
    ulog("[OTA] Unconfirmed image, boot attempt %u of %u\n", tries, OTA_MAX_BOOT_TRIES);

    if (tries > OTA_MAX_BOOT_TRIES) {
      const esp_partition_t *prev = esp_ota_get_next_update_partition(NULL);
      p.putBool("unconf", false);
      p.putUChar("tries", 0);
      p.end();
      if (prev && esp_ota_set_boot_partition(prev) == ESP_OK) {
        ulog("[OTA] Giving up on this image - reverting to %s\n", prev->label);
      } else {
        ulog("[OTA] Revert failed - staying on the current image\n");
      }
      delay(200);
      ESP.restart();
    }
    p.putUChar("tries", tries);
    otaUnconfirmed = true;
  }
  p.end();
}

// Called once a reading has actually reached the hub. Delivering a reading is
// the whole job of this firmware, so it is the right bar for calling an image
// good -- the same bar the hub uses when it reaches the cloud.
void otaConfirmImage() {
  if (!otaUnconfirmed) return;
  otaUnconfirmed = false;
  Preferences p;
  p.begin("otastate", false);
  p.putBool("unconf", false);
  p.putUChar("tries", 0);
  p.end();
  esp_ota_mark_app_valid_cancel_rollback();
  ulog("[OTA] Image delivered a reading - rollback disarmed\n");
}

static bool otaVerifySignature(const uint8_t *digest, const uint8_t *sig, size_t sigLen) {
  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  int rc = mbedtls_pk_parse_public_key(&pk, FW_PUBLIC_KEY, sizeof(FW_PUBLIC_KEY));
  if (rc != 0) {
    ulog("[OTA] Public key parse failed (-0x%04X)\n", -rc);
    mbedtls_pk_free(&pk);
    return false;
  }
  rc = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, digest, 32, sig, sigLen);
  mbedtls_pk_free(&pk);
  if (rc != 0) {
    ulog("[OTA] Signature verification FAILED (-0x%04X)\n", -rc);
    return false;
  }
  return true;
}

// Confirm the incoming bytes really are an ESP-IDF image before writing
// further. The app descriptor magic sits at a fixed offset in every one, so a
// wrong file is caught on the first chunk rather than after a full transfer.
static bool otaImageLooksRight(const uint8_t *head, size_t len) {
  if (len < 0x30) return true;
  uint32_t magic;
  memcpy(&magic, head + 0x20, 4);
  return magic == 0xABCD5432;
}

static void otaSendReq(uint8_t accept, uint8_t reason) {
  ota_req_message m = { MSG_OTA_REQ, accept, reason, 0 };
  esp_now_send(hubMac, (uint8_t *)&m, sizeof(m));
}

static void otaSendAck(uint8_t status, uint16_t nextSeq) {
  ota_ack_message m = { MSG_OTA_ACK, status, nextSeq };
  esp_now_send(hubMac, (uint8_t *)&m, sizeof(m));
}

static void otaSendDone(uint8_t result) {
  ota_done_message m = { MSG_OTA_DONE, result, {0, 0} };
  esp_now_send(hubMac, (uint8_t *)&m, sizeof(m));
  delay(60);
}

// Receive an offered image. Blocks until it finishes, fails or times out; on
// success it does not return, because the node reboots into the new image.
static void otaRunTransfer(int batteryPct) {
  const ota_offer_message *o = &otaOffer;

  char ver[17] = {0};
  memcpy(ver, o->version, 16);
  ulog("[OTA] Offered %s, %u bytes, chunk %u\n", ver, (unsigned)o->imageSize, o->chunkSize);

  char myVer[16];
  snprintf(myVer, sizeof(myVer), "%d.%d.%d", FW_MAJOR, FW_MINOR, FW_PATCH);
  if (strcmp(ver, myVer) == 0) {
    ulog("[OTA] Already running %s\n", myVer);
    otaSendReq(0, OTA_DECLINE_VERSION);
    return;
  }
  if (otaUnconfirmed) {
    otaSendReq(0, OTA_DECLINE_BUSY);
    return;
  }
  if (batteryPct != 255 && batteryPct < OTA_MIN_BATTERY_PCT) {
    ulog("[OTA] Battery %d%% too low to update\n", batteryPct);
    otaSendReq(0, OTA_DECLINE_BATTERY);
    return;
  }
  if (o->chunkSize == 0 || o->chunkSize > OTA_MAX_CHUNK) {
    otaSendReq(0, OTA_DECLINE_SIZE);
    return;
  }

  const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
  if (!target)                     { otaSendReq(0, OTA_DECLINE_PARTITION); return; }
  if (o->imageSize > target->size) { otaSendReq(0, OTA_DECLINE_SIZE);      return; }

  esp_ota_handle_t handle = 0;
  if (esp_ota_begin(target, o->imageSize, &handle) != ESP_OK) {
    otaSendReq(0, OTA_DECLINE_PARTITION);
    return;
  }

  mbedtls_md_context_t md;
  mbedtls_md_init(&md);
  mbedtls_md_setup(&md, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
  mbedtls_md_starts(&md);

  otaRxSeq = 0; otaRxBytes = 0; otaRxLen = 0; otaRxReady = false;
  otaActive = true;
  otaSendReq(1, 0);

  uint32_t      expected    = (o->imageSize + o->chunkSize - 1) / o->chunkSize;
  unsigned long lastRx      = millis();
  unsigned long start       = millis();
  uint8_t       result      = OTA_RESULT_TIMEOUT;
  bool          headChecked = false;

  while (otaRxSeq < expected) {
    if (millis() - start > OTA_TOTAL_TIMEOUT_MS) break;

    if (!otaRxReady) {
      if (millis() - lastRx > OTA_WINDOW_TIMEOUT_MS) {
        otaSendAck(1, (uint16_t)otaRxSeq);
        lastRx = millis();
      }
      delay(2);
      continue;
    }

    uint16_t len = otaRxLen;
    otaRxReady = false;
    lastRx = millis();

    if (!headChecked) {
      headChecked = true;
      if (!otaImageLooksRight(otaRxBuf, len)) {
        result = OTA_RESULT_WRONG_IMAGE;
        ulog("[OTA] Rejected: not an ESP-IDF image\n");
        break;
      }
    }

    if (esp_ota_write(handle, otaRxBuf, len) != ESP_OK) { result = OTA_RESULT_WRITE; break; }
    mbedtls_md_update(&md, otaRxBuf, len);
    otaRxBytes += len;
    otaRxSeq++;

    if ((otaRxSeq % 8) == 0 || otaRxSeq == expected) {
      otaSendAck(0, (uint16_t)otaRxSeq);
      if ((otaRxSeq % 64) == 0) {
        ulog("[OTA] %u%%\n", (unsigned)(otaRxBytes * 100 / o->imageSize));
      }
    }
  }

  otaActive = false;
  uint8_t digest[32];
  mbedtls_md_finish(&md, digest);
  mbedtls_md_free(&md);

  if (otaRxSeq >= expected && otaRxBytes == o->imageSize) {
    if      (memcmp(digest, o->sha256, 32) != 0)             result = OTA_RESULT_HASH;
    else if (!otaVerifySignature(digest, o->sig, o->sigLen)) result = OTA_RESULT_SIGNATURE;
    else                                                     result = OTA_RESULT_OK;
  }

  if (result != OTA_RESULT_OK) {
    esp_ota_abort(handle);
    ulog("[OTA] Failed, result %u (%u/%u bytes)\n", result,
         (unsigned)otaRxBytes, (unsigned)o->imageSize);
    otaSendDone(result);
    return;
  }

  if (esp_ota_end(handle) != ESP_OK || esp_ota_set_boot_partition(target) != ESP_OK) {
    ulog("[OTA] Staging failed\n");
    otaSendDone(OTA_RESULT_WRITE);
    return;
  }

  {
    Preferences p;
    p.begin("otastate", false);
    p.putBool("unconf", true);
    p.putUChar("tries", 0);
    p.end();
  }

  ulog("[OTA] Verified - rebooting into %s\n", ver);
  otaSendDone(OTA_RESULT_OK);
  delay(150);
  esp_now_deinit();
  esp_wifi_stop();
  delay(50);
  ESP.restart();
}

// Wait briefly for the hub to offer an image, then run it. Only done on a
// button wake, which is the deliberate signal that someone wants this node
// updated.
void otaMaybeUpdate(int batteryPct) {
  if (!isPaired) return;
  unsigned long start = millis();
  while (!otaOffered && millis() - start < 400) delay(5);
  if (!otaOffered) return;
  otaOffered = false;
  otaRunTransfer(batteryPct);
}

// --- SAFE DEEP SLEEP ---
// ESP32-C6 RISC-V requires proper WiFi/ESP-NOW shutdown before sleep
// Skipping this causes the illegal instruction crash (MCAUSE: 0x18)
void goToSleep(int seconds) {
  Serial.printf("Sleeping for %d seconds...\n\n", seconds);
  Serial.flush();         // Ensure serial output completes

  sendLogToHub();         // Ship the wake-cycle log to the hub via ESP-NOW
  waitForConfig();        // Brief window for a config the hub may be pushing
  esp_now_deinit();       // Then deinit ESP-NOW
  esp_wifi_stop();        // Stop WiFi radio
  delay(100);             // Allow shutdown to settle

  esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
  // D0 (GPIO0) is an LP GPIO — supports deep sleep GPIO wakeup.
  // Pressing the button wakes the device early for factory reset or manual data send.
  esp_deep_sleep_enable_gpio_wakeup(1ULL << RESET_PIN, ESP_GPIO_WAKEUP_GPIO_LOW);
  esp_deep_sleep_start(); // Step 4: Sleep
}

// --- HIBERNATE SLEEP (button-wake only) ---
// Used when the hub has been unreachable for MAX_FAILED_WAKES_BEFORE_HIBERNATE
// consecutive wake cycles. The device sleeps until the user presses the D0
// button; no timer wake is set, so battery drain is limited to the C6's deep
// sleep quiescent current (~7 µA) plus any regulator Iq (~11 µA for TPS63802
// in PFM mode). Total hibernate current: ~20 µA — the sensor can sit in
// hibernate for months without appreciable battery drain.
//
// The next boot after button wake sees in_hibernate_mode == true and clears
// the failure counter to give TX a fresh window (see setup() for the wake
// handshake — LED blinks 3× to acknowledge the button press).
void goToHibernateSleep() {
  ulog("→ HIBERNATE  (press D0 button to wake)\n");
  Serial.flush();

  sendLogToHub();         // Best-effort — hub is probably unreachable, but try anyway
  esp_now_deinit();
  esp_wifi_stop();
  delay(100);

  // GPIO wake ONLY — no timer wake. Sensor sleeps indefinitely on the wall
  // clock, waking only when the user presses D0 to signal that connectivity
  // should be re-attempted.
  esp_deep_sleep_enable_gpio_wakeup(1ULL << RESET_PIN, ESP_GPIO_WAKEUP_GPIO_LOW);
  esp_deep_sleep_start();
}

// --- CALLBACKS ---
void OnDataSent(const wifi_tx_info_t *info, esp_now_send_status_t status) {
  tx_complete = true;
  tx_success  = (status == ESP_NOW_SEND_SUCCESS);
}

void OnDataRecv(const esp_now_recv_info_t *esp_now_info, const uint8_t *incomingData, int len) {
  if (len < 1) return;

  // Config push from the hub. Values are validated here rather than trusted:
  // out-of-range settings are rejected outright, not silently clamped to
  // something the operator never chose. The rejection is written to the wake
  // log, which the hub already collects, and cfg_ver stays unchanged so the
  // dashboard keeps showing the change as pending.
  if (incomingData[0] == MSG_CONFIG && len >= (int)sizeof(config_message)) {
    const config_message *cfg = (const config_message *)incomingData;

    if (cfg->sleep_secs < CFG_SLEEP_MIN || cfg->sleep_secs > CFG_SLEEP_MAX) {
      ulog("[CFG] Rejected: sleep %u outside %u-%u\n",
           cfg->sleep_secs, CFG_SLEEP_MIN, CFG_SLEEP_MAX);
      return;
    }
    if (!(cfg->r_series >= CFG_RSERIES_MIN && cfg->r_series <= CFG_RSERIES_MAX)) {
      ulog("[CFG] Rejected: r_series %.0f outside %.0f-%.0f\n",
           cfg->r_series, CFG_RSERIES_MIN, CFG_RSERIES_MAX);
      return;
    }
    if (!isfinite(cfg->sh_a) || !isfinite(cfg->sh_b) || !isfinite(cfg->sh_c) ||
        fabsf(cfg->sh_a) > CFG_COEF_ABS_MAX ||
        fabsf(cfg->sh_b) > CFG_COEF_ABS_MAX ||
        fabsf(cfg->sh_c) > CFG_COEF_ABS_MAX) {
      ulog("[CFG] Rejected: A/B/C magnitude implausible (%.4e %.4e %.4e)\n",
           cfg->sh_a, cfg->sh_b, cfg->sh_c);
      return;
    }
    if (!shCoefficientsSane(cfg->sh_a, cfg->sh_b, cfg->sh_c)) {
      ulog("[CFG] Rejected: A/B/C do not produce a falling NTC curve\n");
      return;
    }

    preferences.begin("config", false);
    preferences.putUShort("sleep",   cfg->sleep_secs);
    preferences.putFloat ("sh_a",    cfg->sh_a);
    preferences.putFloat ("sh_b",    cfg->sh_b);
    preferences.putFloat ("sh_c",    cfg->sh_c);
    preferences.putFloat ("rser",    cfg->r_series);
    preferences.putUShort("cfg_ver", cfg->cfg_ver);
    preferences.end();

    g_sleepSecs = cfg->sleep_secs;
    g_shA       = cfg->sh_a;
    g_shB       = cfg->sh_b;
    g_shC       = cfg->sh_c;
    g_rSeries   = cfg->r_series;
    g_cfg_ver   = cfg->cfg_ver;
    g_configApplied = true;

    ulog("[CFG] Applied v%u: sleep %us, R=%.0f, A=%.4e B=%.4e C=%.4e\n",
         cfg->cfg_ver, cfg->sleep_secs, cfg->r_series,
         cfg->sh_a, cfg->sh_b, cfg->sh_c);
    return;
  }

  if (incomingData[0] == MSG_OTA_OFFER && len >= (int)sizeof(ota_offer_message)) {
    memcpy(&otaOffer, incomingData, sizeof(otaOffer));
    otaOffered = true;
    return;
  }

  // Only the chunk currently being waited for is taken, and only while the
  // previous one has been consumed. Anything else is dropped and the hub is
  // told where to resume, which keeps the receive path free of queueing.
  if (incomingData[0] == MSG_OTA_DATA && otaActive && len > OTA_DATA_HDR) {
    uint16_t seq;
    memcpy(&seq, incomingData + 1, 2);
    if (seq == (uint16_t)otaRxSeq && !otaRxReady) {
      uint16_t payload = (uint16_t)(len - OTA_DATA_HDR);
      if (payload <= OTA_MAX_CHUNK) {
        memcpy(otaRxBuf, incomingData + OTA_DATA_HDR, payload);
        otaRxLen   = payload;
        otaRxReady = true;
      }
    }
    return;
  }

  struct_message *msg = (struct_message *)incomingData;

  if (msg->msgType == MSG_PAIRING) {
    Serial.println("\n✓ Hub Found!");
    Serial.printf("Hub MAC: %02X:%02X:%02X:%02X:%02X:%02X\n",
                  esp_now_info->src_addr[0], esp_now_info->src_addr[1],
                  esp_now_info->src_addr[2], esp_now_info->src_addr[3],
                  esp_now_info->src_addr[4], esp_now_info->src_addr[5]);

    preferences.begin("network", false);
    preferences.putBytes("hubMac", esp_now_info->src_addr, 6);
    preferences.end();

    for (int i = 0; i < 5; i++) {
      digitalWrite(LED_PIN, HIGH); delay(150);
      digitalWrite(LED_PIN, LOW);  delay(150);
    }

    Serial.println("Pairing saved! Restarting...");
    delay(500);
    ESP.restart();
  }
}

// --- FACTORY RESET ---
void checkFactoryReset() {
  delay(50); // GPIO stabilization delay needed on C6

  if (digitalRead(RESET_PIN) != LOW) return;

  Serial.println("BOOT held... Hold 3s to factory reset.");
  unsigned long startPress = millis();

  while (digitalRead(RESET_PIN) == LOW) {
    if (millis() - startPress > 3000) {
      Serial.println("\n=== FACTORY RESET ===");
      preferences.begin("network", false);
      preferences.clear();
      preferences.end();
      Serial.println("✓ Pairing data erased");

      // Also drop any cloud-pushed config so the node returns to compiled
      // defaults. This is the recovery path for a bad remote config, and it
      // needs no tooling — the customer can do it over the phone.
      preferences.begin("config", false);
      preferences.clear();
      preferences.end();
      Serial.println("✓ Config reset to defaults");

      for (int i = 0; i < 15; i++) {
        digitalWrite(LED_PIN, HIGH); delay(80);
        digitalWrite(LED_PIN, LOW);  delay(80);
      }

      Serial.println("Restarting...");
      delay(500);
      ESP.restart();
    }
    delay(50);
  }
}

// --- READ NTC PROBE ---
// Circuit: 3.3V → NTC probe → NTC_PIN (ADC) → SERIES_RESISTOR → NTC_ENABLE_PIN (GND switch)
// NTC is on the high side so cold temps (high R_ntc) give LOW ADC voltage — the accurate
// region of the ESP32 ADC. Old topology (R_series on top) pushed cold readings to ~2.9V
// which is in the nonlinear zone of ADC_11db, causing ~11°C error at -17°C.
// A 100 nF filter cap (Cfn) at NTC_PIN → GND low-pass filters the ADC input.
// NTC_ENABLE_PIN is driven LOW to complete the divider; Hi-Z during sleep cuts quiescent current.
// Temperature is derived via the Steinhart-Hart simplified (Beta) equation:
//   1/T = 1/T0 + (1/B) * ln(R_ntc / R0)
float readNTC() {
  // Enable divider by driving GND switch LOW
  pinMode(NTC_ENABLE_PIN, OUTPUT);
  digitalWrite(NTC_ENABLE_PIN, LOW);
  delay(60); // Let divider + 100 nF filter cap settle (RC ≈ 0.5 ms, 10 ms covers 20× time constants)

  analogReadResolution(12);
  analogRead(NTC_PIN);                       // Initialise ADC channel
  analogSetPinAttenuation(NTC_PIN, ADC_11db); // 0–2.5 V range on ESP32-C6; ADC_6db saturates at ~1.3V (too low for room temp)
  analogRead(NTC_PIN);                       // Latch attenuation

  // Discard first reading (settling artefact)
  analogReadMilliVolts(NTC_PIN);
  delay(5);

  long sum = 0;
  for (int i = 0; i < NTC_SAMPLES; i++) {
    sum += analogReadMilliVolts(NTC_PIN);
    delay(5);
  }

  // Disable divider — drive Hi-Z to cut quiescent current during any remaining awake time
  pinMode(NTC_ENABLE_PIN, INPUT);

  float adcMv  = sum / (float)NTC_SAMPLES;
  float adcV   = adcMv / 1000.0f;

  // VCC reference for the NTC divider math — see the "NTC VCC reference"
  // comment block in the BATTERY MONITOR section above for the full rationale.
  //
  //   HAS_REGULATOR=1 (external TPS63802 or onboard buck-boost):
  //     VCC is constant 3.3 V regardless of bat_v. Using bat_v here would
  //     make readings drift as the cell drains, because the 3V3 rail stays
  //     at 3.3 V while bat_v can swing from 3.6 V → 1.8 V.
  //
  //   HAS_REGULATOR=0 (battery direct to 3V3 pin, no regulator):
  //     VCC = bat_v (the C6 is fed straight from the battery). The constrain()
  //     clamps to the ESP32-C6 valid supply range (≈ 2.5 V brownout to 3.6 V).
  //     On USB power, the XIAO's onboard LDO holds VCC at 3.3 V; bat_v won't
  //     reflect that, so USB-only debugging reads warmer than calibration —
  //     fine for bench work.
#if NTC_VCC_REGULATED
  float vcc = NTC_VCC_FIXED;
#else
  float vcc = constrain(g_bat_v - LDO_DROPOUT_V, 2.5f, 3.6f);
#endif

  if (adcV <= 0.01f || adcV >= (vcc - 0.01f)) {
    // Saturated ADC almost certainly means open or shorted probe
    ulog("✗ NTC read failed — probe open or shorted (check wiring)\n");
    return -999;
  }

  // Resolve NTC resistance from the divider, using the equation that matches
  // which leg the NTC is actually on (see NTC_ON_LOW_SIDE above).
#if NTC_ON_LOW_SIDE
  // V_adc = vcc * R_ntc / (R_ntc + R_series)  =>  R_ntc = R_series * V_adc / (vcc - V_adc)
  float r_ntc = g_rSeries * adcV / (vcc - adcV);
#else
  // V_adc = vcc * R_series / (R_ntc + R_series)  =>  R_ntc = R_series * (vcc - V_adc) / V_adc
  float r_ntc = g_rSeries * (vcc - adcV) / adcV;
#endif

  // Full Steinhart-Hart equation: 1/T(K) = A + B·ln(R) + C·(ln(R))³
  float lnR   = log(r_ntc);
  float tempC = 1.0f / (g_shA + g_shB * lnR + g_shC * lnR * lnR * lnR) - 273.15f;
  ulog("[NTC] vcc=%.3fV  adc=%.0fmV  R_ntc=%.0fΩ  T=%.2f°C\n", vcc, adcMv, r_ntc, tempC);

  if (tempC < -55.0f || tempC > 125.0f) {
    ulog("✗ NTC temperature out of valid range\n");
    return -999;
  }

  return tempC;
}

bool readSensor() {
  Serial.println("Reading NTC probe...");
  float temp = readNTC();

  myData.hum = -999; // NTC probe does not measure humidity

  if (temp == -999) {
    myData.temp = -999;
    return false;
  }

  myData.temp = temp;
  ulog("✓ Temp: %.2f°C  Hum: N/A\n", myData.temp);
  return true;
}

// --- BATTERY MONITOR ---
// Circuit: BAT+ → R1(120kΩ) → GPIO2/D2(ADC) → R2(120kΩ) → GPIO21/D3(GND switch)
// D1=OUTPUT LOW enables divider; D1=INPUT (Hi-Z) cuts current during sleep.
float readADCVoltage() {
  analogReadMilliVolts(BAT_ADC_PIN);   // discard first conversion (settling)
  delay(5);
  long sum = 0;
  for (int i = 0; i < ADC_SAMPLES; i++) {
    sum += analogReadMilliVolts(BAT_ADC_PIN);
    delay(5);
  }

  pinMode(DIVIDER_ENABLE_PIN, INPUT);   // Hi-Z — zero current draw

  float adcMv      = sum / (float)ADC_SAMPLES;
  float adcVoltage = adcMv / 1000.0f;
  int   rawCount   = analogRead(BAT_ADC_PIN);
  ulog("[BAT] pin_mv=%.0f  raw=%d  bat_v=%.3f\n", adcMv, rawCount, adcVoltage * 2.0f);
  return adcVoltage * 2.0f;    // × 2 restores full voltage (equal-value divider)
}

int voltageToPct(float voltage) {
  if (voltage >= batteryTable[0].voltage)              return 100;
  if (voltage <= batteryTable[TABLE_SIZE - 1].voltage) return 0;
  for (int i = 0; i < TABLE_SIZE - 1; i++) {
    if (voltage <= batteryTable[i].voltage && voltage > batteryTable[i + 1].voltage) {
      float vHigh = batteryTable[i].voltage;
      float vLow  = batteryTable[i + 1].voltage;
      int   pHigh = batteryTable[i].percentage;
      int   pLow  = batteryTable[i + 1].percentage;
      float ratio = (voltage - vLow) / (vHigh - vLow);
      return pLow + (int)(ratio * (pHigh - pLow));
    }
  }
  return 0;
}

const char* getBatteryStatus(int pct) {
  if (pct > 60)              return "GOOD";
  if (pct > LOW_BATTERY_PCT) return "LOW";
  if (pct > CRITICAL_PCT)    return "WARNING";
  return "CRITICAL";
}

// Battery divider: BAT+ → R3 (120k) → BAT_ADC tap → R4 (120k) → DIVIDER_ENABLE_PIN (GND switch)
// A 10 nF filter cap (Cfb) at BAT_ADC → GND low-pass filters the ADC input.
// DIVIDER_ENABLE_PIN LOW enables the divider; Hi-Z during sleep cuts quiescent current.
BatteryInfo getBatteryInfo() {
  analogReadResolution(12);

  pinMode(DIVIDER_ENABLE_PIN, OUTPUT);
  digitalWrite(DIVIDER_ENABLE_PIN, LOW);
  delay(10); // Let divider + 10 nF filter cap settle (RC ≈ 0.6 ms at ~60 kΩ source)

  analogRead(BAT_ADC_PIN);
  analogSetPinAttenuation(BAT_ADC_PIN, ADC_11db);
  analogRead(BAT_ADC_PIN);

  float voltage = readADCVoltage();
  g_bat_v = voltage;
  int   pct;
  if (voltage < 2.5f) {
    pct = 255;
  } else {
    pct = voltageToPct(voltage);
  }

  BatteryInfo info;
  info.voltage    = voltage;
  info.percentage = pct;
  info.status     = (pct == 255) ? "ERR" : getBatteryStatus(pct);
  return info;
}

// --- SEND WITH RETRIES ---
bool sendDataWithRetry() {
  for (int retry = 0; retry < MAX_RETRIES; retry++) {
    tx_complete = false;
    tx_success  = false;

    esp_err_t result = esp_now_send(hubMac, (uint8_t *)&myData, sizeof(myData));

    if (result != ESP_OK) {
      Serial.printf("✗ Send error: 0x%X  Retry %d/%d\n", result, retry+1, MAX_RETRIES);
      delay(RETRY_DELAY_MS);
      continue;
    }

    unsigned long start = millis();
    while (!tx_complete && (millis() - start < TX_TIMEOUT_MS)) {
      delay(5);
    }

    if (tx_success) {
      ulog("✓ Delivered!\n");
      digitalWrite(LED_PIN, HIGH); delay(100); digitalWrite(LED_PIN, LOW);
      return true;
    }

    Serial.printf("✗ %s  Retry %d/%d\n",
      tx_complete ? "No ACK" : "Timeout",
      retry+1, MAX_RETRIES);
    delay(RETRY_DELAY_MS);
  }

  ulog("✗ All retries failed.\n");
  return false;
}

uint8_t detectWiFiChannel() {
  Serial.print("Scanning for WiFi channel...");
  int n = WiFi.scanNetworks(/*async=*/false, /*show_hidden=*/true);

  for (int i = 0; i < n; i++) {
    if (WiFi.SSID(i) == HUB_AP_SSID) {
      uint8_t ch = (uint8_t)WiFi.channel(i);
      Serial.printf(" hub AP on ch %d\n", ch);
      WiFi.scanDelete();
      return ch;
    }
  }

  if (n > 0) {
    int bestIdx = 0;
    for (int i = 1; i < n; i++) {
      if (WiFi.RSSI(i) > WiFi.RSSI(bestIdx)) bestIdx = i;
    }
    uint8_t ch = (uint8_t)WiFi.channel(bestIdx);
    Serial.printf(" ch %d (%s, %d dBm)\n", ch, WiFi.SSID(bestIdx).c_str(), WiFi.RSSI(bestIdx));
    WiFi.scanDelete();
    return ch;
  }

  Serial.printf(" no APs found, defaulting to ch %d\n", FALLBACK_CHANNEL);
  return FALLBACK_CHANNEL;
}

// --- PAIRING MODE ---
void enterPairingMode() {
  Serial.println("\n=== PAIRING MODE ===");
  digitalWrite(LED_PIN, HIGH);

  memcpy(peerInfo.peer_addr, broadcastAddress, 6);
  peerInfo.channel = ESPNOW_CHANNEL;
  peerInfo.encrypt = false;

  if (esp_now_add_peer(&peerInfo) != ESP_OK) {
    Serial.println("✗ Failed to add broadcast peer");
    goToSleep(10);
    return;
  }

  myData.msgType  = MSG_PAIRING;
  myData.temp     = 0;
  myData.hum      = 0;
  myData.battery  = 0;

  Serial.print("Waiting for hub");
  unsigned long startWait    = millis();
  unsigned long lastBroadcast = 0;
  while (millis() - startWait < 70000) {
    if (millis() - lastBroadcast >= 2000) {
      esp_now_send(broadcastAddress, (uint8_t *)&myData, sizeof(myData));
      lastBroadcast = millis();
      Serial.print(".");
    }
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    delay(250);
  }

  Serial.println();
  digitalWrite(LED_PIN, LOW);
  Serial.println("✗ Timeout. Retrying in 10s...");
  goToSleep(10);
}

// --- SETUP ---
void setup() {
#if BOARD_REV == 1
  // XIAO ESP32-C6 carrier only: GPIO3 powers the RF switch, GPIO14 selects the
  // external u.FL antenna. v2 hardware wires the u.FL directly to the WROOM-1U's
  // RF pin and does not need either of these.
  pinMode(3, OUTPUT);
  digitalWrite(3, LOW);
  delay(100);
  pinMode(14, OUTPUT);
  digitalWrite(14, HIGH); // external antenna
#endif

  Serial.begin(115200);
  delay(500); // C6 needs extra time for serial to stabilize
  ulog("\n=== XIAO ESP32-C6 Sensor (NTC Probe) ===\n");
  Serial.println(FW_VERSION_TAG);

  // If the previous boot ended in a brownout (radio TX pulled VCC below the
  // ESP32-C6's brownout threshold), do NOT try to TX again immediately. That
  // creates a tight boot→TX→brownout→reset loop that drains the battery in
  // hours instead of months. Just sleep the normal interval and let the
  // battery rest / warm up before trying again.
  esp_reset_reason_t reset_reason = esp_reset_reason();
  ulog("Reset reason: %d\n", (int)reset_reason);
  if (reset_reason == ESP_RST_BROWNOUT) {
    ulog("⚠ Brownout on previous boot — skipping wake cycle\n");
    esp_sleep_enable_timer_wakeup((uint64_t)g_sleepSecs * 1000000ULL);
    esp_deep_sleep_enable_gpio_wakeup(1ULL << RESET_PIN, ESP_GPIO_WAKEUP_GPIO_LOW);
    esp_deep_sleep_start();
  }

  pinMode(RESET_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  checkFactoryReset();

  esp_sleep_wakeup_cause_t wakeup_reason = esp_sleep_get_wakeup_cause();
  if (wakeup_reason == ESP_SLEEP_WAKEUP_GPIO) {
    ulog("Wakeup caused by button press on D0\n");
  }

  // Force-rescan flag: true on any button-press wake. The user pressed the
  // button because they want data delivered now — always give them a fresh
  // channel scan rather than trusting the cached channel or waiting for the
  // "rescan on 2nd consecutive failure" logic (which needs two failed wakes
  // before it kicks in, i.e. two button presses to recover). Timer wakes keep
  // using the cached channel to save the ~1.5 s scan energy.
  //
  // Also resets the failure counter and (implicitly, via the success path) the
  // in_hibernate_mode flag: a button press is an explicit user action, not a
  // background retry, so we don't count it against the hibernate budget.
  bool force_rescan_this_cycle = false;

  if (wakeup_reason == ESP_SLEEP_WAKEUP_GPIO) {
    ulog("Button-press wake — resetting failure counter + forcing channel rescan\n");
    consecutive_failed_wakes = 0;
    force_rescan_this_cycle = true;
    // Blink LED 3× to acknowledge the button press was received.
    for (int i = 0; i < 3; i++) {
      digitalWrite(LED_PIN, HIGH); delay(80);
      digitalWrite(LED_PIN, LOW);  delay(80);
    }
  }

  // Stored configuration must be loaded before anything uses it. It was
  // previously read after readSensor(), which meant the NTC conversion silently
  // used the compiled defaults and no pushed calibration ever affected a
  // reading: a probe configured with r_series=47000 was still being computed
  // against 10000. Only NVS access, so it is safe this early.
  otaLoadState();   // may revert and restart if this image keeps failing
  loadIdentity();

  // Read battery BEFORE radio init
  BatteryInfo bat = getBatteryInfo();
  ulog("Battery: %.2fV  %d%%  %s\n", bat.voltage, bat.percentage, bat.status);
  if (bat.percentage != 255 && bat.percentage <= CRITICAL_PCT) {
    Serial.println("Battery critical — sleeping to protect cell.");
    esp_sleep_enable_timer_wakeup((uint64_t)g_sleepSecs * 1000000ULL);
    esp_deep_sleep_start();
  }
  //read ntc before radio init since it can cause brownout at low battery levels, leading to failed reads
  readSensor();

  ulog("FW %d.%d.%d  cfg_ver %u  R=%.0f\n",
       FW_MAJOR, FW_MINOR, FW_PATCH, g_cfg_ver, g_rSeries);

  // Load pairing
  preferences.begin("network", true);
  size_t len = preferences.getBytes("hubMac", hubMac, 6);
  preferences.end();
  isPaired = (len == 6);

  if (isPaired) {
    ulog("✓ Paired to: %02X:%02X:%02X:%02X:%02X:%02X\n",
         hubMac[0], hubMac[1], hubMac[2],
         hubMac[3], hubMac[4], hubMac[5]);
  } else {
    Serial.println("Not paired.");
  }

  // WiFi + ESP-NOW
  WiFi.mode(WIFI_STA);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  esp_wifi_set_protocol(WIFI_IF_STA,
    WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G |
    WIFI_PROTOCOL_11N | WIFI_PROTOCOL_LR);

  {
    preferences.begin("network", true);
    uint8_t ch = (uint8_t)preferences.getUChar("channel", 0);
    preferences.end();

    // Rescan the WiFi channel when:
    //   1. Nothing cached yet (first boot / after factory reset), OR
    //   2. We woke via a D0 button press (user wants a fresh attempt; the
    //      cached channel may be stale — hub may have moved to a different
    //      channel since the last successful TX).
    // Otherwise use the cached value to save the ~1.5 s scan energy cost.
    if (ch == 0 || force_rescan_this_cycle) {
      const char *why = (ch == 0) ? "no cached channel" : "button-press wake";
      ulog("[CH] Rescanning (%s)...\n", why);
      ch = detectWiFiChannel();
      preferences.begin("network", false);
      preferences.putUChar("channel", ch);
      preferences.end();
      ulog("[CH] Cached channel %d\n", ch);
    } else {
      ulog("[CH] Using cached channel %d\n", ch);
    }
    esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
  }

  if (esp_now_init() != ESP_OK) {
    Serial.println("✗ ESP-NOW init failed! Sleeping 10s...");
    goToSleep(10);
    return;
  }
  esp_now_set_pmk(PMK_KEY);

  esp_now_register_send_cb(OnDataSent);
  esp_now_register_recv_cb(OnDataRecv);
  Serial.println("✓ ESP-NOW ready (encrypted)");

  if (isPaired) {
    Serial.println("\n--- Data Mode ---");

    memcpy(peerInfo.peer_addr, hubMac, 6);
    peerInfo.channel = ESPNOW_CHANNEL;
    peerInfo.encrypt = true;
    memcpy(peerInfo.lmk, LMK_KEY, 16);

    if (esp_now_add_peer(&peerInfo) != ESP_OK) {
      Serial.println("✗ Peer add failed, restarting...");
      ESP.restart();
    }

    myData.msgType  = MSG_DATA;
    myData.battery  = (uint8_t)bat.percentage;
    //readSensor();

    // Settle window before the TX burst: WiFi scan just drew ~100 mA for ~1.5 s
    // and pulled the input cap (and battery) down. Idle here so the LDO refills
    // both caps from the battery before the 200 mA TX burst hits. ~150 ms is
    // ~50× the 1000 µF input-cap RC time constant — fully recharges either cap.
    delay(500);

    bool tx_ok = sendDataWithRetry();

    if (tx_ok) {
      // Success — clear failure state.
      if (consecutive_failed_wakes > 0 || in_hibernate_mode) {
        ulog("✓ Connectivity restored (cleared %u failure%s)\n",
             consecutive_failed_wakes, consecutive_failed_wakes == 1 ? "" : "s");
      }
      consecutive_failed_wakes = 0;
      in_hibernate_mode = false;
      otaConfirmImage();   // a delivered reading is what proves an image good

      // Only a button press asks for an update. Timer wakes never listen, so
      // the duty cycle is unchanged.
      if (force_rescan_this_cycle) otaMaybeUpdate(bat.percentage);

    } else {
      // Failure — bump the counter (RTC memory, persists across sleep).
      consecutive_failed_wakes++;
      ulog("✗ TX failed. Consecutive failures: %u/%u\n",
           consecutive_failed_wakes, MAX_FAILED_WAKES_BEFORE_HIBERNATE);

      // Once we hit RESCAN_ON_FAILURE_AT_COUNT, try a channel rescan in case
      // the hub has moved to a different WiFi channel (router reboot etc.).
      // We only rescan ONCE — repeated scans burn battery for little benefit,
      // and the hibernate policy below caps total wasted energy anyway.
      if (consecutive_failed_wakes == RESCAN_ON_FAILURE_AT_COUNT) {
        ulog("Trying channel rescan (hub may have moved channels)...\n");
        uint8_t new_ch = detectWiFiChannel();
        preferences.begin("network", false);
        preferences.putUChar("channel", new_ch);
        preferences.end();
        esp_wifi_set_channel(new_ch, WIFI_SECOND_CHAN_NONE);
        if (sendDataWithRetry()) {
          ulog("✓ TX succeeded after rescan — clearing failure counter\n");
          consecutive_failed_wakes = 0;
          in_hibernate_mode = false;
        }
      }

      // If we've hit the hibernate threshold, sleep indefinitely (button-only
      // wake) rather than continuing to burn ~10 s of high current per cycle
      // trying to reach an unreachable hub.
      if (consecutive_failed_wakes >= MAX_FAILED_WAKES_BEFORE_HIBERNATE) {
        in_hibernate_mode = true;
        goToHibernateSleep();  // Does not return.
      }
    }

    goToSleep(g_sleepSecs);   // configured interval, not the compiled default
  } else {
    enterPairingMode();
  }
}

void loop() {
  // Never reached
}
