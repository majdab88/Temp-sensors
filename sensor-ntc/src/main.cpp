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
// Overridable from build_flags, so a test build can carry its own version
// without editing this file (see the rollbacktest env).
#ifndef FW_MAJOR
#define FW_MAJOR 1
#endif
#ifndef FW_MINOR
#define FW_MINOR 1
#endif
#ifndef FW_PATCH
#define FW_PATCH 15
#endif
#define STR_(x) #x
#define STR(x)  STR_(x)

// Greppable marker so the registry can check an uploaded image really is sensor
// firmware of the version it is being labelled with. Deliberately distinct from
// the hub marker: sending a hub image to a sensor would give it the wrong pins
// and no sleep, and on a v2 board that needs an ESP-PROG to undo.
// Printed at boot so the linker cannot discard it.
#define FW_VERSION_TAG "TEMPSENS_FW=" STR(FW_MAJOR) "." STR(FW_MINOR) "." STR(FW_PATCH)

// Which hardware this image was built for: every build flag that changes what a
// reading means. The sensor refuses an OTA image that does not carry its own
// marker (see otaBoardScan). The failure this prevents is quiet: a v1 image on
// a v2 board boots, reads the divider the wrong way round and still delivers --
// so the rollback, which only watches for delivery, never fires, and the
// dashboard shows confident, wrong temperatures.
//
// The ';' ends the value, so the scan knows where it stops.
#if HAS_REGULATOR
#define FW_BOARD_REG "-reg"
#else
#define FW_BOARD_REG ""
#endif
#if NTC_ON_LOW_SIDE
#define FW_BOARD_NTC "-lowside"
#else
#define FW_BOARD_NTC "-highside"
#endif
#define FW_BOARD          "rev" STR(BOARD_REV) FW_BOARD_REG FW_BOARD_NTC
#define FW_BOARD_PREFIX   "TEMPSENS_BOARD="
#define FW_BOARD_TAG      FW_BOARD_PREFIX FW_BOARD ";"

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

// --- FAILURE HANDLING: QUICK AND FULL ATTEMPTS ---
// A node that cannot reach its hub keeps its normal schedule: it wakes, takes
// its reading, stores it (see STORE AND FORWARD) and tries the hub. What it
// rations is the expensive part of trying.
//
// For the first BACKOFF_AFTER_FAILED_WAKES failures every attempt is a full
// one -- MAX_RETRIES sends, and a channel rescan at the second failure. After
// that the hub counts as down, and attempts split in two:
//   - a QUICK attempt on every wake: one send on the cached channel, no
//     retries, no scan. It costs about what a normal wake does, so an outage
//     costs about what normal running does, and when the hub comes back on
//     its old channel -- the usual case -- readings resume within one interval.
//   - a FULL attempt once per FULL_ATTEMPT_INTERVAL_S: rescan the channel (the
//     hub may have come back on a different one) and the full retries.
//
// This replaced a backoff to 1, 2, 4 and then 6 h between attempts, which kept
// a long outage cheap but left a node silent for up to 6 h after its hub had
// returned. Before that, a "hibernate" waited for a button press outright.
//
// A button press still resets everything and does a full attempt at once.
#define BACKOFF_AFTER_FAILED_WAKES 4      // 4 x 15 min = 1 h of full attempts first
#define FULL_ATTEMPT_INTERVAL_S    3600   // then a full attempt hourly, quick ones between
#define RESCAN_ON_FAILURE_AT_COUNT 2      // rescan once early, before the hub counts as down
                                          // (hub may have moved to a different channel)

// RTC_DATA_ATTR variables persist across deep sleep. Reset on power-on and
// (usually) on brownout — both events look like a fresh start where TX
// should be attempted again, so that's the correct behavior.
RTC_DATA_ATTR uint32_t consecutive_failed_wakes = 0;
RTC_DATA_ATTR uint32_t lastFullAttemptS = 0;   // nowS() of the last full attempt in an outage

// --- STORE AND FORWARD ---
// A reading the hub did not get is kept here and sent on the next contact,
// oldest first, before the current reading. Without it, everything taken while
// the hub was unreachable -- unplugged, rebooting, a power cut -- was lost.
//
// RTC memory, not flash: it survives deep sleep, costs no flash wear, and needs
// no write per wake. A power cycle loses it, as it loses the node's clock that
// the stored times are measured on, so nothing is kept across one (storeInit).
//
// 300 readings is 75 h at a 15 min interval; past that the oldest go first.
// Each is sent with its age, not a time -- the node has no real clock, only one
// that counts from power-on and keeps running through deep sleep. The hub turns
// the age into a time.
#define STORE_MAX     300
#define STORE_MAGIC   0x46445331u   // "1SDF"; anything else means the store is not ours
#define BACKLOG_ACK_MS 100          // the hub answers from its receive callback

typedef struct {
  uint32_t takenS;      // nowS() when taken
  int16_t  temp_c100;   // hundredths of a degree; INT16_MIN = probe error
  uint8_t  battery;
  uint8_t  pad;
} stored_reading;

RTC_DATA_ATTR uint32_t       storeMagic = 0;
RTC_DATA_ATTR uint16_t       storeHead  = 0;   // next write slot
RTC_DATA_ATTR uint16_t       storeCount = 0;
RTC_DATA_ATTR stored_reading store[STORE_MAX];

// --- PAIRING ATTEMPTS ---
// An unpaired node is awake almost the whole time it is asking (a 70 s
// broadcast window, then 10 s asleep), which empties a pack in about two days.
// That is fine while someone is pairing it and wasteful otherwise -- a node
// that was factory-reset, rejected, or put in a drawer with batteries in. So
// after PAIRING_WINDOWS windows (about 5 minutes) it stops and sleeps until the
// button is pressed, which starts a fresh set. A paired node never does this.
#define PAIRING_WINDOW_MS   70000
#define PAIRING_GAP_S       10
#define PAIRING_WINDOWS     4
RTC_DATA_ATTR uint8_t pairing_windows_used = 0;

// A live session is a temporarily shorter sleep interval, not a stretch of
// staying awake. Held in RTC memory so it survives deep sleep but not a power
// cycle -- pulling the battery should not leave a node in a fast-reporting
// state nobody asked for.
// The hub rejects a counter it has already seen, so this must never go
// backwards -- including across a power cycle, which RTC memory does not
// survive. Persisting every message would mean a flash write per wake; instead
// a block of counters is claimed at boot and spent from RAM, costing one write
// per AUTH_CTR_BLOCK wakes. Unspent counters in an interrupted block are simply
// skipped, which is harmless: the rule is that they increase, not that none are
// missed.
#define AUTH_CTR_BLOCK 64
RTC_DATA_ATTR uint32_t authCtrNext  = 0;
RTC_DATA_ATTR uint32_t authCtrLimit = 0;

// What the hub last sent us. RTC memory is right here: it survives sleep, and a
// power cycle resetting it only means the next hub message is accepted on its
// own terms rather than compared to one from before the reset.
RTC_DATA_ATTR uint32_t authHubCtrSeen = 0;

RTC_DATA_ATTR uint16_t liveCyclesLeft = 0;
RTC_DATA_ATTR uint16_t liveIntervalS  = 0;

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
#define CRITICAL_PCT      5  // "CRITICAL" status at or below this %

// Lowest pack voltage at which this node can be running at all. A reading below
// it cannot be the pack -- the node would be off -- so it is a failed read and
// reported as 255. It is the supply's limit, not a battery-health threshold:
// the TPS63802 runs from 1.3 V, so a regulated board keeps reporting real
// percentages down to the table's 0 % at 1.8 V. The fixed 2.5 V floor used to
// apply to every board, which turned the last stretch of a regulated pack --
// the part where a warning matters -- into "read error", and since nothing
// above 2.5 V maps below 22 % the cloud's low-battery alert could never fire.
// Without a regulator the C6 is fed straight from the pack and browns out
// around 2.5 V, so that floor stays.
#if HAS_REGULATOR
#define BAT_MIN_RUNNING_V 1.3f
#else
#define BAT_MIN_RUNNING_V 2.5f
#endif

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

// --- LIVE MODE (hub -> sensor, one shot) ---
// A sleeping node cannot be woken on demand: its radio is off, and listening
// often enough to matter would cost most of the battery. What it can do is stay
// awake a little longer on a wake it was going to have anyway, and report
// repeatedly while it is up.
//
// Deliberately not part of the config message. cfg_ver is a fingerprint of the
// settings, and a transient "stay awake" flag would change it, then need a
// second change to clear it. This is a separate instruction that is acted on
// once and never stored.
// Truncated HMAC-SHA256. 64 bits is ample against forgery when every attempt
// costs a radio round trip. Declared here because the message structs below
// carry it, while the key itself sits with the other ESP-NOW keys.
#define AUTH_TAG_LEN 8

#define MSG_LIVE 10

// Each live reading is a full wake: boot, read, transmit, sleep -- one to two
// seconds of it. Intervals near that spend most of the session on overhead
// rather than on readings, which is what a floor this high is protecting.
#define LIVE_MIN_INTERVAL_S 20
#define LIVE_MAX_DURATION_S 300

typedef struct __attribute__((packed)) {
  uint8_t  msgType;
  uint8_t  pad;
  uint16_t duration_s;
  uint16_t interval_s;
  uint16_t reserved;
  uint32_t auth_ctr;
  uint8_t  auth[AUTH_TAG_LEN];
} live_message;

#define LIVE_BODY_LEN offsetof(live_message, auth_ctr)

static volatile bool     g_liveRequested = false;
static volatile uint16_t g_liveDuration  = 0;
static volatile uint16_t g_liveInterval  = 0;

// --- STORE AND FORWARD (sensor -> hub, then an acknowledgement back) ---
// Byte-for-byte identical on hub and sensor; see the hub for the full notes.
// Acknowledged explicitly because the radio's own ACK only says a frame
// arrived: a hub that does not know this message type would ACK it and drop
// it, and the node would delete readings nobody kept.
#define MSG_BACKLOG       11   // sensor -> hub: readings the hub missed
#define MSG_BACKLOG_ACK   12   // hub -> sensor: those readings are queued
#define BACKLOG_PER_FRAME 24

typedef struct __attribute__((packed)) {
  uint32_t age_s;
  int16_t  temp_c100;
  uint8_t  battery;
  uint8_t  pad;
} backlog_entry;

typedef struct __attribute__((packed)) {
  uint8_t       msgType;
  uint8_t       count;
  uint16_t      cfg_ver;
  uint8_t       fw_major;
  uint8_t       fw_minor;
  uint8_t       fw_patch;
  uint8_t       pad;
  backlog_entry e[BACKLOG_PER_FRAME];   // oldest first
  uint32_t      auth_ctr;
  uint8_t       auth[AUTH_TAG_LEN];
} backlog_message;

#define BACKLOG_BODY_LEN offsetof(backlog_message, auth_ctr)
static_assert(sizeof(backlog_message) <= 250, "must fit an ESP-NOW v1 frame");

typedef struct __attribute__((packed)) {
  uint8_t  msgType;
  uint8_t  count;
  uint16_t pad;
  uint32_t ref_ctr;
  uint32_t auth_ctr;
  uint8_t  auth[AUTH_TAG_LEN];
} backlog_ack_message;

#define BACKLOG_ACK_BODY_LEN offsetof(backlog_ack_message, auth_ctr)

static volatile uint32_t g_backlogAckCtr = 0;   // ref_ctr of the last acknowledgement


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



// --- MESSAGE AUTHENTICATION ---
// ESP-NOW link encryption is not used: it consumes one of the radio's six or
// seven hardware key slots per peer, which caps a hub at seven sensors. Rooms
// with a dozen coolers are ordinary, so authenticity is done here instead, in
// the message, where nothing limits how many nodes there can be.
//
// This buys the property that actually matters for a temperature record: a
// reading the hub accepts came from the sensor it names, was not altered, and
// is not a replay. It deliberately does not hide the reading -- a cooler
// temperature is not a secret, and confidentiality was the cheap half.
//
// Shared across the fleet: anyone who can read one node's flash can forge for
// all of them.
//
// The key lives in secrets/espnow_auth_key.h, which is not in git (template:
// secrets/espnow_auth_key.example.h). Before 1.1.15 it was committed to a
// public repository. Only the new key is accepted here: a hub from 1.1.27 on
// answers each sensor in the key that sensor signs with, so the hub must be
// updated before its sensors are.
#include "espnow_auth_key.h"
static const uint8_t AUTH_KEY[32] = ESPNOW_AUTH_KEY_BYTES;

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

  // Appended, so a hub still accepts the shorter frame an un-updated sensor
  // sends. Everything above is what the tag covers.
  uint32_t auth_ctr;             // strictly increasing; replays do not rise
  uint8_t  auth[AUTH_TAG_LEN];   // HMAC over sender MAC + auth_ctr + the above
} struct_message;

#define AUTH_BODY_LEN (sizeof(struct_message) - sizeof(uint32_t) - AUTH_TAG_LEN)

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

  // Carved out of what was reserved[16], so the frame is the same size it has
  // always been and an un-updated node still parses everything above.
  uint8_t  reserved[4];
  uint32_t auth_ctr;
  uint8_t  auth[AUTH_TAG_LEN];
} config_message;

#define CFG_BODY_LEN offsetof(config_message, auth_ctr)

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

// Set when this wake reached the hub. A wake that did not skips the log burst
// and the config window before sleeping: both talk to a hub that is not there.
static bool g_hubReached = false;

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
  while (!g_configApplied && !g_liveRequested && millis() - start < CFG_WAIT_MS) {
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

// Find the board marker in the image as it streams past, so the check costs
// no second pass over flash. Every image built from this source carries exactly
// one TEMPSENS_BOARD= marker; an image with none predates the marker.
//
// Restarting a failed match at 0 (or 1 on a 'T') is exact for this prefix:
// 'T' occurs only at its start, so no partial match can contain the beginning
// of another.
static const char  OTA_BOARD_PREFIX[] = FW_BOARD_PREFIX;
static const size_t OTA_BOARD_PREFIX_LEN = sizeof(OTA_BOARD_PREFIX) - 1;
static size_t otaBoardMatched;     // prefix bytes matched so far
static bool   otaBoardCapturing;   // prefix complete, reading the value
static char   otaBoardValue[33];
static size_t otaBoardValueLen;
static bool   otaBoardOwn;         // found our own marker
static char   otaBoardOther[33];   // first foreign marker, for the log

static void otaBoardScanReset() {
  otaBoardMatched = 0; otaBoardCapturing = false; otaBoardValueLen = 0;
  otaBoardOwn = false; otaBoardOther[0] = '\0';
}

static void otaBoardScan(const uint8_t *buf, size_t len) {
  for (size_t i = 0; i < len; i++) {
    char c = (char)buf[i];
    if (otaBoardCapturing) {
      if (c == ';') {
        otaBoardValue[otaBoardValueLen] = '\0';
        if (strcmp(otaBoardValue, FW_BOARD) == 0) otaBoardOwn = true;
        else if (!otaBoardOther[0]) strcpy(otaBoardOther, otaBoardValue);
        otaBoardCapturing = false;
      } else if (otaBoardValueLen < sizeof(otaBoardValue) - 1 && c >= 0x21 && c <= 0x7E) {
        otaBoardValue[otaBoardValueLen++] = c;
        continue;
      } else {
        otaBoardCapturing = false;   // not a marker after all
      }
      otaBoardMatched = 0;
    }
    if (c == OTA_BOARD_PREFIX[otaBoardMatched]) {
      if (++otaBoardMatched == OTA_BOARD_PREFIX_LEN) {
        otaBoardCapturing = true;
        otaBoardValueLen  = 0;
        otaBoardMatched   = 0;
      }
    } else {
      otaBoardMatched = (c == OTA_BOARD_PREFIX[0]) ? 1 : 0;
    }
  }
}

static void otaSendReq(uint8_t accept, uint8_t reason) {
  ota_req_message m = { MSG_OTA_REQ, accept, reason, 0 };
  esp_now_send(hubMac, (uint8_t *)&m, sizeof(m));
}

static void otaSendAck(uint8_t status, uint16_t nextSeq) {
  ota_ack_message m = { MSG_OTA_ACK, status, nextSeq };
  esp_now_send(hubMac, (uint8_t *)&m, sizeof(m));
}

// Sent more than once on purpose. Chunks are acknowledged and so recover from
// a loss, but the result is the last thing said before the node reboots -- if
// that single frame drops, a transfer that installed correctly looks to the hub
// like one that died at 99%. Duplicates are harmless; the hub reads the first.
static void otaSendDone(uint8_t result) {
  ota_done_message m = { MSG_OTA_DONE, result, {0, 0} };
  for (int i = 0; i < 3; i++) {
    esp_now_send(hubMac, (uint8_t *)&m, sizeof(m));
    delay(80);
  }
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
  otaBoardScanReset();
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
    otaBoardScan(otaRxBuf, len);
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
    // Signed is not the same as meant for this board: every board's image is
    // signed with the same key. An image with no marker at all predates this
    // check and is refused too -- it is older firmware, and nothing can say
    // which board it was built for.
    else if (!otaBoardOwn) {
      result = OTA_RESULT_WRONG_IMAGE;
      if (otaBoardOther[0]) ulog("[OTA] Rejected: image is for %s, this board is %s\n", otaBoardOther, FW_BOARD);
      else                  ulog("[OTA] Rejected: image has no board marker (built before 1.1.13)\n");
    }
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


bool        readSensor();
BatteryInfo getBatteryInfo();
bool        sendDataWithRetry(int tries = MAX_RETRIES);

// Schedule a live session. The node does not stay awake for it: it sleeps
// between readings exactly as it always does, just for less time. Five minutes
// spent awake costs about 3.3 mAh; the same five minutes as ten short wakes
// costs about 0.4 mAh, and the readings arrive on the same cadence either way.
static void applyLiveRequest() {
  g_liveRequested = false;
  uint16_t dur = g_liveDuration;
  uint16_t iv  = g_liveInterval;

  if (dur == 0) {                       // stop
    if (liveCyclesLeft) ulog("[LIVE] Stopped by request\n");
    liveCyclesLeft = 0;
    return;
  }
  if (dur > LIVE_MAX_DURATION_S) dur = LIVE_MAX_DURATION_S;
  if (iv  < LIVE_MIN_INTERVAL_S) iv  = LIVE_MIN_INTERVAL_S;

  liveIntervalS  = iv;
  liveCyclesLeft = dur / iv;
  if (liveCyclesLeft == 0) liveCyclesLeft = 1;
  ulog("[LIVE] %u reading%s, one every %us\n",
       liveCyclesLeft, liveCyclesLeft == 1 ? "" : "s", iv);
}

// --- SAFE DEEP SLEEP ---
// ESP32-C6 RISC-V requires proper WiFi/ESP-NOW shutdown before sleep
// Skipping this causes the illegal instruction crash (MCAUSE: 0x18)
// Tag = first AUTH_TAG_LEN bytes of HMAC-SHA256(key, mac || ctr || body).
// The MAC is covered so a frame cannot be replayed as if from another node.
static void authTag(const uint8_t *mac, uint32_t ctr,
                    const uint8_t *body, size_t bodyLen, uint8_t out[AUTH_TAG_LEN]) {
  uint8_t full[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, AUTH_KEY, sizeof(AUTH_KEY));
  mbedtls_md_hmac_update(&ctx, mac, 6);
  mbedtls_md_hmac_update(&ctx, (const uint8_t *)&ctr, sizeof(ctr));
  mbedtls_md_hmac_update(&ctx, body, bodyLen);
  mbedtls_md_hmac_finish(&ctx, full);
  mbedtls_md_free(&ctx);
  memcpy(out, full, AUTH_TAG_LEN);
}

// Compared without an early exit, so the time taken says nothing about how much
// of a wrong tag was right.
static bool authTagEqual(const uint8_t *a, const uint8_t *b) {
  uint8_t diff = 0;
  for (size_t i = 0; i < AUTH_TAG_LEN; i++) diff |= (uint8_t)(a[i] ^ b[i]);
  return diff == 0;
}

// Claim the next counter, taking a fresh block from NVS when the current one is
// spent.
static uint32_t authNextCtr() {
  if (authCtrNext >= authCtrLimit) {
    Preferences p;
    p.begin("auth", false);
    uint32_t base = p.getUInt("ctr", 0);
    if (base < authCtrLimit) base = authCtrLimit;   // never reuse after a reboot
    p.putUInt("ctr", base + AUTH_CTR_BLOCK);
    p.end();
    authCtrNext  = base;
    authCtrLimit = base + AUTH_CTR_BLOCK;
  }
  return authCtrNext++;
}

// Verify a frame the hub sent us. Rejects a tag that does not match, and a
// counter that has been seen -- an attacker replaying an old config would
// otherwise be able to put a node back onto calibration it has moved off.
static bool authCheckFromHub(const uint8_t *hubAddr, uint32_t ctr,
                             const uint8_t *body, size_t bodyLen,
                             const uint8_t *tag) {
  uint8_t expect[AUTH_TAG_LEN];
  authTag(hubAddr, ctr, body, bodyLen, expect);
  if (!authTagEqual(expect, tag)) {
    ulog("[AUTH] Rejected a frame with a bad tag\n");
    return false;
  }
  if (ctr <= authHubCtrSeen) {
    ulog("[AUTH] Rejected a replayed frame (ctr %u)\n", (unsigned)ctr);
    return false;
  }
  authHubCtrSeen = ctr;
  return true;
}

void goToSleep(int seconds) {
  Serial.printf("Sleeping for %d seconds...\n\n", seconds);
  Serial.flush();         // Ensure serial output completes

  // Both talk to the hub. A paired node that could not reach it this wake --
  // every quick attempt during an outage -- skips them rather than sending a
  // log nobody receives and listening for a config nobody sends.
  if (!isPaired || g_hubReached) {
    sendLogToHub();       // Ship the wake-cycle log to the hub via ESP-NOW
    waitForConfig();      // Brief window for a config or live request
  }

  // Handled here, with the radio still up, so live mode costs no extra
  // listening on a wake where nobody asked for it.
  if (g_liveRequested) applyLiveRequest();

  // A live session shortens the next sleep rather than replacing it. Counted
  // down here so a session that is interrupted -- flat battery, hub gone --
  // expires on its own instead of leaving the node reporting fast forever.
  if (liveCyclesLeft > 0 && liveIntervalS >= LIVE_MIN_INTERVAL_S) {
    liveCyclesLeft--;
    seconds = liveIntervalS;
    Serial.printf("[LIVE] %u reading%s left after this one\n",
                  liveCyclesLeft, liveCyclesLeft == 1 ? "" : "s");
  }
  esp_now_deinit();       // Then deinit ESP-NOW
  esp_wifi_stop();        // Stop WiFi radio
  delay(100);             // Allow shutdown to settle

  esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
  // D0 (GPIO0) is an LP GPIO — supports deep sleep GPIO wakeup.
  // Pressing the button wakes the device early for factory reset or manual data send.
  esp_deep_sleep_enable_gpio_wakeup(1ULL << RESET_PIN, ESP_GPIO_WAKEUP_GPIO_LOW);
  esp_deep_sleep_start(); // Step 4: Sleep
}

// --- BUTTON-ONLY SLEEP ---
// No timer wake: only a press on D0 brings the node back. Used solely by an
// unpaired node that has given up asking (see enterPairingMode) -- never by a
// paired one, which must always come back on its own.
void goToButtonOnlySleep() {
  Serial.flush();
  esp_now_deinit();
  esp_wifi_stop();
  delay(100);
  esp_deep_sleep_enable_gpio_wakeup(1ULL << RESET_PIN, ESP_GPIO_WAKEUP_GPIO_LOW);
  esp_deep_sleep_start();
}

// --- STORE AND FORWARD ---
// Seconds since power-on. The system clock keeps running through deep sleep and
// is never set on a sensor, so this is a monotonic count the stored readings'
// ages are measured against.
static uint32_t nowS() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (uint32_t)tv.tv_sec;
}

// Keep the store only across a deep-sleep wake. After any other reset -- power
// on, brownout, a restart, booting a new image -- the clock it was measured on
// may have restarted, and RTC memory may not be what this image laid out.
static void storeInit() {
  bool keep = esp_reset_reason() == ESP_RST_DEEPSLEEP && storeMagic == STORE_MAGIC &&
              storeCount <= STORE_MAX && storeHead < STORE_MAX;
  if (!keep) {
    storeMagic       = STORE_MAGIC;
    storeHead        = 0;
    storeCount       = 0;
    lastFullAttemptS = 0;
  }
}

static void storePush(float temp, uint8_t battery) {
  stored_reading &r = store[storeHead];
  r.takenS    = nowS();
  r.temp_c100 = (temp == -999) ? INT16_MIN : (int16_t)lroundf(temp * 100.0f);
  r.battery   = battery;
  r.pad       = 0;
  storeHead = (storeHead + 1) % STORE_MAX;
  if (storeCount < STORE_MAX) storeCount++;   // full: the oldest is overwritten
}

static const stored_reading &storeOldest(uint16_t i) {   // i-th oldest
  return store[(storeHead + STORE_MAX - storeCount + i) % STORE_MAX];
}

enum BacklogResult { BL_DONE, BL_NO_HUB, BL_NO_ACK };

// Send the stored readings, oldest first, BACKLOG_PER_FRAME at a time. Each
// frame is deleted only once the hub has acknowledged it.
//
//   BL_DONE    everything delivered (or nothing was stored)
//   BL_NO_HUB  the radio could not reach the hub at all
//   BL_NO_ACK  the hub is there but did not acknowledge -- firmware that does
//              not know store-and-forward, or a hub that does not know this
//              node. The readings stay; the current one is still sent, so a
//              node ahead of its hub keeps reporting live.
static BacklogResult deliverBacklog(int tries) {
  while (storeCount > 0) {
    backlog_message m = {};
    m.msgType  = MSG_BACKLOG;
    m.cfg_ver  = g_cfg_ver;
    m.fw_major = FW_MAJOR;
    m.fw_minor = FW_MINOR;
    m.fw_patch = FW_PATCH;
    uint16_t n = storeCount > BACKLOG_PER_FRAME ? BACKLOG_PER_FRAME : storeCount;
    m.count = (uint8_t)n;
    uint32_t now = nowS();
    for (uint16_t i = 0; i < n; i++) {
      const stored_reading &r = storeOldest(i);
      m.e[i].age_s     = now >= r.takenS ? now - r.takenS : 0;
      m.e[i].temp_c100 = r.temp_c100;
      m.e[i].battery   = r.battery;
    }
    // One counter for the frame and all its resends, as for readings: the hub
    // recognises a resend by it and acknowledges again without queueing twice.
    m.auth_ctr = authNextCtr();
    {
      uint8_t self[6];
      WiFi.macAddress(self);
      authTag(self, m.auth_ctr, (const uint8_t *)&m, BACKLOG_BODY_LEN, m.auth);
    }

    bool reached = false, acked = false;
    for (int t = 0; t < tries && !acked; t++) {
      tx_complete = false;
      tx_success  = false;
      if (esp_now_send(hubMac, (const uint8_t *)&m, sizeof(m)) != ESP_OK) {
        delay(RETRY_DELAY_MS);
        continue;
      }
      unsigned long start = millis();
      while (!tx_complete && millis() - start < TX_TIMEOUT_MS) delay(2);
      if (!tx_success) { delay(RETRY_DELAY_MS); continue; }

      reached = true;
      start = millis();
      while (g_backlogAckCtr != m.auth_ctr && millis() - start < BACKLOG_ACK_MS) delay(2);
      acked = (g_backlogAckCtr == m.auth_ctr);
      if (!acked) break;   // it heard us and said nothing; resending will not change that
    }
    if (!acked) {
      ulog("[STORE] %s - keeping %u reading(s)\n",
           reached ? "Hub did not acknowledge" : "Hub not reached", storeCount);
      return reached ? BL_NO_ACK : BL_NO_HUB;
    }
    storeCount -= n;
    ulog("[STORE] Delivered %u stored reading(s), %u left\n", n, storeCount);
  }
  return BL_DONE;
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

    // Checked before anything is validated or stored: a forged config is a way
    // to corrupt readings at their source, which no amount of downstream
    // checking would catch.
    if (!authCheckFromHub(esp_now_info->src_addr, cfg->auth_ctr,
                          incomingData, CFG_BODY_LEN, cfg->auth)) return;

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

  if (incomingData[0] == MSG_LIVE && len >= (int)sizeof(live_message)) {
    const live_message *lm = (const live_message *)incomingData;
    if (!authCheckFromHub(esp_now_info->src_addr, lm->auth_ctr,
                          incomingData, LIVE_BODY_LEN, lm->auth)) return;
    g_liveDuration  = lm->duration_s;
    g_liveInterval  = lm->interval_s;
    g_liveRequested = true;
    return;
  }

  if (incomingData[0] == MSG_BACKLOG_ACK && len >= (int)sizeof(backlog_ack_message)) {
    const backlog_ack_message *a = (const backlog_ack_message *)incomingData;
    // Authenticated like any hub frame: a forged acknowledgement would make
    // the node delete readings the hub never kept.
    if (!authCheckFromHub(esp_now_info->src_addr, a->auth_ctr,
                          incomingData, BACKLOG_ACK_BODY_LEN, a->auth)) return;
    g_backlogAckCtr = a->ref_ctr;
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

  // A pairing reply means something only while this node is asking for one.
  // Acting on it at any other time let a single forged frame, sent in the
  // listening window after a reading, overwrite the stored hub, restart the
  // node, and leave it transmitting to a hub that does not exist. Leaving
  // pairing is a deliberate act: a 3 s button hold.
  if (msg->msgType == MSG_PAIRING && isPaired) {
    ulog("[PAIR] Ignored a pairing frame - already paired\n");
    return;
  }

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
  if (voltage < BAT_MIN_RUNNING_V) {
    pct = 255;   // the node could not be running: the divider read failed
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
bool sendDataWithRetry(int tries) {
#ifdef OTA_ROLLBACK_TEST
  // Built deliberately broken, to prove the rollback path works. The node boots
  // and behaves normally in every other way -- it simply never delivers a
  // reading, which is the one thing that marks an image good. Three boots later
  // it should revert on its own.
  ulog("[TEST] Rollback build - not transmitting\n");
  return false;
#endif
  // One counter and one tag for the whole attempt, not one per retry: a retry
  // is the same reading said again, and the hub's duplicate filter needs them
  // to look identical.
  myData.auth_ctr = authNextCtr();
  {
    uint8_t self[6];
    WiFi.macAddress(self);
    authTag(self, myData.auth_ctr, (const uint8_t *)&myData, AUTH_BODY_LEN, myData.auth);
  }

  for (int retry = 0; retry < tries; retry++) {
    tx_complete = false;
    tx_success  = false;

    esp_err_t result = esp_now_send(hubMac, (uint8_t *)&myData, sizeof(myData));

    if (result != ESP_OK) {
      Serial.printf("✗ Send error: 0x%X  Retry %d/%d\n", result, retry+1, tries);
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
      retry+1, tries);
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

  pairing_windows_used++;
  Serial.printf("Waiting for hub (window %u of %u)", pairing_windows_used, PAIRING_WINDOWS);
  unsigned long startWait    = millis();
  unsigned long lastBroadcast = 0;
  while (millis() - startWait < PAIRING_WINDOW_MS) {
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
  if (pairing_windows_used >= PAIRING_WINDOWS) {
    Serial.println("✗ No hub answered. Sleeping until the button is pressed.");
    pairing_windows_used = 0;   // a press starts a fresh set
    goToButtonOnlySleep();      // Does not return.
  }
  Serial.printf("✗ Timeout. Retrying in %ds...\n", PAIRING_GAP_S);
  goToSleep(PAIRING_GAP_S);
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
#if BOARD_REV == 1
  delay(500); // USB-CDC on the XIAO needs time to enumerate before output shows
#endif
  // v2 logs over a plain UART (ESP-PROG), which needs no settling: the 500 ms
  // was a USB-CDC wait, spent on every wake of a board that has no USB.
  ulog("\n=== XIAO ESP32-C6 Sensor (NTC Probe) ===\n");
  Serial.println(FW_VERSION_TAG);
  Serial.println(FW_BOARD_TAG);

  // If the previous boot ended in a brownout (radio TX pulled VCC below the
  // ESP32-C6's brownout threshold), do NOT try to TX again immediately. That
  // creates a tight boot→TX→brownout→reset loop that drains the battery in
  // hours instead of months. Just sleep the normal interval and let the
  // battery rest / warm up before trying again.
  esp_reset_reason_t reset_reason = esp_reset_reason();
  ulog("Reset reason: %d\n", (int)reset_reason);
  storeInit();   // first: a brownout below returns early, and must clear it
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
  // Also resets the failure counter, ending any backoff: a button press is an
  // explicit user action, not a background retry, so it tries straight away.
  bool force_rescan_this_cycle = false;

  if (wakeup_reason == ESP_SLEEP_WAKEUP_GPIO) {
    ulog("Button-press wake — resetting failure counter + forcing channel rescan\n");
    consecutive_failed_wakes = 0;
    pairing_windows_used = 0;   // an unpaired node gets a full set of windows again
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
  // There used to be a "battery critical: sleep without transmitting" branch
  // here. It could never trigger while the 2.5 V floor mapped every low
  // reading to 255, and with real percentages it would have silenced a node at
  // 5 % -- turning a flat battery into an unexplained "offline". A primary
  // lithium pack needs no protecting from a few more readings, and a brownout
  // under TX is already caught at the top of setup().
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

  // Quick or full attempt (see FAILURE HANDLING). Until the hub counts as down
  // every attempt is full; after that, one per FULL_ATTEMPT_INTERVAL_S is.
  uint32_t nowSec      = nowS();
  bool     outage      = isPaired && consecutive_failed_wakes >= BACKOFF_AFTER_FAILED_WAKES;
  bool     fullAttempt = !outage || force_rescan_this_cycle ||
                         nowSec - lastFullAttemptS >= FULL_ATTEMPT_INTERVAL_S;
  if (outage && fullAttempt) lastFullAttemptS = nowSec;
  int      tries       = fullAttempt ? MAX_RETRIES : 1;
  if (outage) ulog("[TX] Hub down - %s attempt, %u stored\n",
                   fullAttempt ? "full" : "quick", storeCount);

  bool scanned_this_wake = false;
  {
    preferences.begin("network", true);
    uint8_t ch = (uint8_t)preferences.getUChar("channel", 0);
    preferences.end();

    // Rescan the WiFi channel when:
    //   1. Nothing cached yet (first boot / after factory reset), OR
    //   2. We woke via a D0 button press (user wants a fresh attempt; the
    //      cached channel may be stale — hub may have moved to a different
    //      channel since the last successful TX), OR
    //   3. This is the hourly full attempt during an outage: the hub has been
    //      unreachable for an hour or more, and coming back on a different
    //      channel is a likely reason. Once an hour, the scan costs little.
    // Otherwise use the cached value to save the ~1.5 s scan energy cost --
    // including on every quick attempt.
    if (ch == 0 || force_rescan_this_cycle || (outage && fullAttempt)) {
      const char *why = (ch == 0) ? "no cached channel"
                      : force_rescan_this_cycle ? "button-press wake" : "hourly full attempt";
      scanned_this_wake = true;
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
  esp_now_register_send_cb(OnDataSent);
  esp_now_register_recv_cb(OnDataRecv);
  Serial.println("✓ ESP-NOW ready (authenticated messages)");

  if (isPaired) {
    Serial.println("\n--- Data Mode ---");

    memcpy(peerInfo.peer_addr, hubMac, 6);
    peerInfo.channel = ESPNOW_CHANNEL;
    // Unencrypted by design -- authenticity is carried in the message, not the
    // link, so that a hub is not limited to seven sensors by the radio's key
    // slots. See AUTH_KEY.
    peerInfo.encrypt = false;

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
    //
    // Only after a scan, which is what drained them. It used to run on every
    // wake: half a second with the radio up, on the ~96 timer wakes a day that
    // never scan.
    if (scanned_this_wake) delay(500);

    // Stored readings first, oldest first, then the current one: the cloud
    // evaluates alarms in the order readings arrive. If the stored ones cannot
    // reach the hub at all, neither will this one -- do not spend the retries.
    auto attempt = [&](int n) -> bool {
      BacklogResult bl = storeCount ? deliverBacklog(n) : BL_DONE;
      if (bl == BL_NO_HUB) return false;
      g_hubReached = true;   // the backlog got through, or at least was heard
      return sendDataWithRetry(n);
    };

    bool tx_ok = attempt(tries);
    if (tx_ok) g_hubReached = true;

    if (tx_ok) {
      // Success — clear failure state.
      if (consecutive_failed_wakes > 0) {
        ulog("✓ Connectivity restored (cleared %u failure%s)\n",
             consecutive_failed_wakes, consecutive_failed_wakes == 1 ? "" : "s");
      }
      consecutive_failed_wakes = 0;
      otaConfirmImage();   // a delivered reading is what proves an image good

      // A button press asks for an update; so does a live session, which is
      // someone watching this node right now and contacting the hub every
      // half minute. Ordinary timer wakes still never listen, so the duty
      // cycle of a node nobody is looking at is unchanged.
      if (force_rescan_this_cycle || liveCyclesLeft > 0) otaMaybeUpdate(bat.percentage);

    } else {
      // Failure — bump the counter (RTC memory, persists across sleep).
      consecutive_failed_wakes++;
      ulog("✗ TX failed. Consecutive failures: %u\n", consecutive_failed_wakes);

      // One early rescan, in case the hub moved to a different WiFi channel
      // (router reboot etc.). Once the hub counts as down, the hourly full
      // attempt rescans before it transmits instead (see the channel block).
      if (consecutive_failed_wakes == RESCAN_ON_FAILURE_AT_COUNT) {
        ulog("Trying channel rescan (hub may have moved channels)...\n");
        uint8_t new_ch = detectWiFiChannel();
        preferences.begin("network", false);
        preferences.putUChar("channel", new_ch);
        preferences.end();
        esp_wifi_set_channel(new_ch, WIFI_SECOND_CHAN_NONE);
        if (attempt(MAX_RETRIES)) {
          ulog("✓ TX succeeded after rescan — clearing failure counter\n");
          tx_ok = true;
          g_hubReached = true;
          consecutive_failed_wakes = 0;
          otaConfirmImage();
        }
      }

      if (!tx_ok) {
        // Kept for the next contact rather than lost.
        storePush(myData.temp, myData.battery);
        ulog("[STORE] Kept this reading - %u stored\n", storeCount);

        if (consecutive_failed_wakes >= BACKOFF_AFTER_FAILED_WAKES) {
          // A live session would override the sleep below with its short
          // interval. Nobody is getting live readings from a node that cannot
          // reach its hub, so end it.
          liveCyclesLeft = 0;
        }
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
