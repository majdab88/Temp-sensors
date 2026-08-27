#include <Arduino.h>

// Requires NimBLE-Arduino v2.x (h2zero/NimBLE-Arduino)
// Install via Arduino Library Manager. v1.x has different callback signatures.
#include <NimBLEDevice.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>     // TLS socket for MQTT
#include <PubSubClient.h>         // MQTT client (knolleary/pubsubclient)
#include <esp_now.h>
#include <esp_wifi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <ESPmDNS.h>
#include "time.h"
#include <HTTPClient.h>           // OTA image download
#include <esp_ota_ops.h>          // OTA partition write + rollback state
#include <mbedtls/md.h>           // SHA-256 over the downloaded image
#include <mbedtls/pk.h>           // ECDSA P-256 signature verification
#include <mbedtls/base64.h>

// --- FORWARD DECLARATIONS ---
// Required because PlatformIO/C++ does not auto-generate these like the Arduino IDE.
void loadCloudConfig();
void buildTopics();
bool connectCloud();
void publishSensorData(int idx);
void applySyncFromCloud(const String& json);
void removeSensorByMac(const uint8_t* mac);
void sanitizeName(char* name, size_t maxLen);
struct log_message;
void handleLogChunk(const uint8_t* mac, const log_message* msg);
int  findSensor(const uint8_t* mac);
void publishOtaStatus(const char* state, int pct, const char* err);
void offerSensorOta(const uint8_t* mac);
bool buildSensorOtaOffer(int slot, const char* version, const char* url,
                         const char* sha, const char* sigB64);
void streamImageToSensor(const uint8_t* mac, uint32_t imageSize, uint16_t chunkSize);
void publishSensorOtaStatus(const char* state, int pct, const char* err);
void publishLiveState(const uint8_t* mac, uint16_t durationS, uint16_t intervalS);
static bool hexToDigest(const char* hex, uint8_t* out);
void saveSensorConfig(int idx);
void loadSensorConfig(int idx);
void publishConfigState(int idx);
void pushConfigIfPending(int idx, const uint8_t* mac);
float jsonGetFloat(const String& json, const String& key);
void saveOfflineBuffer();
void loadOfflineBuffer();
void performOtaUpdate();
void checkOtaPendingVerify();
void confirmFirmwareValid();

// --- FIRMWARE VERSION ---
// Reported to the cloud in the retained status payload. Bump on every release;
// the cloud uses it to decide whether an OTA image should be offered.
// Overridable from platformio.ini so a test build can carry its own version
// without editing this file (see the rollbacktest env).
#ifndef FW_MAJOR
#define FW_MAJOR 1
#endif
#ifndef FW_MINOR
#define FW_MINOR 1
#endif
#ifndef FW_PATCH
#define FW_PATCH 13
#endif
#define STR_(x) #x
#define STR(x)  STR_(x)
#define FW_VERSION STR(FW_MAJOR) "." STR(FW_MINOR) "." STR(FW_PATCH)

// Greppable marker so the backend can check that an uploaded image really is
// the version it is being labelled as. esp_app_desc_t cannot be used for this:
// under Arduino it carries the core's own build info (arduino-lib-builder),
// not ours. Printed at boot so the linker cannot discard it.
#define FW_VERSION_TAG "TEMPHUB_FW=" FW_VERSION

// --- OTA IMAGE SIGNING KEY ---
// The hub downloads images over an unauthenticated connection, so this key is
// the only thing preventing an attacker-supplied image from being flashed. The
// image is verified before the new slot is ever made bootable.
//
// This is the PUBLIC half only — it can verify signatures, never create them,
// so it is safe in git and safe to extract from a hub. The matching private key
// lives only on the dev machine; if it is lost, these hubs can never be updated
// over the air again. Rotating it means shipping the new key in an image signed
// with the OLD one first, or the fleet is stranded.
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

// --- OTA STATE ---
// The MQTT callback only records the command; the download runs from loop() so
// it never blocks PubSubClient's own receive path.
static bool  otaRequested   = false;
static char  otaUrl[192]    = "";
static char  otaVersion[16] = "";
static char  otaSha256[65]  = "";   // 64 hex chars + NUL
static char  otaSigB64[160] = "";   // base64 DER ECDSA signature
static bool  otaInProgress  = false;

// True when this boot is running an image the bootloader has not yet been told
// is good. If we reboot again without confirming, it rolls back automatically.
static bool  otaPendingVerify = false;

// Ensures the terminal OTA status is published once per boot, not on every
// MQTT reconnect.
static bool  otaStatusSettled = false;

// --- APP-LEVEL ROLLBACK ---
// Measured on real hardware: after esp_ota_set_boot_partition() the image comes
// up VALID, not PENDING_VERIFY, so the bootloader never arms its own rollback
// despite CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE being set in the framework's
// sdkconfig.h. Without the scheme below, an image that boots but cannot reach
// the cloud would stick forever and need a USB visit to recover.
//
// Instead: performOtaUpdate() marks the update unconfirmed in NVS before
// rebooting. Each boot of an unconfirmed image increments a counter; reaching
// WiFi + MQTT + a successful publish clears it. If the image cannot do that
// within OTA_VERIFY_WINDOW_MS the hub reboots itself, and after
// OTA_MAX_BOOT_TRIES attempts it switches back to the other slot.
#define OTA_MAX_BOOT_TRIES    3
#define OTA_VERIFY_WINDOW_MS  300000UL   // 5 min per attempt → ~15 min to revert

static bool          otaUnconfirmed   = false;  // this boot is an unproven image
static unsigned long otaVerifyDeadline = 0;

// Image state the bootloader handed us, as a name. Published in the retained
// status payload so whether rollback is actually armed is visible from the
// dashboard rather than only over a serial cable.
static char  otaBootStateName[16] = "unknown";

// Version this hub last gave up on and rolled back from. Persisted in NVS so
// "I already tried this and it failed" survives a reboot, and so a retained
// command cannot hand the same bad image straight back after a rollback.
static char  otaRejectedVersion[16] = "";

#define OTA_HTTP_TIMEOUT_MS 20000
#define OTA_BUF_SIZE        1024

// --- SENSOR OTA RELAY STATE ---
// Declared here because the MQTT callback stages a transfer long before the
// relay functions further down are defined.
// Subject of the next status message. Set when an image is staged and again
// when one is offered, so the many publish sites do not each have to carry it.
static uint8_t  sOtaMac[6];
static char     sOtaVersion[16] = "";
static bool     sOtaRunning = false;

// Set by the ESP-NOW callback when a sensor reports in; acted on from loop().
static volatile bool otaOfferWanted = false;
static volatile unsigned long otaOfferSentAt = 0;
static uint8_t       otaOfferMac[6];

// Set from the ESP-NOW callback while a transfer is in flight.
static volatile bool     sOtaReqReady   = false;
static volatile uint8_t  sOtaReqAccept  = 0;
static volatile uint8_t  sOtaReqReason  = 0;
static volatile bool     sOtaAckReady   = false;
static volatile uint8_t  sOtaAckStatus  = 0;
static volatile uint16_t sOtaAckNext    = 0;
static volatile bool     sOtaDoneReady  = false;
static volatile uint8_t  sOtaDoneResult = 0;


// --- XIAO ESP32-C6 PIN DEFINITIONS ---
#define TRIGGER_PIN     9   // On-module BOOT button
#define TRIGGER_PIN_EXT 0   // External reset/provision button on D0 (GPIO0)
#define LED_PIN         15  // Built-in LED

// Either button drives the same reset/re-provision path. Both are active-low
// with internal pullups; GPIO0 is not a strap pin, so an external button stuck
// closed at power-up cannot force the C6 into serial download mode the way a
// held BOOT button on GPIO9 would.
static inline bool resetButtonHeld() {
  return digitalRead(TRIGGER_PIN) == LOW || digitalRead(TRIGGER_PIN_EXT) == LOW;
}

// --- MESSAGE TYPES ---
#define MSG_PAIRING 1
#define MSG_DATA    2
#define MSG_LOG     3   // Sensor → hub remote log (chunked text)
#define MSG_CONFIG  4   // Hub → sensor: new configuration

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
// Kept out of the config message on purpose: cfg_ver is a fingerprint of the
// settings, and a transient flag would change it and then need a second change
// to clear. This is acted on once and never stored.
#define MSG_LIVE 10

typedef struct __attribute__((packed)) {
  uint8_t  msgType;
  uint8_t  pad;
  uint16_t duration_s;
  uint16_t interval_s;
  uint16_t reserved;
} live_message;

// One request at a time, delivered on the sensor's next contact of any kind --
// unlike firmware, which needs a button press, because this only asks the node
// to stay awake rather than to rewrite itself.
static bool     liveePending = false;
static uint8_t  livePendingMac[6];
static uint16_t liveDuration = 0;
static uint16_t liveInterval = 0;

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

// One staged image per sensor, not one for the whole hub. Staging is a
// per-sensor act -- each node takes its image when its own button is pressed --
// so a single slot meant staging a second sensor silently discarded the first,
// while the dashboard, which tracks this per sensor, still showed it waiting.
//
// The offer frame is built at staging time rather than when the sensor appears.
// Sizing the image needs an HTTP round trip, and the node listens for only a
// few hundred milliseconds after transmitting -- long enough to receive a frame
// that is already prepared, nowhere near long enough to fetch one first.
#define SOTA_MAX_STAGED 10   // kept equal to MAX_SENSORS, asserted below

struct StagedImage {
  bool              used;
  uint8_t           mac[6];
  char              version[16];
  char              url[192];
  ota_offer_message offer;
};
static StagedImage sOtaStaged[SOTA_MAX_STAGED];
static int         sOtaActive = -1;   // slot being offered or transferred

static int sOtaSlotFor(const uint8_t *mac) {
  for (int i = 0; i < SOTA_MAX_STAGED; i++)
    if (sOtaStaged[i].used && memcmp(sOtaStaged[i].mac, mac, 6) == 0) return i;
  return -1;
}

// Re-staging a sensor replaces its own slot rather than taking a second one.
static int sOtaSlotClaim(const uint8_t *mac) {
  int i = sOtaSlotFor(mac);
  if (i >= 0) return i;
  for (i = 0; i < SOTA_MAX_STAGED; i++) if (!sOtaStaged[i].used) return i;
  return -1;
}

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


// --- REMOTE LOG STORAGE ---
#define LOG_BUF_SIZE     1024  // bytes of log retained per sensor (latest only)
#define LOG_CHUNK_DATA    240  // payload per ESP-NOW packet (must match sensor)

// --- ESP-NOW ENCRYPTION ---
// IMPORTANT: Change both keys to your own secret values before deploying.
// Keys must be identical on the hub and all sensors.
static const uint8_t PMK_KEY[16] = {
  0x4A, 0x2F, 0x8C, 0x1E, 0x7B, 0x3D, 0x9A, 0x5F,
  0x6E, 0x2C, 0x4B, 0x8D, 0x1A, 0x7F, 0x3E, 0x9C
};
static const uint8_t LMK_KEY[16] = {
  0xE3, 0x4A, 0x7C, 0x91, 0xB5, 0x2D, 0xF8, 0x6E,
  0x1A, 0x9F, 0x3C, 0x72, 0xD4, 0x5B, 0x8E, 0x20
};

// --- BLE GATT UUIDs (must match ble-provision.html) ---
#define PROV_SERVICE_UUID  "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define PROV_CHAR_WIFI     "beb5483e-36e1-4688-b7f5-ea07361b26a8"  // Write: {ssid,pass}
#define PROV_CHAR_CLOUD    "1c95d5e3-d8f7-413a-bf3d-7a2e5d7be87e"  // Write: {host,port,user,pass}
#define PROV_CHAR_STATUS   "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  // Read+Notify: {state,detail}
#define PROV_CHAR_NETWORKS "d5913036-2d8a-41ee-85b9-4e361aa5c8a3"  // Write=scan trigger, Notify=results
#define PROV_CHAR_INFO     "a9b12301-bc5d-4e8a-9c23-c5d1b3f4a5e6"  // Read: {mac} — auto-detected by setup page

// --- TIMEOUTS ---
#define WIFI_CONNECT_TIMEOUT_MS 30000  // ms to wait for WiFi after credentials received

// --- NTP CONFIGURATION ---
const char*         ntpServer          = "pool.ntp.org";
const long          gmtOffset_sec      = 7200;
const int           daylightOffset_sec = 3600;
const unsigned long NTP_SYNC_INTERVAL  = 86400000;  // 24 h

bool          timeConfigured = false;
unsigned long lastNtpSync    = 0;

// --- MESSAGE STRUCTURE (must be byte-for-byte identical on hub and all sensors) ---
// New fields are appended only. Sensors running pre-1.0 firmware send just the
// legacy prefix, so OnDataRecv accepts either length and zero-fills the rest —
// a sensor that reports fw 0.0.0 / cfg_ver 0 simply has not been updated yet.
typedef struct struct_message {
  uint8_t  msgType;
  float    temp;
  float    hum;
  uint8_t  battery;   // 0–100 %; 255 = read error
  uint8_t  fw_major;  // sensor firmware version; 0.0.0 = pre-1.0 sensor
  uint8_t  fw_minor;
  uint8_t  fw_patch;
  uint16_t cfg_ver;   // config version currently applied on the sensor; 0 = defaults
} struct_message;

// Wire layout of the pre-1.0 message, kept only to compute the minimum
// acceptable packet length. Do not use for anything else.
// Verified sizes on riscv32: legacy = 16 bytes, current = 20 bytes.
typedef struct legacy_message {
  uint8_t msgType;
  float   temp;
  float   hum;
  uint8_t battery;
} legacy_message;

// Appending must never disturb the legacy prefix — if this fires, the wire
// format has silently broken compatibility with deployed sensors.
static_assert(offsetof(struct_message, temp)    == offsetof(legacy_message, temp),    "wire format changed");
static_assert(offsetof(struct_message, hum)     == offsetof(legacy_message, hum),     "wire format changed");
static_assert(offsetof(struct_message, battery) == offsetof(legacy_message, battery), "wire format changed");
static_assert(sizeof(struct_message) > sizeof(legacy_message), "new fields must change the length");

// --- CONFIG MESSAGE (hub → sensor; must match sensor byte for byte) ---
// Fixed size with explicit spare bytes so a parameter can be added later
// without a new wire format.
typedef struct config_message {
  uint8_t  msgType;       // MSG_CONFIG
  uint8_t  schema;        // 1 = the fields below
  uint16_t cfg_ver;
  uint16_t sleep_secs;
  uint16_t pad;
  float    sh_a;          // Steinhart-Hart A (K^-1)
  float    sh_b;          // Steinhart-Hart B (K^-1)
  float    sh_c;          // Steinhart-Hart C (K^-1)
  float    r_series;      // divider resistor, ohms
  uint8_t  reserved[16];
} config_message;

static_assert(sizeof(config_message) == 40, "config wire format changed");

// --- LOG MESSAGE STRUCTURE (must match sensor) ---
// Sensor-ntc sends its wake-cycle serial log to the hub in 240-byte chunks
// over the existing encrypted ESP-NOW peer.
typedef struct log_message {
  uint8_t msgType;            // MSG_LOG = 3
  uint8_t seq;                // chunk index (0-based)
  uint8_t total;              // total chunks in this log
  uint8_t len;                // valid bytes in data[] for this chunk
  char    data[LOG_CHUNK_DATA];
} log_message;

struct_message incomingData;
volatile int   incomingRSSI = 0;

// --- SENSOR DATA STORAGE ---
#define MAX_SENSORS 10
static_assert(SOTA_MAX_STAGED == MAX_SENSORS,
              "every tracked sensor needs a staging slot");

struct SensorData {
  uint8_t       mac[6];
  float         temp;
  float         hum;
  int           rssi;
  unsigned long lastUpdate;
  unsigned long lastRxMillis;  // millis() of last accepted reading (dedup guard)
  bool          active;
  char          name[20];
  uint8_t       battery;

  // Reported by the sensor in every data frame. All zero until the sensor has
  // been updated to firmware that sends them.
  uint8_t       fw_major;
  uint8_t       fw_minor;
  uint8_t       fw_patch;
  uint16_t      cfg_ver;        // version the sensor reports as applied

  // Config the cloud wants this sensor to run. Pushed on the next data frame
  // whenever it differs from what the sensor reports, and held in NVS so a hub
  // reboot does not forget a change that has not landed yet.
  bool          cfgPending;
  uint16_t      cfgDesiredVer;
  uint16_t      cfgSleepSecs;
  float         cfgShA;
  float         cfgShB;
  float         cfgShC;
  float         cfgRSeries;

  // Latest remote log received from this sensor (filled by handleLogChunk).
  // logExpectedTotal/logChunksRcvd track the in-progress assembly so we know
  // when the log is complete; logUpdated is the millis() of the last full assembly.
  char          log[LOG_BUF_SIZE];
  uint16_t      logLen;             // bytes filled in log[]
  uint8_t       logExpectedTotal;   // total chunks the sensor announced
  uint8_t       logChunksRcvd;      // chunks received so far (resets at seq 0)
  unsigned long logUpdated;         // millis() of last assembled log
};

SensorData sensors[MAX_SENSORS];
int        sensorCount = 0;

// --- OFFLINE READING BUFFER ---
// Readings received while MQTT is disconnected are stored here and flushed
// to the cloud once the connection is restored.
#define OFFLINE_BUFFER_SIZE 50

struct BufferedReading {
  uint8_t mac[6];
  float   temp;
  float   hum;
  int8_t  rssi;
  uint8_t battery;
  char    ts[21];   // ISO-8601 timestamp captured at the time of the reading
};

static BufferedReading offlineBuf[OFFLINE_BUFFER_SIZE];
static int bufHead  = 0;   // next write slot (circular)
static int bufTail  = 0;   // next read slot  (circular)
static int bufCount = 0;

// The buffer above is RAM only, so a reboot used to discard everything queued
// during an outage. That is exactly what happens during an OTA rollback, which
// restarts the hub every five minutes — a 15 minute recovery could silently
// swallow three sensors' worth of readings.
//
// The most recent entries are mirrored to NVS and restored at boot. Capped well
// below OFFLINE_BUFFER_SIZE to keep the blob small: the 20 KB NVS partition also
// holds WiFi credentials, cloud credentials and the sensor list.
#define OFFLINE_PERSIST_MAX 20

// Set when the buffer changes. The actual flash write happens in loop(), never
// in the ESP-NOW receive callback — a 10–20 ms NVS commit in that path would
// stall the WiFi task while sensors are transmitting.
static volatile bool offlineBufDirty = false;


// --- WEB SERVER ---
WebServer server(80);

// --- NVS (used for "sensors" namespace — persisting paired sensor MACs) ---
Preferences prefs;

// --- BLE PROVISIONING STATE ---
NimBLEServer*         pBleServer    = nullptr;
NimBLECharacteristic* pCharStatus   = nullptr;
NimBLECharacteristic* pCharNetworks = nullptr;

volatile bool scanRequested    = false;
volatile bool wifiProvReceived = false;

char provSsid[65] = "";
char provPass[65] = "";

// ─────────────────────────────────────────────────────────────────────────────
// MQTT / CLOUD STATE
// Credentials are written to NVS namespace "cloud" during BLE provisioning and
// loaded into these variables on each boot by loadCloudConfig().
// ─────────────────────────────────────────────────────────────────────────────

WiFiClientSecure wifiSecure;
PubSubClient     mqttClient(wifiSecure);

char mqttHost[128] = "";
int  mqttPort      = 8883;
char mqttUser[65]  = "";
char mqttPass[65]  = "";

// Hub MAC "AA:BB:CC:DD:EE:FF" — embedded in every MQTT topic path
char hubMacStr[18] = "";

// Topic strings built once in buildTopics()
char topicData[72];
char topicStatus[72];
char topicPairReq[80];
char topicPairResp[80];
// Cloud-sync topics (hub ↔ cloud sensor-list management)
char topicSync[64];          // Cloud → Hub: authoritative sensor list
char topicSyncReq[72];       // Hub → Cloud: local sensor list / sync request
char topicSensorRemove[72];  // Cloud → Hub: remove a specific sensor
char topicSensorRename[72];  // Cloud → Hub: rename a specific sensor
char topicSensorRenamed[72]; // Hub → Cloud: local rename notification
char topicSensorDeleted[72]; // Hub → Cloud: local delete notification
char topicPairEnable[80];   // Cloud → Hub: enable/disable pairing mode
char topicPairStatus[80];   // Hub → Cloud: pairing mode state ack
char topicOtaCmd[72];       // Cloud → Hub: OTA command (stage an image)
char topicOtaStatus[72];    // Hub → Cloud: OTA progress / result
char topicCfgSet[72];       // Cloud → Hub: desired sensor config
char topicCfgState[72];     // Hub → Cloud: config applied / pending
char topicSensorOta[80];    // Cloud → Hub: stage an image on a sensor, one topic per sensor
char topicSensorOtaStatus[80]; // Hub → Cloud: sensor OTA progress
char topicLiveReq[80];      // Cloud → Hub: ask a sensor to stay awake
char topicLiveState[80];    // Hub → Cloud: a live request reached the node

bool cloudConfigured = false;  // true when MQTT credentials exist in NVS
int  lastMqttState   = 0;     // PubSubClient state after last connectCloud() attempt

// After a pairing completes, suppress applySyncFromCloud removals for this long.
// The cloud needs a moment to persist the new sensor before it sends an
// authoritative list that includes it — without this guard the hub removes the
// sensor the instant the cloud replies with its (still-stale) retained list.
#define PAIRING_GRACE_MS 15000UL
unsigned long pairingGraceUntil = 0;  // millis() deadline; 0 = no grace active

// Non-blocking pending pairing — sensor waits for cloud approval in loop()
struct {
  uint8_t      mac[6];
  unsigned long startedAt;
  bool          active;
  bool          approved;
  bool          resolved;
} pendingPairing = {};

// Pairing mode: hub only accepts MSG_PAIRING when this is active.
// Activated by cloud MQTT command; auto-expires after timeout.
bool          pairingModeActive  = false;
unsigned long pairingModeStarted = 0;
#define PAIRING_MODE_TIMEOUT_MS 120000UL  // 2 minutes

unsigned long      lastMqttReconnect    = 0;
const unsigned long MQTT_RECONNECT_MS   = 5000;
const unsigned long PAIRING_TIMEOUT_MS  = 60000;

// WiFi credentials kept in RAM so maintainWiFi() can reconnect without NVS.
static char wifiSsid[65] = "";
static char wifiPass[65] = "";
static unsigned long  lastWifiReconnect  = 0;
const  unsigned long  WIFI_RECONNECT_MS  = 30000;  // one reconnect attempt per 30 s
// Max time to wait for a single reconnect attempt before giving up and
// restoring ch 1. Must be < the sensor's 5 s retry-wait so the hub is back
// on ch 1 before the sensor's second transmission batch begins.
const  unsigned long  WIFI_TRY_MS        = 4000;

// Last WiFi channel the STA was on. Held so we can re-lock the radio to this
// channel when WiFi drops, keeping ESP-NOW reachable while the STA reconnects.
static uint8_t lastWifiChannel = 1;

// Flags used only inside startBleProvisioning() to test MQTT before confirming "connected"
volatile bool cloudProvReceived = false;  // set when PROV_CLOUD arrives while WiFi is already up
bool          wifiOkInProv      = false;  // WiFi connected inside the provisioning loop

// ─────────────────────────────────────────────────────────────────────────────
// JSON HELPERS
// Simple key-value extraction for the structured payloads we receive.
// Does not handle escaped quotes in values — sufficient for WiFi/MQTT creds.
// ─────────────────────────────────────────────────────────────────────────────

String jsonGetStr(const String& json, const String& key) {
  String search = "\"" + key + "\":\"";
  int start = json.indexOf(search);
  if (start == -1) return "";
  start += search.length();
  int end = json.indexOf('"', start);
  if (end == -1) return "";
  return json.substring(start, end);
}

float jsonGetFloat(const String& json, const String& key) {
  String search = "\"" + key + "\":";
  int start = json.indexOf(search);
  if (start == -1) return NAN;
  start += search.length();
  int end  = json.indexOf(',', start);
  int end2 = json.indexOf('}', start);
  if (end == -1 || (end2 != -1 && end2 < end)) end = end2;
  if (end == -1) return NAN;
  return json.substring(start, end).toFloat();
}

int jsonGetInt(const String& json, const String& key) {
  String search = "\"" + key + "\":";
  int start = json.indexOf(search);
  if (start == -1) return 0;
  start += search.length();
  int end = json.indexOf(',', start);
  int end2 = json.indexOf('}', start);
  if (end == -1 || (end2 != -1 && end2 < end)) end = end2;
  if (end == -1) return 0;
  return json.substring(start, end).toInt();
}

// Escapes a String for safe inclusion as a JSON string value.
String jsonEscStr(const String& s) {
  String out;
  out.reserve(s.length() + 8);
  for (unsigned int i = 0; i < s.length(); i++) {
    char c = s[i];
    if      (c == '"')  out += "\\\"";
    else if (c == '\\') out += "\\\\";
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else if ((uint8_t)c < 0x20) { char buf[7]; snprintf(buf,7,"\\u%04x",(uint8_t)c); out += buf; }
    else out += c;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// BLE STATUS NOTIFICATION
// ─────────────────────────────────────────────────────────────────────────────

void notifyStatus(const char* state, const char* detail = "") {
  if (!pCharStatus) return;

  String json = "{\"state\":\"";
  json += state;
  json += "\"";
  if (detail && strlen(detail) > 0) {
    json += ",\"detail\":\"";
    json += jsonEscStr(String(detail));
    json += "\"";
  }
  json += "}";

  pCharStatus->setValue(json.c_str());
  pCharStatus->notify();
  Serial.printf("[BLE] Status: %s\n", json.c_str());
}

// Persist the "fully provisioned" flag. Boot only enters normal mode when this
// is set (see setup()), so a provisioning attempt that saved WiFi creds but
// never fully succeeded (e.g. cloud failed) re-enters BLE provisioning on the
// next boot instead of getting stuck in normal mode with no BLE.
void markProvisioned() {
  Preferences p;
  p.begin("wifi", false);
  p.putBool("provisioned", true);
  p.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// WIFI SCAN (called from provisioning loop when scanRequested flag is set)
// ─────────────────────────────────────────────────────────────────────────────

void performWifiScan() {
  if (!pCharNetworks) return;
  Serial.println("[BLE] Scanning WiFi networks...");

  // Synchronous scan: no hidden SSIDs, 300 ms per channel
  int n = WiFi.scanNetworks(/*async=*/false, /*show_hidden=*/false,
                             /*passive=*/false, /*max_ms_per_chan=*/300);

  if (n < 0) {
    Serial.printf("[BLE] Scan failed (err %d)\n", n);
    WiFi.scanDelete();
    return;
  }
  Serial.printf("[BLE] Scan found %d network(s)\n", n);

  // Sort up to 10 results by RSSI descending (insertion sort)
  const int MAX_RESULTS = 10;
  int indices[MAX_RESULTS];
  int count = min(n, MAX_RESULTS);
  for (int i = 0; i < count; i++) indices[i] = i;
  for (int i = 1; i < count; i++) {
    int key = indices[i];
    int j = i - 1;
    while (j >= 0 && WiFi.RSSI(indices[j]) < WiFi.RSSI(key)) {
      indices[j + 1] = indices[j];
      j--;
    }
    indices[j + 1] = key;
  }

  String json = "{\"networks\":[";
  for (int i = 0; i < count; i++) {
    int idx = indices[i];
    if (i > 0) json += ",";
    json += "{\"ssid\":\"";
    json += jsonEscStr(WiFi.SSID(idx));
    json += "\",\"rssi\":";
    json += WiFi.RSSI(idx);
    json += ",\"enc\":";
    json += (int)WiFi.encryptionType(idx);
    json += "}";
  }
  json += "]}";

  WiFi.scanDelete();

  // BLE characteristic value size is limited — warn if payload is large
  if (json.length() > 512) {
    Serial.printf("[BLE] Warning: network JSON %d bytes, truncating\n", json.length());
    // Trim trailing entries until it fits
    while (json.length() > 512 && count > 1) {
      count--;
      // Rebuild with fewer entries
      json = "{\"networks\":[";
      for (int i = 0; i < count; i++) {
        int idx = indices[i];
        if (i > 0) json += ",";
        json += "{\"ssid\":\"" + jsonEscStr(WiFi.SSID(idx))
             + "\",\"rssi\":" + WiFi.RSSI(idx)
             + ",\"enc\":" + (int)WiFi.encryptionType(idx) + "}";
      }
      json += "]}";
    }
  }

  pCharNetworks->setValue(json.c_str());
  pCharNetworks->notify();
  Serial.printf("[BLE] Networks notified (%d entries, %d bytes)\n", count, json.length());
}

// ─────────────────────────────────────────────────────────────────────────────
// BLE GATT CALLBACKS
// ─────────────────────────────────────────────────────────────────────────────

class ProvServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, NimBLEConnInfo& connInfo) override {
    Serial.printf("[BLE] Client connected: %s\n",
                  connInfo.getAddress().toString().c_str());
    digitalWrite(LED_PIN, HIGH);

    // Fresh provisioning session on every connect: clear stale retry flags from
    // a previous failed attempt and reset the status to idle. The WiFi radio is
    // cleaned in the loop before the next WiFi.begin (kept out of this BLE-task
    // callback). Lets a reconnect-to-retry start clean without a power cycle.
    wifiProvReceived  = false;
    cloudProvReceived = false;
    wifiOkInProv      = false;
    scanRequested     = false;
    notifyStatus("idle");
  }
  void onDisconnect(NimBLEServer* s, NimBLEConnInfo& connInfo, int reason) override {
    Serial.printf("[BLE] Client disconnected (reason %d), restarting advertising\n", reason);
    digitalWrite(LED_PIN, LOW);
    NimBLEDevice::startAdvertising();
  }
};

class ProvWifiCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pChar, NimBLEConnInfo& connInfo) override {
    String val = String(pChar->getValue().c_str());
    Serial.printf("[BLE] PROV_WIFI received (%d bytes)\n", val.length());

    String ssid = jsonGetStr(val, "ssid");
    String pass = jsonGetStr(val, "pass");

    if (ssid.isEmpty()) {
      Serial.println("[BLE] PROV_WIFI: SSID empty, ignoring");
      notifyStatus("failed", "SSID cannot be empty");
      return;
    }

    // Persist immediately so a crash/reset doesn't lose them
    Preferences wPrefs;
    wPrefs.begin("wifi", false);
    wPrefs.putString("ssid", ssid);
    wPrefs.putString("pass", pass);
    wPrefs.end();

    ssid.toCharArray(provSsid, sizeof(provSsid));
    pass.toCharArray(provPass, sizeof(provPass));

    wifiProvReceived = true;
    notifyStatus("connecting", "WiFi credentials received");
    Serial.printf("[BLE] WiFi creds saved — SSID: %s\n", provSsid);
  }
};

class ProvCloudCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pChar, NimBLEConnInfo& connInfo) override {
    String val = String(pChar->getValue().c_str());
    Serial.printf("[BLE] PROV_CLOUD received (%d bytes)\n", val.length());

    String host = jsonGetStr(val, "host");
    if (host.isEmpty()) {
      Serial.println("[BLE] PROV_CLOUD: no host, ignoring");
      return;
    }

    Preferences cPrefs;
    cPrefs.begin("cloud", false);
    cPrefs.putString("mqtt_host", host);
    cPrefs.putInt   ("mqtt_port", jsonGetInt(val, "port"));
    cPrefs.putString("mqtt_user", jsonGetStr(val, "user"));
    cPrefs.putString("mqtt_pass", jsonGetStr(val, "pass"));
    cPrefs.end();

    Serial.printf("[BLE] Cloud creds saved — host: %s\n", host.c_str());

    // If WiFi is already connected in the provisioning loop, signal a cloud retry
    if (wifiOkInProv) cloudProvReceived = true;
  }
};

class ProvNetworksCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pChar, NimBLEConnInfo& connInfo) override {
    Serial.println("[BLE] WiFi scan requested");
    scanRequested = true;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// BLE PROVISIONING MODE
// Blocks until valid WiFi credentials are received and connection succeeds,
// then calls ESP.restart() to boot into normal operation.
// ─────────────────────────────────────────────────────────────────────────────

void startBleProvisioning() {
  Serial.println("\n=== BLE PROVISIONING MODE ===");

  // Need WiFi in STA mode to scan and to attempt connection
  WiFi.mode(WIFI_STA);

  // Build device name from last 3 MAC octets so it's unique and identifiable
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char bleName[24];
  snprintf(bleName, sizeof(bleName), "TempHub-%02X%02X%02X", mac[3], mac[4], mac[5]);
  // Also store full MAC string now — used by PROV_CHAR_INFO so the setup page
  // can read the MAC automatically without the user typing it in.
  snprintf(hubMacStr, sizeof(hubMacStr), "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  Serial.printf("BLE name: %s  MAC: %s\n", bleName, hubMacStr);

  // Initialise NimBLE
  NimBLEDevice::init(bleName);
  NimBLEDevice::setMTU(517);  // Allow up to 512-byte notifications (needed for WiFi scan JSON)
  NimBLEDevice::setPower(3);  // +3 dBm — enough for typical room range

  pBleServer = NimBLEDevice::createServer();
  pBleServer->setCallbacks(new ProvServerCallbacks());

  NimBLEService* pService = pBleServer->createService(PROV_SERVICE_UUID);

  // PROV_WIFI — app writes WiFi credentials
  NimBLECharacteristic* pCharWifi =
    pService->createCharacteristic(PROV_CHAR_WIFI, NIMBLE_PROPERTY::WRITE);
  pCharWifi->setCallbacks(new ProvWifiCallbacks());

  // PROV_CLOUD — app writes MQTT credentials
  NimBLECharacteristic* pCharCloud =
    pService->createCharacteristic(PROV_CHAR_CLOUD, NIMBLE_PROPERTY::WRITE);
  pCharCloud->setCallbacks(new ProvCloudCallbacks());

  // PROV_STATUS — device notifies app of progress
  pCharStatus =
    pService->createCharacteristic(PROV_CHAR_STATUS,
                                   NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  pCharStatus->setValue("{\"state\":\"idle\"}");

  // PROV_NETWORKS — app writes to trigger scan; device notifies results
  pCharNetworks =
    pService->createCharacteristic(PROV_CHAR_NETWORKS,
                                   NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
  pCharNetworks->setCallbacks(new ProvNetworksCallbacks());

  // PROV_INFO — app reads this to auto-detect the hub MAC (no manual typing needed).
  // Use String (not char[N]) so NimBLE receives a pointer+strlen, not the full
  // 32-byte buffer which would leave garbage bytes after the JSON and break JSON.parse.
  String infoJson = String("{\"mac\":\"") + hubMacStr + "\"}";
  NimBLECharacteristic* pCharInfo =
    pService->createCharacteristic(PROV_CHAR_INFO, NIMBLE_PROPERTY::READ);
  pCharInfo->setValue(infoJson.c_str());

  pService->start();

  // Primary advertisement: service UUID (used by web app filter)
  NimBLEAdvertising* pAdv = NimBLEDevice::getAdvertising();
  pAdv->addServiceUUID(PROV_SERVICE_UUID);

  // Scan response: device name (shown in the browser pairing dialog)
  // Kept separate because a 128-bit UUID + name won't fit in one 31-byte packet.
  NimBLEAdvertisementData scanRsp;
  scanRsp.setName(bleName);
  pAdv->setScanResponseData(scanRsp);

  NimBLEDevice::startAdvertising();

  Serial.println("BLE advertising. Waiting for app to connect...");
  Serial.println("Open ble-provision.html in Chrome to provision this device.");

  // ── Provisioning event loop ──────────────────────────────────────────────
  while (true) {

    // WiFi scan requested by app
    if (scanRequested) {
      scanRequested = false;
      performWifiScan();
    }

    // WiFi credentials written by app
    if (wifiProvReceived) {
      wifiProvReceived = false;

      Serial.printf("Attempting WiFi connection to: %s\n", provSsid);
      WiFi.disconnect(true);   // clear any half-up STA from a previous attempt
      delay(100);
      WiFi.begin(provSsid, provPass);

      unsigned long start = millis();
      while (WiFi.status() != WL_CONNECTED &&
             millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
        delay(200);
      }

      if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("WiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());
        wifiOkInProv = true;

        // Test cloud connection before telling the app we're done.
        loadCloudConfig();
        if (cloudConfigured) {
          buildTopics();
          notifyStatus("connecting", "WiFi OK — connecting to cloud...");
          if (!connectCloud()) {
            // PubSubClient state codes:
            //  -4=timeout  -3=conn lost  -2=connect failed (TCP/TLS)  -1=disconnect
            //   4=bad credentials  5=unauthorized
            // Only auth failures (4, 5) mean the credentials themselves are
            // wrong; everything else is a network/broker problem and the
            // creds should be preserved so the user can retry without
            // re-provisioning.
            bool authFail = (lastMqttState == 4 || lastMqttState == 5);
            if (authFail) {
              Preferences cPrefs; cPrefs.begin("cloud", false); cPrefs.clear(); cPrefs.end();
              cloudConfigured = false;
            }
            char failMsg[96];
            snprintf(failMsg, sizeof(failMsg),
                     authFail
                       ? "Cloud auth failed (rc %d) — check MQTT username/password"
                       : "Cloud unreachable (rc %d) — check host/port/network",
                     lastMqttState);
            notifyStatus("failed", failMsg);
            NimBLEDevice::startAdvertising();
            // Stay in the provisioning loop; app shows "failed" and user
            // can resend PROV_CLOUD (which will set cloudProvReceived = true)
          } else {
            mqttClient.disconnect();
            wifiSecure.stop();
            markProvisioned();       // WiFi + cloud verified — safe to boot normal mode
            notifyStatus("connected", "");
            delay(1200);
            ESP.restart();
          }
        } else {
          // PROV_CLOUD not yet written — wait; cloudProvReceived will fire
          // when the app sends the cloud credentials after WiFi is up.
          notifyStatus("connecting", "WiFi OK — waiting for cloud credentials...");
        }

      } else {
        Serial.println("WiFi connection failed — wrong password or out of range?");
        WiFi.disconnect(true);

        // Erase bad credentials so a retry starts clean
        Preferences wPrefs;
        wPrefs.begin("wifi", false);
        wPrefs.remove("ssid");
        wPrefs.remove("pass");
        wPrefs.end();
        provSsid[0] = '\0';
        provPass[0] = '\0';

        notifyStatus("failed", "Wrong password or network unreachable");

        // Resume advertising for another attempt
        NimBLEDevice::startAdvertising();
      }
    }

    // PROV_CLOUD arrived after WiFi was already up — attempt cloud connection now
    if (cloudProvReceived && wifiOkInProv) {
      cloudProvReceived = false;
      loadCloudConfig();
      if (cloudConfigured) {
        buildTopics();
        notifyStatus("connecting", "Connecting to cloud...");
        if (!connectCloud()) {
          bool authFail = (lastMqttState == 4 || lastMqttState == 5);
          if (authFail) {
            Preferences cPrefs; cPrefs.begin("cloud", false); cPrefs.clear(); cPrefs.end();
            cloudConfigured = false;
          }
          char failMsg[96];
          snprintf(failMsg, sizeof(failMsg),
                   authFail
                     ? "Cloud auth failed (rc %d) — check MQTT username/password"
                     : "Cloud unreachable (rc %d) — check host/port/network",
                   lastMqttState);
          notifyStatus("failed", failMsg);
          NimBLEDevice::startAdvertising();
        } else {
          mqttClient.disconnect();
          wifiSecure.stop();
          markProvisioned();       // WiFi + cloud verified — safe to boot normal mode
          notifyStatus("connected", "");
          delay(1200);
          ESP.restart();
        }
      }
    }

    // BOOT button: erase all provisioning data and restart
    if (resetButtonHeld()) {
      delay(50);
      unsigned long press = millis();
      while (resetButtonHeld()) {
        if (millis() - press > 3000) {
          Serial.println("Factory reset from BLE provisioning mode");
          Preferences wPrefs; wPrefs.begin("wifi",  false); wPrefs.clear(); wPrefs.end();
          Preferences cPrefs; cPrefs.begin("cloud", false); cPrefs.clear(); cPrefs.end();
          delay(500);
          ESP.restart();
        }
        delay(10);
      }
    }

    delay(10);
  }
  // unreachable — loop exits only via ESP.restart()
}

// ─────────────────────────────────────────────────────────────────────────────
// EXISTING FUNCTIONS (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

void printCurrentTime() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) { Serial.println("Failed to obtain time"); return; }
  Serial.println(&timeinfo, "%d/%m/%y - %H:%M:%S");
}

void resyncNTP() {
  if (millis() - lastNtpSync > NTP_SYNC_INTERVAL) {
    Serial.println("Resyncing NTP...");
    configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
    lastNtpSync = millis();
    struct tm timeinfo;
    if (getLocalTime(&timeinfo)) Serial.println("NTP resync successful!");
  }
}

int findSensor(const uint8_t* mac) {
  for (int i = 0; i < sensorCount; i++) {
    if (memcmp(sensors[i].mac, mac, 6) == 0) return i;
  }
  return -1;
}

int addSensor(const uint8_t* mac) {
  if (sensorCount >= MAX_SENSORS) {
    Serial.println("WARNING: Max sensors reached!");
    return -1;
  }
  memcpy(sensors[sensorCount].mac, mac, 6);
  sensors[sensorCount].active           = true;
  sensors[sensorCount].temp             = 0;
  sensors[sensorCount].hum              = 0;
  sensors[sensorCount].rssi             = 0;
  sensors[sensorCount].battery          = 0;
  sensors[sensorCount].lastUpdate       = millis();
  sensors[sensorCount].lastRxMillis     = 0;
  sensors[sensorCount].log[0]           = '\0';
  sensors[sensorCount].logLen           = 0;
  sensors[sensorCount].logExpectedTotal = 0;
  sensors[sensorCount].logChunksRcvd    = 0;
  sensors[sensorCount].logUpdated       = 0;
  sprintf(sensors[sensorCount].name, "Sensor-%02X%02X", mac[4], mac[5]);
  sensorCount++;
  Serial.printf("Sensor added. Total: %d\n", sensorCount);

  char key[8];
  snprintf(key, sizeof(key), "mac%d", sensorCount - 1);
  prefs.begin("sensors", false);
  prefs.putBytes(key, mac, 6);
  prefs.putInt("count", sensorCount);
  prefs.end();
  return sensorCount - 1;
}

void updateSensor(int index, float temp, float hum, int rssi, uint8_t battery) {
  if (index < 0 || index >= sensorCount) return;

  // The sensor retries the same reading up to MAX_RETRIES times when it
  // doesn't receive an ESP-NOW ACK. Deduplicate by ignoring any reading
  // that arrives within 5 s of the last accepted one from this sensor.
  unsigned long now = millis();
  if (now - sensors[index].lastRxMillis < 5000) {
    Serial.println(" | Duplicate retry — skipped");
    return;
  }
  sensors[index].lastRxMillis = now;

  sensors[index].temp       = temp;
  sensors[index].hum        = hum;
  sensors[index].rssi       = rssi;
  sensors[index].battery    = battery;
  sensors[index].lastUpdate = now;
  sensors[index].active     = true;
  publishSensorData(index);  // forward reading to cloud
}

void checkInactiveSensors() {
  unsigned long now = millis();
  for (int i = 0; i < sensorCount; i++) {
    if (now - sensors[i].lastUpdate > 600000) sensors[i].active = false;
  }
}

void loadPairedSensors() {
  prefs.begin("sensors", true);
  int count = prefs.getInt("count", 0);
  Serial.printf("Restoring %d saved sensor(s) from NVS...\n", count);

  for (int i = 0; i < count && sensorCount < MAX_SENSORS; i++) {
    char key[8];
    snprintf(key, sizeof(key), "mac%d", i);
    uint8_t mac[6] = {};
    if (prefs.getBytes(key, mac, 6) != 6) continue;

    memcpy(sensors[sensorCount].mac, mac, 6);
    sensors[sensorCount].active           = false;
    sensors[sensorCount].temp             = 0;
    sensors[sensorCount].hum              = 0;
    sensors[sensorCount].rssi             = 0;
    sensors[sensorCount].battery          = 0;
    sensors[sensorCount].lastUpdate       = 0;
    sensors[sensorCount].log[0]           = '\0';
    sensors[sensorCount].logLen           = 0;
    sensors[sensorCount].logExpectedTotal = 0;
    sensors[sensorCount].logChunksRcvd    = 0;
    sensors[sensorCount].logUpdated       = 0;
    sprintf(sensors[sensorCount].name, "Sensor-%02X%02X", mac[4], mac[5]);
    // Load saved name from NVS (keyed by MAC bytes 2–5)
    char nameKey[10];
    snprintf(nameKey, sizeof(nameKey), "n%02X%02X%02X%02X", mac[2], mac[3], mac[4], mac[5]);
    String savedName = prefs.getString(nameKey, "");
    if (savedName.length() > 0) {
      strncpy(sensors[sensorCount].name, savedName.c_str(), 19);
      sensors[sensorCount].name[19] = '\0';
    }
    sensorCount++;

    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, mac, 6);
    peer.channel = 0;
    peer.encrypt = true;
    memcpy(peer.lmk, LMK_KEY, 16);
    if (esp_now_add_peer(&peer) == ESP_OK) {
      Serial.printf("  ✓ %02X:%02X:%02X:%02X:%02X:%02X restored\n",
                    mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
      // A config change that has not reached its sensor yet must survive a hub
      // reboot, or a node that was mid-cycle would silently never receive it.
      loadSensorConfig(sensorCount - 1);
    } else {
      Serial.printf("  ✗ Failed to re-register peer %02X:%02X:%02X:%02X:%02X:%02X\n",
                    mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    }
  }
  prefs.end();
}


// ─────────────────────────────────────────────────────────────────────────────
// CLOUD / MQTT
// ─────────────────────────────────────────────────────────────────────────────

// Load MQTT credentials from NVS namespace "cloud" (written by BLE provisioning).
void loadCloudConfig() {
  Preferences cPrefs;
  cPrefs.begin("cloud", true);
  String host = cPrefs.getString("mqtt_host", "");
  mqttPort     = cPrefs.getInt("mqtt_port", 8883);
  String user  = cPrefs.getString("mqtt_user", "");
  String pass  = cPrefs.getString("mqtt_pass", "");
  cPrefs.end();

  if (host.isEmpty() || user.isEmpty() || pass.isEmpty()) {
    Serial.println("[MQTT] No cloud credentials in NVS — cloud uplink disabled");
    cloudConfigured = false;
    return;
  }
  host.toCharArray(mqttHost, sizeof(mqttHost));
  user.toCharArray(mqttUser, sizeof(mqttUser));
  pass.toCharArray(mqttPass, sizeof(mqttPass));
  cloudConfigured = true;
  Serial.printf("[MQTT] Cloud config loaded — host: %s  port: %d\n", mqttHost, mqttPort);
}

// Build topic strings from the hub's own WiFi MAC address.
// Must be called after WiFi is connected so WiFi.macAddress() is valid.
void buildTopics() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  snprintf(hubMacStr,    sizeof(hubMacStr),    "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  snprintf(topicData,         sizeof(topicData),         "sensors/%s/data",             hubMacStr);
  snprintf(topicStatus,       sizeof(topicStatus),       "sensors/%s/status",           hubMacStr);
  snprintf(topicPairReq,      sizeof(topicPairReq),      "sensors/%s/pairing/request",  hubMacStr);
  snprintf(topicPairResp,     sizeof(topicPairResp),     "sensors/%s/pairing/response", hubMacStr);
  snprintf(topicSync,         sizeof(topicSync),         "sensors/%s/sync",             hubMacStr);
  snprintf(topicSyncReq,      sizeof(topicSyncReq),      "sensors/%s/sync/request",     hubMacStr);
  snprintf(topicSensorRemove, sizeof(topicSensorRemove), "sensors/%s/sensor/remove",    hubMacStr);
  snprintf(topicSensorRename, sizeof(topicSensorRename), "sensors/%s/sensor/rename",    hubMacStr);
  snprintf(topicSensorRenamed,sizeof(topicSensorRenamed),"sensors/%s/sensor/renamed",   hubMacStr);
  snprintf(topicSensorDeleted,sizeof(topicSensorDeleted),"sensors/%s/sensor/deleted",   hubMacStr);
  snprintf(topicPairEnable,  sizeof(topicPairEnable),  "sensors/%s/pairing/enable",   hubMacStr);
  snprintf(topicPairStatus,  sizeof(topicPairStatus),  "sensors/%s/pairing/status",   hubMacStr);
  snprintf(topicOtaCmd,      sizeof(topicOtaCmd),      "sensors/%s/ota/command",      hubMacStr);
  snprintf(topicOtaStatus,   sizeof(topicOtaStatus),   "sensors/%s/ota/status",       hubMacStr);
  snprintf(topicCfgSet,      sizeof(topicCfgSet),      "sensors/%s/config/set",       hubMacStr);
  snprintf(topicCfgState,    sizeof(topicCfgState),    "sensors/%s/config/state",     hubMacStr);
  snprintf(topicSensorOta,       sizeof(topicSensorOta),       "sensors/%s/sensor-ota/command/", hubMacStr);
  snprintf(topicSensorOtaStatus, sizeof(topicSensorOtaStatus), "sensors/%s/sensor-ota/status",  hubMacStr);
  snprintf(topicLiveReq,         sizeof(topicLiveReq),         "sensors/%s/live/request",       hubMacStr);
  snprintf(topicLiveState,       sizeof(topicLiveState),       "sensors/%s/live/state",         hubMacStr);
  Serial.printf("[MQTT] Hub MAC: %s\n", hubMacStr);
}

// Called by PubSubClient when a subscribed message arrives.
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String json = String((char*)payload, length);

  // ── Live mode request from cloud ──────────────────────────────────────────
  if (strcmp(topic, topicLiveReq) == 0) {
    if (length == 0 || json.indexOf('{') < 0) return;   // retained clear
    String macStr = jsonGetStr(json, "sensor_mac");
    uint8_t mac[6];
    if (macStr.length() != 17 ||
        sscanf(macStr.c_str(), "%hhX:%hhX:%hhX:%hhX:%hhX:%hhX",
               &mac[0], &mac[1], &mac[2], &mac[3], &mac[4], &mac[5]) != 6) return;
    int dur = jsonGetInt(json, "duration_s");
    int iv  = jsonGetInt(json, "interval_s");
    // duration 0 is a stop: the node breaks out of its burst and sleeps. It is
    // awake and reporting every few seconds while live, so this lands quickly.
    if (dur < 0 || (dur > 0 && iv <= 0)) return;

    memcpy(livePendingMac, mac, 6);
    liveDuration = (uint16_t)dur;
    liveInterval = (uint16_t)iv;
    liveePending = true;
    Serial.printf("[LIVE] %s queued for %s - delivered on its next reading\n",
                  dur == 0 ? "Stop" : "Start", macStr.c_str());
    return;
  }

  // ── Sensor firmware from cloud ────────────────────────────────────────────
  // One retained topic per sensor. A single shared topic held only the most
  // recently staged image, so a hub restart came back having forgotten every
  // other sensor that was waiting for one.
  if (strncmp(topic, topicSensorOta, strlen(topicSensorOta)) == 0) {
    if (length == 0 || json.indexOf('{') < 0) {
      // An empty retained message is a cancellation, and it carries no body --
      // so the sensor it refers to has to come from the topic it arrived on.
      const char *hex = topic + strlen(topicSensorOta);
      uint8_t cmac[6];
      if (strlen(hex) == 12 &&
          sscanf(hex, "%2hhX%2hhX%2hhX%2hhX%2hhX%2hhX",
                 &cmac[0], &cmac[1], &cmac[2], &cmac[3], &cmac[4], &cmac[5]) == 6) {
        int slot = sOtaSlotFor(cmac);
        if (slot >= 0 && slot != sOtaActive) {
          sOtaStaged[slot].used = false;
          Serial.printf("[SOTA] Staged image cancelled for %02X:%02X:%02X:%02X:%02X:%02X\n",
                        cmac[0], cmac[1], cmac[2], cmac[3], cmac[4], cmac[5]);
          return;
        }
      }
      Serial.println("[SOTA] Retained command cleared");
      return;
    }
    String macStr = jsonGetStr(json, "sensor_mac");
    String url    = jsonGetStr(json, "url");
    String ver    = jsonGetStr(json, "version");
    String sha    = jsonGetStr(json, "sha256");
    String sig    = jsonGetStr(json, "sig");
    uint8_t mac[6];
    if (macStr.length() != 17 ||
        sscanf(macStr.c_str(), "%hhX:%hhX:%hhX:%hhX:%hhX:%hhX",
               &mac[0], &mac[1], &mac[2], &mac[3], &mac[4], &mac[5]) != 6 ||
        url.isEmpty() || sha.isEmpty() || sig.isEmpty()) {
      Serial.println("[SOTA] Incomplete sensor OTA command");
      return;
    }
    if (sOtaRunning) {
      Serial.println("[SOTA] Transfer already in progress");
      return;
    }
    memcpy(sOtaMac, mac, 6);
    ver.toCharArray(sOtaVersion, sizeof(sOtaVersion));

    int slot = sOtaSlotClaim(mac);
    if (slot < 0) {
      Serial.println("[SOTA] No free staging slot");
      publishSensorOtaStatus("failed", 0, "no free staging slot");
      return;
    }
    if (!buildSensorOtaOffer(slot, ver.c_str(), url.c_str(), sha.c_str(), sig.c_str())) {
      publishSensorOtaStatus("failed", 0, "image unreachable");
      return;
    }
    memcpy(sOtaStaged[slot].mac, mac, 6);
    sOtaStaged[slot].used = true;
    Serial.printf("[SOTA] Staged %s for %s - waiting for a button press on the node\n",
                  sOtaVersion, macStr.c_str());
    publishSensorOtaStatus("staged", 0, nullptr);
    return;
  }

  // ── Sensor config from cloud ──────────────────────────────────────────────
  if (strcmp(topic, topicCfgSet) == 0) {
    // An empty retained payload is how the cloud deletes a config command once
    // it has landed. It is not a malformed command — same lesson as the OTA
    // topic, which reported these as failures until it was fixed.
    if (length == 0 || json.indexOf('{') < 0) {
      Serial.println("[CFG] Retained command cleared");
      return;
    }

    String macStr = jsonGetStr(json, "sensor_mac");
    uint8_t mac[6];
    if (macStr.length() != 17 ||
        sscanf(macStr.c_str(), "%hhX:%hhX:%hhX:%hhX:%hhX:%hhX",
               &mac[0], &mac[1], &mac[2], &mac[3], &mac[4], &mac[5]) != 6) {
      Serial.println("[CFG] Bad sensor_mac in config command");
      return;
    }
    int idx = findSensor(mac);
    if (idx == -1) {
      Serial.println("[CFG] Config for unknown sensor — ignoring");
      return;
    }

    int   ver    = jsonGetInt(json, "cfg_ver");
    int   sleep  = jsonGetInt(json, "sleep_secs");
    float shA    = jsonGetFloat(json, "sh_a");
    float shB    = jsonGetFloat(json, "sh_b");
    float shC    = jsonGetFloat(json, "sh_c");
    float rSer   = jsonGetFloat(json, "r_series");

    if (ver <= 0 || sleep <= 0 || isnan(shA) || isnan(shB) || isnan(shC) || isnan(rSer)) {
      Serial.println("[CFG] Incomplete config command — ignoring");
      return;
    }

    sensors[idx].cfgDesiredVer = (uint16_t)ver;
    sensors[idx].cfgSleepSecs  = (uint16_t)sleep;
    sensors[idx].cfgShA        = shA;
    sensors[idx].cfgShB        = shB;
    sensors[idx].cfgShC        = shC;
    sensors[idx].cfgRSeries    = rSer;
    sensors[idx].cfgPending    = true;
    saveSensorConfig(idx);

    // Delivery waits for the sensor to wake — up to one full reporting
    // interval. The dashboard shows it as pending until the node echoes the
    // new cfg_ver back.
    Serial.printf("[CFG] Queued config v%d for %s (applies on next wake)\n",
                  ver, macStr.c_str());
    publishConfigState(idx);
    return;
  }

  // ── OTA command from cloud ────────────────────────────────────────────────
  // Only records the request; the download runs from loop() so it never blocks
  // PubSubClient's receive path.
  if (strcmp(topic, topicOtaCmd) == 0) {
    // An empty retained payload is how the cloud deletes a completed command at
    // the broker. It is not a malformed command, and must not be reported as a
    // failure — doing so overwrote a good "confirmed" state with "failed"
    // immediately after every successful update.
    if (length == 0 || json.indexOf('{') < 0) {
      Serial.println("[OTA] Retained command cleared");
      return;
    }

    String url = jsonGetStr(json, "url");
    String ver = jsonGetStr(json, "version");
    String sha = jsonGetStr(json, "sha256");
    String sig = jsonGetStr(json, "sig");

    if (url.isEmpty() || sha.isEmpty() || sig.isEmpty()) {
      Serial.println("[OTA] Command missing url/sha256/sig — ignoring");
      publishOtaStatus("failed", 0, "incomplete command");
      return;
    }
    if (otaInProgress) {
      Serial.println("[OTA] Update already running — ignoring command");
      return;
    }
    if (otaPendingVerify || otaUnconfirmed) {
      // Chaining a second update before the first is confirmed would overwrite
      // the very slot we need to roll back into — the only way to end up with
      // no good image to return to.
      //
      // otaUnconfirmed is the one that matters in practice: otaPendingVerify
      // tracks the bootloader's own rollback, which this hardware never arms,
      // so on its own this guard was permanently false.
      Serial.println("[OTA] Current image not yet confirmed — refusing");
      publishOtaStatus("failed", 0, "previous update not yet confirmed");
      return;
    }
    if (ver == FW_VERSION) {
      Serial.printf("[OTA] Already running %s — nothing to do\n", FW_VERSION);
      publishOtaStatus("uptodate", 100, nullptr);
      return;
    }

    if (otaRejectedVersion[0] && ver == otaRejectedVersion) {
      // We already installed this version, it could not reach the cloud, and we
      // rolled back. A retained command delivers it again on the next connect,
      // so without this the hub reinstalls it and loops every ~20 minutes while
      // looking perfectly healthy from the outside.
      Serial.printf("[OTA] %s was rolled back before — refusing to reinstall\n",
                    otaRejectedVersion);
      ver.toCharArray(otaVersion, sizeof(otaVersion));
      publishOtaStatus("failed", 0, "version previously rolled back on this hub");
      return;
    }

    url.toCharArray(otaUrl,     sizeof(otaUrl));
    ver.toCharArray(otaVersion, sizeof(otaVersion));
    sha.toCharArray(otaSha256,  sizeof(otaSha256));
    sig.toCharArray(otaSigB64,  sizeof(otaSigB64));
    otaRequested = true;

    // A different version supersedes the old verdict — clear it so a genuine
    // fix is never blocked by a stale record.
    if (otaRejectedVersion[0]) {
      otaRejectedVersion[0] = 0;
      Preferences clr;
      clr.begin("ota", false);
      clr.remove("rejected");
      clr.end();
    }
    Serial.printf("[OTA] Queued update to %s\n", otaVersion);
    publishOtaStatus("accepted", 0, nullptr);
    return;
  }

  // ── Pairing mode enable/disable from cloud ─────────────────────────────────
  if (strcmp(topic, topicPairEnable) == 0) {
    bool enable = json.indexOf("\"enable\":true") != -1;
    if (enable) {
      pairingModeActive  = true;
      pairingModeStarted = millis();
      Serial.println("[Pairing] Pairing mode ENABLED by cloud (2 min timeout)");
    } else {
      pairingModeActive = false;
      pendingPairing.active = false;
      Serial.println("[Pairing] Pairing mode DISABLED by cloud");
    }
    char ack[48];
    snprintf(ack, sizeof(ack), "{\"pairing_mode\":%s}", pairingModeActive ? "true" : "false");
    mqttClient.publish(topicPairStatus, ack);
    return;
  }

  // ── Pairing response (existing) ───────────────────────────────────────────
  if (strcmp(topic, topicPairResp) == 0) {
    if (!pendingPairing.active) return;
    String sensorMac = jsonGetStr(json, "sensor_mac");
    bool   approved  = json.indexOf("\"approved\":true") != -1;
    char pendingMacStr[18];
    snprintf(pendingMacStr, sizeof(pendingMacStr), "%02X:%02X:%02X:%02X:%02X:%02X",
             pendingPairing.mac[0], pendingPairing.mac[1], pendingPairing.mac[2],
             pendingPairing.mac[3], pendingPairing.mac[4], pendingPairing.mac[5]);
    if (sensorMac.equalsIgnoreCase(pendingMacStr)) {
      pendingPairing.approved = approved;
      pendingPairing.resolved = true;
      Serial.printf("[MQTT] Pairing response for %s: %s\n",
                    pendingMacStr, approved ? "APPROVED" : "REJECTED");
    }
    return;
  }

  // ── Cloud sends its authoritative sensor list → hub reconciles ────────────
  if (strcmp(topic, topicSync) == 0) {
    Serial.println("[MQTT] Cloud sync received");
    applySyncFromCloud(json);
    return;
  }

  // ── Cloud removes a specific sensor ───────────────────────────────────────
  if (strcmp(topic, topicSensorRemove) == 0) {
    String macStr = jsonGetStr(json, "sensor_mac");
    uint8_t mac[6];
    if (sscanf(macStr.c_str(), "%hhX:%hhX:%hhX:%hhX:%hhX:%hhX",
               &mac[0], &mac[1], &mac[2], &mac[3], &mac[4], &mac[5]) == 6) {
      Serial.printf("[MQTT] Cloud removing sensor %s\n", macStr.c_str());
      removeSensorByMac(mac);
    }
    return;
  }

  // ── Cloud renames a specific sensor ───────────────────────────────────────
  if (strcmp(topic, topicSensorRename) == 0) {
    String macStr  = jsonGetStr(json, "sensor_mac");
    String newName = jsonGetStr(json, "name");
    uint8_t mac[6];
    if (sscanf(macStr.c_str(), "%hhX:%hhX:%hhX:%hhX:%hhX:%hhX",
               &mac[0], &mac[1], &mac[2], &mac[3], &mac[4], &mac[5]) == 6
        && newName.length() > 0) {
      int idx = findSensor(mac);
      if (idx != -1) {
        char sanitized[20];
        strncpy(sanitized, newName.c_str(), 19);
        sanitized[19] = '\0';
        sanitizeName(sanitized, sizeof(sanitized));
        if (strlen(sanitized) > 0) {
          strncpy(sensors[idx].name, sanitized, sizeof(sensors[idx].name));
          char nameKey[10];
          snprintf(nameKey, sizeof(nameKey), "n%02X%02X%02X%02X",
                   sensors[idx].mac[2], sensors[idx].mac[3],
                   sensors[idx].mac[4], sensors[idx].mac[5]);
          prefs.begin("sensors", false);
          prefs.putString(nameKey, sanitized);
          prefs.end();
          Serial.printf("[MQTT] Sensor %s renamed to \"%s\"\n",
                        macStr.c_str(), sanitized);
        }
      }
    }
    return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLOUD SYNC — hub ↔ cloud sensor-list reconciliation
// The cloud is the single source of truth for which sensors are paired and
// their names.  On every MQTT connect the hub reports its local list and the
// cloud responds with its authoritative list; the hub then adjusts to match.
// ─────────────────────────────────────────────────────────────────────────────

// Rewrite the full sensor list into NVS (mac0…mac{n-1}, count, name keys).
// Used after any add/remove operation that changes the indexed mac slots.
void saveSensorsToNVS() {
  prefs.begin("sensors", false);
  prefs.putInt("count", sensorCount);
  for (int i = 0; i < sensorCount; i++) {
    char key[8];
    snprintf(key, sizeof(key), "mac%d", i);
    prefs.putBytes(key, sensors[i].mac, 6);
    char nameKey[10];
    snprintf(nameKey, sizeof(nameKey), "n%02X%02X%02X%02X",
             sensors[i].mac[2], sensors[i].mac[3],
             sensors[i].mac[4], sensors[i].mac[5]);
    prefs.putString(nameKey, sensors[i].name);
  }
  // Clear any stale indexed slots beyond the current count
  for (int i = sensorCount; i < MAX_SENSORS; i++) {
    char key[8];
    snprintf(key, sizeof(key), "mac%d", i);
    prefs.remove(key);
  }
  prefs.end();
}

// Publish the hub's current sensor list to the cloud so it can diff and reply.
// Payload: {"sensors":[{"mac":"AA:BB:CC:DD:EE:FF","name":"Room 1"},…]}
void publishSyncRequest() {
  if (!cloudConfigured || !mqttClient.connected()) return;

  // Build payload in a 1 KB heap buffer to accommodate up to MAX_SENSORS entries.
  const int BUF = 1024;
  char* buf = (char*)malloc(BUF);
  if (!buf) { Serial.println("[Sync] publishSyncRequest: malloc failed"); return; }

  int pos = 0;
  pos += snprintf(buf + pos, BUF - pos, "{\"sensors\":[");
  for (int i = 0; i < sensorCount && pos < BUF - 60; i++) {
    char macStr[18];
    snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
             sensors[i].mac[0], sensors[i].mac[1], sensors[i].mac[2],
             sensors[i].mac[3], sensors[i].mac[4], sensors[i].mac[5]);
    pos += snprintf(buf + pos, BUF - pos,
                    "%s{\"mac\":\"%s\",\"name\":\"%s\"}",
                    i > 0 ? "," : "", macStr, sensors[i].name);
  }
  pos += snprintf(buf + pos, BUF - pos, "]}");

  mqttClient.publish(topicSyncReq, buf);
  Serial.printf("[Sync] Sync request published (%d sensors, %d bytes)\n", sensorCount, pos);
  free(buf);
}

// Add a sensor that the cloud knows about but the hub does not.
// Registers the ESP-NOW encrypted peer and persists to NVS.
void addSensorFromCloud(const uint8_t* mac, const char* name) {
  if (sensorCount >= MAX_SENSORS) {
    Serial.println("[Sync] Max sensors reached — cannot add from cloud");
    return;
  }
  memcpy(sensors[sensorCount].mac, mac, 6);
  sensors[sensorCount].active           = false;
  sensors[sensorCount].temp             = 0;
  sensors[sensorCount].hum              = 0;
  sensors[sensorCount].rssi             = 0;
  sensors[sensorCount].battery          = 0;
  sensors[sensorCount].lastUpdate       = 0;
  sensors[sensorCount].log[0]           = '\0';
  sensors[sensorCount].logLen           = 0;
  sensors[sensorCount].logExpectedTotal = 0;
  sensors[sensorCount].logChunksRcvd    = 0;
  sensors[sensorCount].logUpdated       = 0;

  if (name && strlen(name) > 0) {
    strncpy(sensors[sensorCount].name, name, 19);
    sensors[sensorCount].name[19] = '\0';
  } else {
    sprintf(sensors[sensorCount].name, "Sensor-%02X%02X", mac[4], mac[5]);
  }
  sensorCount++;

  // Register as an encrypted ESP-NOW peer so the hub can receive its data frames
  if (!esp_now_is_peer_exist(mac)) {
    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, mac, 6);
    peer.channel = 0;
    peer.encrypt = true;
    memcpy(peer.lmk, LMK_KEY, 16);
    esp_now_add_peer(&peer);
  }

  // Persist
  char key[8];
  snprintf(key, sizeof(key), "mac%d", sensorCount - 1);
  char nameKey[10];
  snprintf(nameKey, sizeof(nameKey), "n%02X%02X%02X%02X", mac[2], mac[3], mac[4], mac[5]);
  prefs.begin("sensors", false);
  prefs.putBytes(key, mac, 6);
  prefs.putInt("count", sensorCount);
  prefs.putString(nameKey, sensors[sensorCount - 1].name);
  prefs.end();

  Serial.printf("[Sync] ✓ Added cloud sensor %02X:%02X:%02X:%02X:%02X:%02X (%s)\n",
                mac[0], mac[1], mac[2], mac[3], mac[4], mac[5],
                sensors[sensorCount - 1].name);
}

// Remove a sensor from memory, ESP-NOW peer table, and NVS.
void removeSensorByMac(const uint8_t* mac) {
  int idx = findSensor(mac);
  if (idx == -1) {
    Serial.println("[Sync] removeSensorByMac: sensor not found locally");
    return;
  }

  // Unregister ESP-NOW peer
  if (esp_now_is_peer_exist(mac)) esp_now_del_peer(mac);

  // Capture the NVS name key before the array shifts
  char nameKey[10];
  snprintf(nameKey, sizeof(nameKey), "n%02X%02X%02X%02X",
           sensors[idx].mac[2], sensors[idx].mac[3],
           sensors[idx].mac[4], sensors[idx].mac[5]);

  // Shift remaining entries down
  for (int i = idx; i < sensorCount - 1; i++) sensors[i] = sensors[i + 1];
  sensorCount--;
  memset(&sensors[sensorCount], 0, sizeof(SensorData));

  // Rewrite NVS: indexed mac slots + remove orphan name key
  prefs.begin("sensors", false);
  prefs.putInt("count", sensorCount);
  for (int i = 0; i < sensorCount; i++) {
    char key[8];
    snprintf(key, sizeof(key), "mac%d", i);
    prefs.putBytes(key, sensors[i].mac, 6);
  }
  char staleKey[8];
  snprintf(staleKey, sizeof(staleKey), "mac%d", sensorCount);
  prefs.remove(staleKey);
  prefs.remove(nameKey);  // orphan name key for the removed sensor
  prefs.end();

  Serial.printf("[Sync] ✓ Sensor removed. Remaining: %d\n", sensorCount);
}

// Apply the cloud's authoritative sensor list: add missing, remove extras, sync names.
// Payload format: {"sensors":[{"mac":"AA:BB:CC:DD:EE:FF","name":"Room 1"},…]}
void applySyncFromCloud(const String& json) {
  Serial.println("[Sync] Applying cloud sensor list...");

  // ── Step 1: parse cloud sensor list into a local temp array ───────────────
  uint8_t cloudMacs[MAX_SENSORS][6];
  char    cloudNames[MAX_SENSORS][20];
  int     cloudCount = 0;

  int pos = 0;
  while (cloudCount < MAX_SENSORS) {
    int macStart = json.indexOf("\"mac\":\"", pos);
    if (macStart == -1) break;
    macStart += 7;
    int macEnd = json.indexOf('"', macStart);
    if (macEnd == -1) break;

    String macStr = json.substring(macStart, macEnd);
    uint8_t mac[6];
    if (sscanf(macStr.c_str(), "%hhX:%hhX:%hhX:%hhX:%hhX:%hhX",
               &mac[0], &mac[1], &mac[2], &mac[3], &mac[4], &mac[5]) == 6) {
      memcpy(cloudMacs[cloudCount], mac, 6);

      // Look for "name" key between this "mac" and the next "mac" (or end of JSON)
      int nameSearch = macEnd;
      int nextMac    = json.indexOf("\"mac\":\"", macEnd);
      int nameStart  = json.indexOf("\"name\":\"", nameSearch);
      cloudNames[cloudCount][0] = '\0';
      if (nameStart != -1 && (nextMac == -1 || nameStart < nextMac)) {
        nameStart += 8;
        int nameEnd = json.indexOf('"', nameStart);
        if (nameEnd != -1) {
          String n = json.substring(nameStart, nameEnd);
          strncpy(cloudNames[cloudCount], n.c_str(), 19);
          cloudNames[cloudCount][19] = '\0';
        }
      }
      cloudCount++;
    }
    pos = macEnd + 1;
  }
  Serial.printf("[Sync] Cloud has %d sensor(s)\n", cloudCount);

  // ── Step 2: remove local sensors not in the cloud list ────────────────────
  // Iterate backwards so array shifts don't corrupt the loop index.
  if (millis() < pairingGraceUntil) {
    // A pairing just completed — the cloud may not have persisted the new
    // sensor yet, so its authoritative list could still be stale.  Skip
    // removals for the remainder of the grace window to avoid evicting the
    // sensor we literally just added.
    Serial.println("[Sync] Skipping removals — pairing grace window active");
  } else {
    for (int i = sensorCount - 1; i >= 0; i--) {
      bool inCloud = false;
      for (int j = 0; j < cloudCount; j++) {
        if (memcmp(sensors[i].mac, cloudMacs[j], 6) == 0) { inCloud = true; break; }
      }
      if (!inCloud) {
        Serial.printf("[Sync] Removing local sensor %02X:%02X:%02X:%02X:%02X:%02X (not in cloud)\n",
                      sensors[i].mac[0], sensors[i].mac[1], sensors[i].mac[2],
                      sensors[i].mac[3], sensors[i].mac[4], sensors[i].mac[5]);
        removeSensorByMac(sensors[i].mac);
      }
    }
  }

  // ── Step 3: add cloud sensors not in local list; update names ─────────────
  for (int j = 0; j < cloudCount; j++) {
    int idx = findSensor(cloudMacs[j]);
    if (idx == -1) {
      addSensorFromCloud(cloudMacs[j], cloudNames[j]);
    } else if (cloudNames[j][0] != '\0' &&
               strcmp(sensors[idx].name, cloudNames[j]) != 0) {
      // Name mismatch — cloud wins
      strncpy(sensors[idx].name, cloudNames[j], 19);
      sensors[idx].name[19] = '\0';
      char nameKey[10];
      snprintf(nameKey, sizeof(nameKey), "n%02X%02X%02X%02X",
               sensors[idx].mac[2], sensors[idx].mac[3],
               sensors[idx].mac[4], sensors[idx].mac[5]);
      prefs.begin("sensors", false);
      prefs.putString(nameKey, sensors[idx].name);
      prefs.end();
      Serial.printf("[Sync] Updated name for %02X:%02X%02X → %s\n",
                    sensors[idx].mac[3], sensors[idx].mac[4],
                    sensors[idx].mac[5], sensors[idx].name);
    }
  }

  Serial.printf("[Sync] Done. Local sensor count: %d\n", sensorCount);
}

// Connect to the MQTT broker over TLS and set up LWT + subscriptions.
// Returns true on success.  lastMqttState is set to the PubSubClient rc so
// callers (especially BLE provisioning) can report a meaningful error.
bool connectCloud() {
#ifdef OTA_ROLLBACK_TEST
  // Deliberately broken build used to prove app-level rollback actually fires.
  // The image boots normally but never reaches the cloud, so it can never
  // confirm itself — which is precisely the failure rollback exists to recover
  // from. Expect a self-reboot every OTA_VERIFY_WINDOW_MS and a revert to the
  // previous slot after OTA_MAX_BOOT_TRIES attempts.
  //
  // Only ever built by the xiao_esp32c6_hub_rollbacktest env. Never ship this.
  static bool warned = false;
  if (!warned) {
    warned = true;
    Serial.println("\n*** OTA_ROLLBACK_TEST BUILD — cloud connection disabled ***");
    Serial.println("*** This image cannot confirm itself and should revert. ***\n");
  }
  return false;
#endif
  if (!cloudConfigured) return false;

  // Tear down any prior TLS state. Stale mbedtls buffers from a previous
  // failed connect can otherwise prevent the next handshake from allocating
  // cleanly — especially during BLE provisioning while NimBLE is co-resident.
  wifiSecure.stop();

  // Encrypt the connection but skip CA certificate validation.
  // The broker address is trusted via network (VPS + Let's Encrypt TLS).
  wifiSecure.setInsecure();

  // Bound the TLS handshake. Without this, mbedtls retries internally for
  // ~130 s on a flaky connection (this is what produced the long "connecting"
  // hang the user observed). 15 s is plenty for a healthy network and gives
  // the BLE app a prompt failure instead of looking dead.
  wifiSecure.setHandshakeTimeout(15);

  mqttClient.setServer(mqttHost, mqttPort);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1024);  // sync payloads can reach ~500 bytes
  mqttClient.setKeepAlive(30);
  // Socket timeout: 10 s for the initial connection (TLS handshake on ESP32 can
  // take several seconds).  maintainCloud() tightens this to 3 s after the first
  // successful connect so that reconnect attempts don't block ESP-NOW.
  mqttClient.setSocketTimeout(10);

  Serial.printf("[MQTT] Free heap before connect: %u bytes (min seen: %u)\n",
                ESP.getFreeHeap(), ESP.getMinFreeHeap());

  // Client ID includes last 3 MAC octets so it is unique per device
  uint8_t mac[6]; WiFi.macAddress(mac);
  char clientId[24];
  snprintf(clientId, sizeof(clientId), "TempHub-%02X%02X%02X", mac[3], mac[4], mac[5]);

  // LWT: broker publishes this if MQTT connection drops unexpectedly
  const char* lwt = "{\"online\":false}";

  Serial.printf("[MQTT] Connecting to %s:%d as \"%s\"...\n", mqttHost, mqttPort, mqttUser);
  if (!mqttClient.connect(clientId, mqttUser, mqttPass, topicStatus, 0, true, lwt)) {
    lastMqttState = mqttClient.state();
    Serial.printf("[MQTT] Connection failed (state %d)\n", lastMqttState);
    return false;
  }
  lastMqttState = 0;

  Serial.println("[MQTT] Connected!");
  mqttClient.subscribe(topicPairResp);
  // Cloud-sync subscriptions: hub receives sensor-list updates from cloud
  mqttClient.subscribe(topicSync);
  mqttClient.subscribe(topicSensorRemove);
  mqttClient.subscribe(topicSensorRename);
  mqttClient.subscribe(topicPairEnable);
  mqttClient.subscribe(topicOtaCmd);
  mqttClient.subscribe(topicCfgSet);
  {
    char sub[96];
    snprintf(sub, sizeof(sub), "%s+", topicSensorOta);
    mqttClient.subscribe(sub);
  }
  mqttClient.subscribe(topicLiveReq);

  // Publish retained online status so the dashboard sees us immediately.
  // fw is what the cloud compares against the firmware registry to decide
  // whether this hub has an OTA update pending.
  String status = "{\"online\":true,\"ip\":\"" + WiFi.localIP().toString() +
                  "\",\"fw\":\"" FW_VERSION "\",\"img_state\":\"" + otaBootStateName + "\"}";
  mqttClient.publish(topicStatus, status.c_str(), /*retain=*/true);

  // WiFi up, MQTT connected, publish accepted — this image has now done the one
  // job that matters, so it is safe to cancel the bootloader's pending rollback.
  confirmFirmwareValid();
  return true;
}

// Publish all readings that were buffered while MQTT was offline.
// Called immediately after a successful (re)connect so readings are flushed
// in the order they were received and with their original timestamps.
// Mirror the newest queued readings to NVS. Each entry already carries the
// timestamp captured when the reading arrived, so a restored reading is stored
// at its true time rather than the time it was eventually flushed.
void saveOfflineBuffer() {
  Preferences bp;
  bp.begin("buf", false);

  if (bufCount == 0) {
    if (bp.isKey("q")) bp.remove("q");   // remove() logs an error if absent
  } else {
    int n = bufCount > OFFLINE_PERSIST_MAX ? OFFLINE_PERSIST_MAX : bufCount;
    static BufferedReading tmp[OFFLINE_PERSIST_MAX];
    // Keep the newest n, in chronological order.
    int start = (bufHead - n + OFFLINE_BUFFER_SIZE) % OFFLINE_BUFFER_SIZE;
    for (int i = 0; i < n; i++) {
      tmp[i] = offlineBuf[(start + i) % OFFLINE_BUFFER_SIZE];
    }
    bp.putBytes("q", tmp, n * sizeof(BufferedReading));
  }
  bp.end();
}

void loadOfflineBuffer() {
  Preferences bp;
  bp.begin("buf", true);
  size_t len = bp.getBytesLength("q");

  if (len >= sizeof(BufferedReading) && (len % sizeof(BufferedReading)) == 0) {
    int n = len / sizeof(BufferedReading);
    if (n > OFFLINE_BUFFER_SIZE) n = OFFLINE_BUFFER_SIZE;
    bp.getBytes("q", offlineBuf, n * sizeof(BufferedReading));
    bufTail  = 0;
    bufHead  = n % OFFLINE_BUFFER_SIZE;
    bufCount = n;
    Serial.printf("[Buffer] Restored %d reading(s) queued before the last reboot\n", n);
  }
  bp.end();
}

void flushOfflineBuffer() {
  if (bufCount == 0) return;
  Serial.printf("[Buffer] Flushing %d buffered reading(s)...\n", bufCount);

  while (bufCount > 0 && mqttClient.connected()) {
    const BufferedReading& r = offlineBuf[bufTail];

    char sensorMacStr[18];
    snprintf(sensorMacStr, sizeof(sensorMacStr),
             "%02X:%02X:%02X:%02X:%02X:%02X",
             r.mac[0], r.mac[1], r.mac[2],
             r.mac[3], r.mac[4], r.mac[5]);

    char payload[220];
    snprintf(payload, sizeof(payload),
             "{\"sensor_mac\":\"%s\",\"temp\":%.2f,\"hum\":%.2f,"
             "\"battery\":%d,\"rssi\":%d,\"ts\":\"%s\"}",
             sensorMacStr, r.temp, r.hum, r.battery, r.rssi, r.ts);

    mqttClient.publish(topicData, payload);
    mqttClient.loop();   // let PubSubClient process the outgoing packet

    bufTail = (bufTail + 1) % OFFLINE_BUFFER_SIZE;
    bufCount--;

    delay(20);   // brief yield to avoid flooding the broker
  }

  offlineBufDirty = true;   // stored copy must match whatever is left

  if (bufCount == 0) {
    Serial.println("[Buffer] Flush complete.");
  } else {
    Serial.printf("[Buffer] Flush interrupted — %d reading(s) remain.\n", bufCount);
  }
}

// Call every loop() iteration: keeps MQTT alive and reconnects after drops.
void maintainCloud() {
  if (!cloudConfigured) return;
  if (WiFi.status() != WL_CONNECTED) return;  // no WiFi → no TCP; don't block the radio
  if (mqttClient.connected()) {
    mqttClient.loop();
    return;
  }
  if (millis() - lastMqttReconnect < MQTT_RECONNECT_MS) return;
  lastMqttReconnect = millis();
  Serial.println("[MQTT] Reconnecting...");
  if (connectCloud()) {
    // Tighten socket timeout for normal operation so reconnect attempts
    // don't block the loop() and starve ESP-NOW ACKs.
    mqttClient.setSocketTimeout(3);
    publishSyncRequest();
    flushOfflineBuffer();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIRMWARE OTA
// ─────────────────────────────────────────────────────────────────────────────

void publishOtaStatus(const char* state, int pct, const char* err) {
  if (!mqttClient.connected()) return;
  char payload[224];
  if (err && *err) {
    snprintf(payload, sizeof(payload),
             "{\"state\":\"%s\",\"version\":\"%s\",\"pct\":%d,\"error\":\"%s\",\"fw\":\"" FW_VERSION "\"}",
             state, otaVersion, pct, err);
  } else {
    snprintf(payload, sizeof(payload),
             "{\"state\":\"%s\",\"version\":\"%s\",\"pct\":%d,\"fw\":\"" FW_VERSION "\"}",
             state, otaVersion, pct);
  }
  mqttClient.publish(topicOtaStatus, payload);
  mqttClient.loop();
}

// Parse 64 hex chars into a 32-byte digest. Returns false on any bad character
// so a malformed command fails closed rather than comparing against garbage.
static bool hexToDigest(const char* hex, uint8_t* out) {
  if (strlen(hex) != 64) return false;
  for (int i = 0; i < 32; i++) {
    int hi = hex[i * 2], lo = hex[i * 2 + 1];
    auto nib = [](int c) -> int {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      return -1;
    };
    int h = nib(hi), l = nib(lo);
    if (h < 0 || l < 0) return false;
    out[i] = (uint8_t)((h << 4) | l);
  }
  return true;
}

// Verify the base64 DER ECDSA signature in otaSigB64 against a SHA-256 digest,
// using the compiled-in public key.
static bool verifyImageSignature(const uint8_t* digest) {
  uint8_t sig[128];
  size_t  sigLen = 0;
  if (mbedtls_base64_decode(sig, sizeof(sig), &sigLen,
                            (const unsigned char*)otaSigB64, strlen(otaSigB64)) != 0) {
    Serial.println("[OTA] Signature is not valid base64");
    return false;
  }

  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  int rc = mbedtls_pk_parse_public_key(&pk, FW_PUBLIC_KEY, sizeof(FW_PUBLIC_KEY));
  if (rc != 0) {
    Serial.printf("[OTA] Public key parse failed (-0x%04X)\n", -rc);
    mbedtls_pk_free(&pk);
    return false;
  }

  rc = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, digest, 32, sig, sigLen);
  mbedtls_pk_free(&pk);

  if (rc != 0) {
    Serial.printf("[OTA] Signature verification FAILED (-0x%04X)\n", -rc);
    return false;
  }
  Serial.println("[OTA] Signature OK");
  return true;
}

// Download, verify, and stage a firmware image. Runs from loop(), never from
// the MQTT callback. On success this function does not return — it reboots.
void performOtaUpdate() {
  otaInProgress = true;
  Serial.printf("[OTA] Starting update to %s from %s\n", otaVersion, otaUrl);

  uint8_t expected[32];
  if (!hexToDigest(otaSha256, expected)) {
    publishOtaStatus("failed", 0, "bad sha256 in command");
    otaInProgress = false;
    return;
  }

  const esp_partition_t* target = esp_ota_get_next_update_partition(NULL);
  if (!target) {
    publishOtaStatus("failed", 0, "no OTA partition");
    otaInProgress = false;
    return;
  }

  // Plain HTTP by design: the image is signature-verified below, and the hub
  // does not authenticate TLS certificates anyway, so HTTPS would add no
  // authenticity here — only a second concurrent TLS session competing with
  // the MQTT socket for heap.
  WiFiClient  net;
  HTTPClient  http;
  http.setTimeout(OTA_HTTP_TIMEOUT_MS);
  http.setConnectTimeout(OTA_HTTP_TIMEOUT_MS);
  if (!http.begin(net, otaUrl)) {
    publishOtaStatus("failed", 0, "bad url");
    otaInProgress = false;
    return;
  }

  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    char err[48];
    snprintf(err, sizeof(err), "http %d", code);
    publishOtaStatus("failed", 0, err);
    http.end();
    otaInProgress = false;
    return;
  }

  int total = http.getSize();
  if (total <= 0) {
    publishOtaStatus("failed", 0, "no content-length");
    http.end();
    otaInProgress = false;
    return;
  }
  if ((size_t)total > target->size) {
    publishOtaStatus("failed", 0, "image larger than partition");
    http.end();
    otaInProgress = false;
    return;
  }

  esp_ota_handle_t handle = 0;
  esp_err_t err = esp_ota_begin(target, total, &handle);
  if (err != ESP_OK) {
    publishOtaStatus("failed", 0, "ota_begin failed");
    http.end();
    otaInProgress = false;
    return;
  }

  mbedtls_md_context_t md;
  mbedtls_md_init(&md);
  mbedtls_md_setup(&md, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
  mbedtls_md_starts(&md);

  publishOtaStatus("downloading", 0, nullptr);

  WiFiClient* stream = http.getStreamPtr();
  uint8_t buf[OTA_BUF_SIZE];
  int written = 0, lastPct = 0;
  unsigned long lastData = millis();
  bool ok = true;

  while (written < total) {
    size_t avail = stream->available();
    if (avail == 0) {
      if (millis() - lastData > OTA_HTTP_TIMEOUT_MS) {
        Serial.println("[OTA] Download stalled");
        ok = false;
        break;
      }
      delay(1);
      continue;
    }
    lastData = millis();

    int n = stream->readBytes(buf, avail > sizeof(buf) ? sizeof(buf) : avail);
    if (n <= 0) continue;

    if (esp_ota_write(handle, buf, n) != ESP_OK) {
      Serial.println("[OTA] Flash write failed");
      ok = false;
      break;
    }
    mbedtls_md_update(&md, buf, n);
    written += n;

    int pct = (int)((int64_t)written * 100 / total);
    if (pct >= lastPct + 10) {
      lastPct = pct;
      Serial.printf("[OTA] %d%% (%d/%d)\n", pct, written, total);
      // Doubles as MQTT keepalive traffic during a download that can outlast
      // the 30 s keepalive interval.
      publishOtaStatus("downloading", pct, nullptr);
    }
  }

  http.end();

  uint8_t digest[32];
  mbedtls_md_finish(&md, digest);
  mbedtls_md_free(&md);

  if (!ok || written != total) {
    esp_ota_abort(handle);
    publishOtaStatus("failed", lastPct, "download incomplete");
    otaInProgress = false;
    return;
  }

  publishOtaStatus("verifying", 100, nullptr);

  if (memcmp(digest, expected, 32) != 0) {
    Serial.println("[OTA] SHA-256 mismatch");
    esp_ota_abort(handle);
    publishOtaStatus("failed", 100, "sha256 mismatch");
    otaInProgress = false;
    return;
  }

  if (!verifyImageSignature(digest)) {
    esp_ota_abort(handle);
    publishOtaStatus("failed", 100, "signature invalid");
    otaInProgress = false;
    return;
  }

  if (esp_ota_end(handle) != ESP_OK) {
    publishOtaStatus("failed", 100, "image rejected by esp_ota_end");
    otaInProgress = false;
    return;
  }

  if (esp_ota_set_boot_partition(target) != ESP_OK) {
    publishOtaStatus("failed", 100, "set_boot_partition failed");
    otaInProgress = false;
    return;
  }

  // Arm app-level rollback before handing control to the new image. If it
  // cannot reach the cloud, checkOtaPendingVerify() reverts to this slot after
  // OTA_MAX_BOOT_TRIES attempts.
  {
    Preferences otaPrefs;
    otaPrefs.begin("ota", false);
    otaPrefs.putBool("unconf", true);
    otaPrefs.putUChar("tries", 0);
    otaPrefs.end();
  }

  Serial.println("[OTA] Verified and staged — rebooting");
  publishOtaStatus("rebooting", 100, nullptr);
  delay(300);          // let the MQTT packet leave before the reset
  ESP.restart();
}

// Called once at boot. If the bootloader handed us an image it has not been
// told is good, we must confirm it before the next reboot or it rolls back.
void checkOtaPendingVerify() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t state;
  esp_err_t err = esp_ota_get_state_partition(running, &state);

  // Always log the state. Whether the bootloader actually arms rollback is the
  // single assumption the whole safety story rests on, and it is invisible
  // otherwise — an image that is VALID on first boot never had a rollback net.
  const char* name = "?";
  if (err == ESP_OK) {
    switch (state) {
      case ESP_OTA_IMG_NEW:            name = "NEW";            break;
      case ESP_OTA_IMG_PENDING_VERIFY: name = "PENDING_VERIFY"; break;
      case ESP_OTA_IMG_VALID:          name = "VALID";          break;
      case ESP_OTA_IMG_INVALID:        name = "INVALID";        break;
      case ESP_OTA_IMG_ABORTED:        name = "ABORTED";        break;
      default:                         name = "UNDEFINED";      break;
    }
  }
  strncpy(otaBootStateName, (err == ESP_OK) ? name : "unavailable",
          sizeof(otaBootStateName) - 1);
  otaBootStateName[sizeof(otaBootStateName) - 1] = 0;
  Serial.printf("[OTA] Booted from '%s', image state: %s\n",
                running ? running->label : "?",
                (err == ESP_OK) ? name : "unavailable");

  if (err == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
    otaPendingVerify = true;
    Serial.println("[OTA] Bootloader rollback is armed");
  }

  // App-level rollback. Runs regardless of the bootloader's behaviour, because
  // on this hardware the bootloader does not arm its own (see the note above
  // OTA_MAX_BOOT_TRIES).
  Preferences otaPrefs;
  otaPrefs.begin("ota", false);
  bool    unconfirmed = otaPrefs.getBool("unconf", false);
  uint8_t tries       = otaPrefs.getUChar("tries", 0);
  otaPrefs.getString("rejected", otaRejectedVersion, sizeof(otaRejectedVersion));
  if (otaRejectedVersion[0]) {
    Serial.printf("[OTA] Version %s previously rolled back — will not reinstall\n",
                  otaRejectedVersion);
  }

  if (unconfirmed) {
    tries++;
    Serial.printf("[OTA] Unconfirmed image, boot attempt %u of %u\n",
                  tries, OTA_MAX_BOOT_TRIES);

    if (tries > OTA_MAX_BOOT_TRIES) {
      // Give up and go back. The previous image is still intact in the other
      // slot, which is exactly what esp_ota_get_next_update_partition() returns
      // while the new one is running.
      const esp_partition_t* previous = esp_ota_get_next_update_partition(NULL);
      otaPrefs.putBool("unconf", false);
      otaPrefs.putUChar("tries", 0);
      // Remember what we are abandoning. Without this, the retained command that
      // delivered this image is handed back on the very next reconnect and the
      // hub reinstalls it — a rollback loop that looks healthy from outside.
      otaPrefs.putString("rejected", FW_VERSION);
      otaPrefs.end();

      if (previous && esp_ota_set_boot_partition(previous) == ESP_OK) {
        Serial.printf("[OTA] Giving up on this image — reverting to '%s'\n",
                      previous->label);
      } else {
        Serial.println("[OTA] Revert failed — continuing on the current image");
      }
      delay(200);
      ESP.restart();
    }

    otaPrefs.putUChar("tries", tries);
    otaUnconfirmed    = true;
    otaVerifyDeadline = millis() + OTA_VERIFY_WINDOW_MS;
  }
  otaPrefs.end();
}

// Confirm the running image only once it has proven it can do its job: WiFi up,
// MQTT connected, and a publish accepted. Confirming any earlier would defeat
// the rollback — a firmware that boots but cannot reach the cloud is exactly
// the failure we need to recover from, and a hub we cannot reach is a hub we
// cannot fix remotely.
void confirmFirmwareValid() {
  if (otaStatusSettled) return;   // once per boot, not per MQTT reconnect
  otaStatusSettled = true;

  if (otaPendingVerify) {
    otaPendingVerify = false;
    if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
      Serial.println("[OTA] Image confirmed good — bootloader rollback cancelled");
    } else {
      Serial.println("[OTA] Failed to mark image valid");
    }
  }

  // Clear the app-level counter: WiFi is up, MQTT is connected, and a publish
  // was accepted, which is the whole job this firmware exists to do.
  if (otaUnconfirmed) {
    otaUnconfirmed = false;
    Preferences otaPrefs;
    otaPrefs.begin("ota", false);
    otaPrefs.putBool("unconf", false);
    otaPrefs.putUChar("tries", 0);
    otaPrefs.end();
    Serial.println("[OTA] Image proved itself — rollback disarmed");
  }

  // Publish a terminal status on every boot, not only when rollback was armed.
  // Without this the dashboard is stuck showing "rebooting" forever on any hub
  // whose bootloader does not arm rollback, which also leaves the Install
  // button disabled and blocks the next update.
  strncpy(otaVersion, FW_VERSION, sizeof(otaVersion) - 1);
  otaVersion[sizeof(otaVersion) - 1] = '\0';
  publishOtaStatus("confirmed", 100, nullptr);
}

// ─────────────────────────────────────────────────────────────────────────────
// SENSOR REMOTE CONFIG
// ─────────────────────────────────────────────────────────────────────────────

// Desired config is held in NVS as well as RAM: a change that has not reached
// its sensor yet must survive a hub reboot, otherwise a node that happens to be
// mid-cycle silently never gets it.
void saveSensorConfig(int idx) {
  if (idx < 0 || idx >= sensorCount) return;
  char key[24];
  Preferences cp;
  cp.begin("scfg", false);
  snprintf(key, sizeof(key), "%02X%02X%02X%02X%02X%02X",
           sensors[idx].mac[0], sensors[idx].mac[1], sensors[idx].mac[2],
           sensors[idx].mac[3], sensors[idx].mac[4], sensors[idx].mac[5]);
  config_message blob = {};
  blob.msgType     = MSG_CONFIG;
  blob.schema      = 1;
  blob.cfg_ver     = sensors[idx].cfgDesiredVer;
  blob.sleep_secs  = sensors[idx].cfgSleepSecs;
  blob.sh_a        = sensors[idx].cfgShA;
  blob.sh_b        = sensors[idx].cfgShB;
  blob.sh_c        = sensors[idx].cfgShC;
  blob.r_series    = sensors[idx].cfgRSeries;
  cp.putBytes(key, &blob, sizeof(blob));
  cp.end();
}

void loadSensorConfig(int idx) {
  if (idx < 0 || idx >= sensorCount) return;
  char key[24];
  Preferences cp;
  cp.begin("scfg", true);
  snprintf(key, sizeof(key), "%02X%02X%02X%02X%02X%02X",
           sensors[idx].mac[0], sensors[idx].mac[1], sensors[idx].mac[2],
           sensors[idx].mac[3], sensors[idx].mac[4], sensors[idx].mac[5]);
  config_message blob = {};
  if (cp.getBytes(key, &blob, sizeof(blob)) == sizeof(blob) && blob.cfg_ver != 0) {
    sensors[idx].cfgDesiredVer = blob.cfg_ver;
    sensors[idx].cfgSleepSecs  = blob.sleep_secs;
    sensors[idx].cfgShA        = blob.sh_a;
    sensors[idx].cfgShB        = blob.sh_b;
    sensors[idx].cfgShC        = blob.sh_c;
    sensors[idx].cfgRSeries    = blob.r_series;
    sensors[idx].cfgPending    = true;   // resolved on first contact
  }
  cp.end();
}

// Report what a sensor is actually running, so the dashboard can tell a landed
// change from a pending one rather than guessing.
void publishConfigState(int idx) {
  if (idx < 0 || idx >= sensorCount) return;
  if (!cloudConfigured || !mqttClient.connected()) return;

  char mac[18];
  snprintf(mac, sizeof(mac), "%02X:%02X:%02X:%02X:%02X:%02X",
           sensors[idx].mac[0], sensors[idx].mac[1], sensors[idx].mac[2],
           sensors[idx].mac[3], sensors[idx].mac[4], sensors[idx].mac[5]);

  char payload[224];
  snprintf(payload, sizeof(payload),
    "{\"sensor_mac\":\"%s\",\"applied_cfg_ver\":%u,\"desired_cfg_ver\":%u,"
    "\"pending\":%s,\"sleep_secs\":%u,\"sh_a\":%.6e,\"sh_b\":%.6e,\"sh_c\":%.6e,\"r_series\":%.1f}",
    mac, sensors[idx].cfg_ver, sensors[idx].cfgDesiredVer,
    sensors[idx].cfgPending ? "true" : "false",
    sensors[idx].cfgSleepSecs, sensors[idx].cfgShA, sensors[idx].cfgShB,
    sensors[idx].cfgShC, sensors[idx].cfgRSeries);

  mqttClient.publish(topicCfgState, payload);
}

// Called from OnDataRecv the moment a sensor reports in — that frame is the only
// time the node is awake and listening, so the push has to happen here.
void pushConfigIfPending(int idx, const uint8_t* mac) {
  if (idx < 0 || idx >= sensorCount) return;
  if (!sensors[idx].cfgPending) return;

  if (sensors[idx].cfg_ver == sensors[idx].cfgDesiredVer) {
    sensors[idx].cfgPending = false;      // the sensor has it
    Serial.printf("[CFG] Sensor confirmed config v%u\n", sensors[idx].cfg_ver);
    publishConfigState(idx);
    return;
  }

  config_message cfg = {};
  cfg.msgType     = MSG_CONFIG;
  cfg.schema      = 1;
  cfg.cfg_ver     = sensors[idx].cfgDesiredVer;
  cfg.sleep_secs  = sensors[idx].cfgSleepSecs;
  cfg.sh_a        = sensors[idx].cfgShA;
  cfg.sh_b        = sensors[idx].cfgShB;
  cfg.sh_c        = sensors[idx].cfgShC;
  cfg.r_series    = sensors[idx].cfgRSeries;

  if (esp_now_send(mac, (uint8_t*)&cfg, sizeof(cfg)) == ESP_OK) {
    Serial.printf("[CFG] Pushed config v%u to sensor\n", cfg.cfg_ver);
  } else {
    Serial.println("[CFG] Push failed — will retry on the next reading");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SENSOR OTA RELAY
// ─────────────────────────────────────────────────────────────────────────────
//
// The hub cannot store a sensor image: after two 1920 KiB app slots its flash
// has 128 KiB of SPIFFS against a ~1 MB image. So it streams -- pulling ranges
// over HTTP and pushing them straight out over ESP-NOW, holding only one chunk
// in RAM.
//
// One sensor at a time. The transfer blocks the hub for a few seconds; readings
// arriving meanwhile are handled by the ESP-NOW callback and buffered as usual.

static const char *sensorOtaResultName(uint8_t r) {
  switch (r) {
    case 0: return "ok";
    case 1: return "sha256 mismatch";
    case 2: return "signature invalid";
    case 3: return "flash write failed";
    case 4: return "not a valid image";
    case 5: return "timed out";
    default: return "unknown";
  }
}

static const char *sensorOtaDeclineName(uint8_t r) {
  switch (r) {
    case 1: return "already on this version";
    case 2: return "battery too low";
    case 3: return "no usable partition";
    case 4: return "image too large";
    case 5: return "previous image not confirmed";
    default: return "declined";
  }
}

// Tell the cloud a live request actually reached the node. Without this the
// dashboard can only say it asked -- it cannot say the sensor is awake, which
// is the part someone watching a live reading needs to know.
void publishLiveState(const uint8_t *mac, uint16_t durationS, uint16_t intervalS) {
  if (!cloudConfigured || !mqttClient.connected()) return;
  char macStr[18];
  snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  char payload[160];
  snprintf(payload, sizeof(payload),
    "{\"sensor_mac\":\"%s\",\"state\":\"%s\",\"duration_s\":%u,\"interval_s\":%u}",
    macStr, durationS == 0 ? "stopped" : "started",
    (unsigned)durationS, (unsigned)intervalS);
  mqttClient.publish(topicLiveState, payload);
  mqttClient.loop();
}

void publishSensorOtaStatus(const char *state, int pct, const char *err) {
  if (!cloudConfigured || !mqttClient.connected()) return;
  char mac[18];
  snprintf(mac, sizeof(mac), "%02X:%02X:%02X:%02X:%02X:%02X",
           sOtaMac[0], sOtaMac[1], sOtaMac[2], sOtaMac[3], sOtaMac[4], sOtaMac[5]);
  char payload[256];
  if (err && *err) {
    snprintf(payload, sizeof(payload),
      "{\"sensor_mac\":\"%s\",\"state\":\"%s\",\"version\":\"%s\",\"pct\":%d,\"error\":\"%s\"}",
      mac, state, sOtaVersion, pct, err);
  } else {
    snprintf(payload, sizeof(payload),
      "{\"sensor_mac\":\"%s\",\"state\":\"%s\",\"version\":\"%s\",\"pct\":%d}",
      mac, state, sOtaVersion, pct);
  }
  mqttClient.publish(topicSensorOtaStatus, payload);
  mqttClient.loop();
}

// Prepare the frame the sensor will be sent. Done once, at staging time.
bool buildSensorOtaOffer(int slot, const char *version, const char *url,
                         const char *sha, const char *sigB64) {
  ota_offer_message offer = {};
  offer.msgType = MSG_OTA_OFFER;
  offer.schema  = 1;

  uint32_t nowVer = 0;
  esp_now_get_version(&nowVer);
  offer.chunkSize = (nowVer >= 2) ? 1024 : 240;

  if (!hexToDigest(sha, offer.sha256)) return false;

  size_t sigLen = 0;
  if (mbedtls_base64_decode(offer.sig, sizeof(offer.sig), &sigLen,
                            (const unsigned char *)sigB64, strlen(sigB64)) != 0) {
    Serial.println("[SOTA] Signature is not valid base64");
    return false;
  }
  offer.sigLen = (uint8_t)sigLen;
  strncpy(offer.version, version, sizeof(offer.version));

  // The image size is not known until the first range request, so ask the
  // server for it before offering -- the sensor needs it to size the transfer.
  WiFiClient net;
  HTTPClient http;
  http.setTimeout(OTA_HTTP_TIMEOUT_MS);
  http.setConnectTimeout(OTA_HTTP_TIMEOUT_MS);
  if (!http.begin(net, url)) return false;
  int code = http.GET();
  int total = http.getSize();
  http.end();
  if (code != HTTP_CODE_OK || total <= 0) {
    Serial.printf("[SOTA] Cannot size image (http %d)\n", code);
    return false;
  }
  offer.imageSize = (uint32_t)total;

  StagedImage &st = sOtaStaged[slot];
  st.offer = offer;
  strncpy(st.version, version, sizeof(st.version) - 1);
  st.version[sizeof(st.version) - 1] = 0;
  strncpy(st.url, url, sizeof(st.url) - 1);
  st.url[sizeof(st.url) - 1] = 0;
  return true;
}

// Wait for the node's answer to an offer already sent from the receive
// callback, and run the transfer if it accepts. Only this part is deferred to
// loop(), because only this part blocks for seconds.
void offerSensorOta(const uint8_t *mac) {
  if (!sOtaRunning || sOtaActive < 0) return;   // claimed when the offer went out
  const ota_offer_message &offer = sOtaStaged[sOtaActive].offer;

  // Measured from when the offer was sent, not from when loop() reached here:
  // whatever the callback did afterwards has already spent the node's patience.
  while (!sOtaReqReady && millis() - otaOfferSentAt < 1200) delay(2);

  if (!sOtaReqReady) {
    Serial.println("[SOTA] No answer - node was not listening for an offer");
    sOtaRunning = false;
    flushOfflineBuffer();
    return;
  }

  if (!sOtaReqAccept) {
    const char *why = sensorOtaDeclineName(sOtaReqReason);
    Serial.printf("[SOTA] Sensor declined: %s\n", why);
    publishSensorOtaStatus("declined", 0, why);
    if (sOtaReqReason == 1) sOtaStaged[sOtaActive].used = false;   // already has it
    sOtaRunning = false;
    flushOfflineBuffer();
    return;
  }

  streamImageToSensor(mac, offer.imageSize, offer.chunkSize);
  sOtaRunning = false;
  flushOfflineBuffer();   // readings that arrived while the radio was busy
}

// Pump the image out chunk by chunk. Rewinding is done with a fresh HTTP range
// request rather than by buffering: the hub has nowhere to keep a megabyte, and
// at close range a rewind is rare enough that reopening costs less than the RAM
// would.
void streamImageToSensor(const uint8_t *mac, uint32_t imageSize, uint16_t chunkSize) {
  uint32_t expected = (imageSize + chunkSize - 1) / chunkSize;
  uint32_t seq = 0;
  uint8_t  frame[4 + OTA_MAX_CHUNK];
  unsigned long started = millis();
  int lastPct = -1;

  publishSensorOtaStatus("sending", 0, nullptr);

  // Armed before the first chunk, not after the last. The sensor sends its
  // result as soon as it has every chunk, which can be while the hub is still
  // resending a tail it thinks was missed; clearing this afterwards would throw
  // that result away.
  sOtaDoneReady = false;
  int tailRetries = 0;

  while (seq < expected && !sOtaDoneReady) {
    if (millis() - started > 180000UL) {
      publishSensorOtaStatus("failed", lastPct < 0 ? 0 : lastPct, "timed out");
      return;
    }

    // Open a range request at the current position. One connection serves a
    // whole window; it is reopened only when the sensor asks us to go back.
    WiFiClient net;
    HTTPClient http;
    http.setTimeout(OTA_HTTP_TIMEOUT_MS);
    http.setConnectTimeout(OTA_HTTP_TIMEOUT_MS);
    if (!http.begin(net, sOtaStaged[sOtaActive].url)) {
      publishSensorOtaStatus("failed", 0, "bad url");
      return;
    }
    char range[48];
    snprintf(range, sizeof(range), "bytes=%u-", (unsigned)(seq * chunkSize));
    http.addHeader("Range", range);
    int code = http.GET();
    if (code != HTTP_CODE_OK && code != HTTP_CODE_PARTIAL_CONTENT) {
      char err[40];
      snprintf(err, sizeof(err), "http %d", code);
      publishSensorOtaStatus("failed", 0, err);
      http.end();
      return;
    }

    WiFiClient *stream = http.getStreamPtr();
    bool reopen = false;

    while (seq < expected && !reopen && !sOtaDoneReady) {
      uint32_t offset = seq * chunkSize;
      uint16_t want   = (uint16_t)((imageSize - offset > chunkSize) ? chunkSize
                                                                    : (imageSize - offset));
      int got = stream->readBytes(frame + 4, want);
      if (got != (int)want) { reopen = true; break; }   // stream stalled - reopen

      frame[0] = MSG_OTA_DATA;
      uint16_t s16 = (uint16_t)seq;
      memcpy(frame + 1, &s16, 2);
      frame[3] = 0;

      if (esp_now_send(mac, frame, 4 + want) != ESP_OK) {
        delay(5);
        continue;   // radio queue full - the sensor has not moved on
      }
      seq++;

      // The sensor acknowledges every eight chunks. Waiting for it is what
      // keeps the two sides in step; without it the radio queue would simply
      // overrun a node busy writing flash.
      if ((seq % 8) == 0 || seq == expected) {
        sOtaAckReady = false;
        unsigned long waited = millis();
        // Deliberately longer than the sensor's 4 s resend interval. When the
        // two are equal the hub gives up in the same instant the sensor is
        // about to ask for what it missed, and the two sides never meet.
        while (!sOtaAckReady && millis() - waited < 9000) delay(2);

        if (!sOtaAckReady) {
          // Silence at the end of the image is not completion. The loop below
          // would exit on seq == expected and leave the sensor waiting for
          // chunks it never got, so rewind and offer the tail again -- it
          // ignores anything it already holds, and asks for what it needs.
          if (seq >= expected && ++tailRetries <= 4) {
            Serial.printf("[SOTA] No final ack - resending the tail (%d)\n", tailRetries);
            seq = (seq > 8) ? seq - 8 : 0;
          }
          reopen = true;
          break;
        }

        if (sOtaAckStatus != 0 || sOtaAckNext != (uint16_t)seq) {
          seq = sOtaAckNext;      // sensor wants an earlier chunk
          reopen = true;
          break;
        }

        int pct = (int)((uint64_t)seq * 100 / expected);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          Serial.printf("[SOTA] %d%%\n", pct);
          publishSensorOtaStatus("sending", pct, nullptr);
        }
      }
    }
    http.end();
  }

  // The sensor hashes the image, verifies the signature, validates the written
  // partition and writes NVS before answering, so this waits on flash work
  // rather than on the radio -- hence the margin over the 4 s chunk window.
  unsigned long waited = millis();
  while (!sOtaDoneReady && millis() - waited < 45000) delay(5);

  if (!sOtaDoneReady) {
    // Two different silences. If the tail was resent and still never
    // acknowledged, the sensor is missing chunks and cannot have installed
    // anything. If the transfer ran clean to the end, the only thing lost is
    // the result frame, and the node may well be running the new image -- its
    // next reading settles that one.
    if (tailRetries > 0) {
      Serial.println("[SOTA] Sensor stopped acknowledging - image incomplete, not installed");
      publishSensorOtaStatus("failed", 100, "incomplete - sensor stopped acknowledging");
    } else {
      Serial.println("[SOTA] No result from sensor - check the version it reports next");
      publishSensorOtaStatus("failed", 100, "no result - may have installed anyway");
    }
    return;
  }
  if (sOtaDoneResult == 0) {
    Serial.println("[SOTA] Sensor accepted the image and is rebooting");
    publishSensorOtaStatus("installed", 100, nullptr);
    sOtaStaged[sOtaActive].used = false;
  } else {
    const char *why = sensorOtaResultName(sOtaDoneResult);
    Serial.printf("[SOTA] Sensor rejected the image: %s\n", why);
    publishSensorOtaStatus("failed", 100, why);
    sOtaStaged[sOtaActive].used = false;   // it will fail identically next time
  }
}

// Complete an ESP-NOW pairing handshake (used by both auto-accept and cloud-approve paths).
void completePairing(const uint8_t* mac) {
  esp_now_peer_info_t tempPeer = {};
  memcpy(tempPeer.peer_addr, mac, 6);
  tempPeer.channel = 0;
  tempPeer.encrypt = false;

  if (!esp_now_is_peer_exist(mac)) {
    if (esp_now_add_peer(&tempPeer) != ESP_OK) {
      Serial.println("[Pairing] Failed to add peer"); return;
    }
  } else {
    esp_now_mod_peer(&tempPeer);
  }

  struct_message reply = {.msgType = MSG_PAIRING, .temp = 0, .hum = 0, .battery = 0};
  if (esp_now_send(mac, (uint8_t*)&reply, sizeof(reply)) != ESP_OK) {
    Serial.println("[Pairing] Failed to send confirmation"); return;
  }
  Serial.println("✓ Pairing confirmation sent!");

  // Upgrade peer to encrypted link
  esp_now_peer_info_t encPeer = {};
  memcpy(encPeer.peer_addr, mac, 6);
  encPeer.channel = 0;
  encPeer.encrypt = true;
  memcpy(encPeer.lmk, LMK_KEY, 16);
  esp_now_mod_peer(&encPeer);

  int index = findSensor(mac);
  if (index == -1) addSensor(mac);

  // Grace window: suppress cloud-sync removals while the cloud persists this sensor.
  pairingGraceUntil = millis() + PAIRING_GRACE_MS;

  // Tell the cloud the pairing is complete so it can persist the sensor to its database.
  publishSyncRequest();

  digitalWrite(LED_PIN, HIGH); delay(200); digitalWrite(LED_PIN, LOW);
}

// Publish one sensor reading to the cloud.
// Called from updateSensor() after the local store is updated.
void publishSensorData(int idx) {
  const SensorData& s = sensors[idx];

  // ISO-8601 timestamp (UTC) — captured now so buffered readings keep their
  // original read time rather than the later flush time.
  // Use time()+gmtime_r() to get true UTC; getLocalTime() returns local time
  // (UTC+2) which would be mislabelled by the literal 'Z' suffix.
  char ts[21] = "";
  time_t now = time(nullptr);
  if (now > 1000000000UL) {   // sanity-check: after 2001 means NTP has synced
    struct tm utcTm;
    gmtime_r(&now, &utcTm);
    strftime(ts, sizeof(ts), "%Y-%m-%dT%H:%M:%SZ", &utcTm);
  }

  // A sensor firmware transfer streams over HTTP from loop(), and this runs in
  // the ESP-NOW callback -- so publishing here would put a second network
  // operation in a second task alongside it. That is what hung a transfer at
  // 59% when another sensor happened to report mid-stream.
  //
  // The reading is not lost: the offline buffer already exists for exactly this
  // shape of problem, and is flushed when the transfer finishes.
  if (!cloudConfigured || !mqttClient.connected() || sOtaRunning) {
    // MQTT offline or busy — store the reading in the circular buffer.
    BufferedReading& r = offlineBuf[bufHead];
    memcpy(r.mac, s.mac, 6);
    r.temp    = s.temp;
    r.hum     = s.hum;
    r.rssi    = (int8_t)s.rssi;
    r.battery = s.battery;
    memcpy(r.ts, ts, sizeof(r.ts));

    bufHead = (bufHead + 1) % OFFLINE_BUFFER_SIZE;
    if (bufCount < OFFLINE_BUFFER_SIZE) {
      bufCount++;
    } else {
      // Buffer full — overwrite oldest entry; advance the read pointer.
      bufTail = (bufTail + 1) % OFFLINE_BUFFER_SIZE;
    }
    Serial.printf("[Buffer] Queued reading (%d buffered)\n", bufCount);
    offlineBufDirty = true;   // persisted from loop(), not here
    return;
  }

  char sensorMacStr[18];
  snprintf(sensorMacStr, sizeof(sensorMacStr), "%02X:%02X:%02X:%02X:%02X:%02X",
           s.mac[0], s.mac[1], s.mac[2], s.mac[3], s.mac[4], s.mac[5]);

  char payload[256];
  snprintf(payload, sizeof(payload),
    "{\"sensor_mac\":\"%s\",\"temp\":%.2f,\"hum\":%.2f,"
    "\"battery\":%d,\"rssi\":%d,\"ts\":\"%s\","
    "\"fw\":\"%u.%u.%u\",\"cfg_ver\":%u}",
    sensorMacStr, s.temp, s.hum, s.battery, s.rssi, ts,
    s.fw_major, s.fw_minor, s.fw_patch, s.cfg_ver);

  mqttClient.publish(topicData, payload);
}

// ─────────────────────────────────────────────────────────────────────────────
// WEB HANDLERS (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

void handleRoot() {
  String html = "<!DOCTYPE html><html><head>";
  html += "<meta charset='UTF-8'>";
  html += "<meta name='viewport' content='width=device-width, initial-scale=1.0'>";
  html += "<title>XIAO ESP32-C6 Sensor Monitor</title>";
  html += "<style>";
  html += "body { font-family: Arial, sans-serif; margin: 20px; background: #f0f0f0; }";
  html += "h1 { color: #333; }";
  html += ".container { max-width: 1200px; margin: 0 auto; }";
  html += ".sensor-card { background: white; padding: 20px; margin: 10px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }";
  html += ".sensor-card.inactive { opacity: 0.5; background: #f8f8f8; }";
  html += ".sensor-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }";
  html += ".sensor-name { font-size: 1.3em; font-weight: bold; color: #2c3e50; }";
  html += ".sensor-mac { font-size: 0.9em; color: #7f8c8d; font-family: monospace; }";
  html += ".sensor-data { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; }";
  html += ".data-item { text-align: center; }";
  html += ".data-label { font-size: 0.9em; color: #7f8c8d; margin-bottom: 5px; }";
  html += ".data-value { font-size: 2em; font-weight: bold; color: #2c3e50; }";
  html += ".data-unit { font-size: 0.7em; color: #95a5a6; }";
  html += ".temp { color: #e74c3c; } .hum { color: #3498db; }";
  html += ".rssi { color: #27ae60; } .battery { color: #f39c12; }";
  html += ".battery-bar-bg { background:#ecf0f1; border-radius:4px; height:8px; margin-top:6px; }";
  html += ".battery-bar-fill { height:8px; border-radius:4px; background:#2ecc71; }";
  html += ".battery-bar-fill.mid { background:#f39c12; }";
  html += ".battery-bar-fill.low { background:#e74c3c; }";
  html += ".status { display: inline-block; padding: 5px 15px; border-radius: 20px; font-size: 0.85em; font-weight: bold; }";
  html += ".status.active { background: #2ecc71; color: white; }";
  html += ".status.inactive { background: #e74c3c; color: white; }";
  html += ".last-update { font-size: 0.85em; color: #95a5a6; margin-top: 10px; }";
  html += ".refresh-info { text-align: center; color: #7f8c8d; margin-top: 20px; padding: 10px; }";
  html += ".hardware-info { background: #3498db; color: white; padding: 10px; border-radius: 5px; margin-bottom: 20px; text-align: center; }";
  html += "@media (max-width: 600px) { .sensor-data { grid-template-columns: 1fr; } }";
  html += ".rename-btn { background:none; border:none; cursor:pointer; font-size:1em; color:#7f8c8d; margin-left:6px; padding:2px 5px; vertical-align:middle; }";
  html += ".rename-btn:hover { color:#2c3e50; }";
  html += ".rename-input { font-size:1.1em; padding:2px 6px; border:1px solid #bdc3c7; border-radius:4px; width:160px; }";
  html += ".rename-save { background:#2ecc71; color:white; border:none; border-radius:4px; padding:3px 8px; cursor:pointer; margin-left:4px; }";
  html += ".rename-cancel { background:#e74c3c; color:white; border:none; border-radius:4px; padding:3px 8px; cursor:pointer; margin-left:2px; }";
  html += ".delete-btn { background:none; border:1px solid #e74c3c; color:#e74c3c; border-radius:4px; cursor:pointer; font-size:0.85em; padding:3px 9px; margin-left:8px; }";
  html += ".delete-btn:hover { background:#e74c3c; color:white; }";
  html += "</style>";
  html += "<script>";
  html += "var _rt=setTimeout(function(){location.reload();},10000);";
  html += "function startRename(id){";
  html +=   "clearTimeout(_rt);";
  html +=   "document.getElementById('rinput-'+id).value=document.getElementById('sname-'+id).textContent;";
  html +=   "document.getElementById('sname-'+id).style.display='none';";
  html +=   "document.getElementById('rbtn-'+id).style.display='none';";
  html +=   "document.getElementById('rform-'+id).style.display='inline';";
  html += "}";
  html += "function cancelRename(id){";
  html +=   "document.getElementById('sname-'+id).style.display='';";
  html +=   "document.getElementById('rbtn-'+id).style.display='';";
  html +=   "document.getElementById('rform-'+id).style.display='none';";
  html +=   "_rt=setTimeout(function(){location.reload();},10000);";
  html += "}";
  html += "function saveRename(id){";
  html +=   "var n=document.getElementById('rinput-'+id).value.trim();";
  html +=   "if(!n)return;";
  html +=   "fetch('/api/sensors',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,name:n})})";
  html +=   ".then(function(r){return r.json();})";
  html +=   ".then(function(d){if(d.ok){document.getElementById('sname-'+id).textContent=n;cancelRename(id);}})";
  html +=   ".catch(function(){alert('Rename failed');});";
  html += "}";
  html += "function removeSensor(id){";
  html +=   "if(!confirm('Remove this sensor? It will be unpaired from the hub and deleted from the cloud.'))return;";
  html +=   "clearTimeout(_rt);";
  html +=   "fetch('/api/sensors',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})";
  html +=   ".then(function(r){return r.json();})";
  html +=   ".then(function(d){if(d.ok){location.reload();}else{alert('Remove failed: '+(d.error||'unknown'));}})";
  html +=   ".catch(function(){alert('Remove failed');});";
  html += "}";
  html += "</script>";
  html += "</head><body>";
  html += "<div class='container'>";
  html += "<h1>🌡️ XIAO ESP32-C6 Temperature Monitor</h1>";
  html += "<div class='hardware-info'>Using SHT40 High-Precision Sensors (±0.2°C accuracy)</div>";

  if (sensorCount == 0) {
    html += "<div class='sensor-card'><p>No sensors paired yet. Waiting for sensor data...</p></div>";
  } else {
    checkInactiveSensors();
    for (int i = 0; i < sensorCount; i++) {
      html += "<div class='sensor-card";
      if (!sensors[i].active) html += " inactive";
      html += "'>";
      html += "<div class='sensor-header'><div>";
      html += "<div class='sensor-name' id='sname-" + String(i) + "'>" + String(sensors[i].name) + "</div>";
      html += "<button class='rename-btn' id='rbtn-" + String(i) + "' onclick='startRename(" + String(i) + ")'>&#9998;</button>";
      html += "<span id='rform-" + String(i) + "' style='display:none'>";
      html += "<input class='rename-input' id='rinput-" + String(i) + "' type='text' maxlength='19'>";
      html += "<button class='rename-save' onclick='saveRename(" + String(i) + ")'>&#10003;</button>";
      html += "<button class='rename-cancel' onclick='cancelRename(" + String(i) + ")'>&#10007;</button>";
      html += "</span>";
      html += "<div class='sensor-mac'>MAC: ";
      for (int j = 0; j < 6; j++) {
        char buf[3]; sprintf(buf, "%02X", sensors[i].mac[j]);
        html += String(buf); if (j < 5) html += ":";
      }
      html += "</div></div>";
      html += "<div style='display:flex;align-items:center;gap:8px'>";
      html += "<span class='status ";
      html += sensors[i].active ? "active'>ACTIVE" : "inactive'>OFFLINE";
      html += "</span>";
      html += "<button class='delete-btn' onclick='removeSensor(" + String(i) + ")'>Remove</button>";
      html += "</div></div>";

      html += "<div class='sensor-data'>";

      html += "<div class='data-item'><div class='data-label'>Temperature</div>";
      html += "<div class='data-value temp'>";
      if (sensors[i].temp == -999) html += "ERR";
      else { html += String(sensors[i].temp, 2); html += "<span class='data-unit'>°C</span>"; }
      html += "</div></div>";

      html += "<div class='data-item'><div class='data-label'>Humidity</div>";
      html += "<div class='data-value hum'>";
      if (sensors[i].hum == -999) html += "ERR";
      else { html += String(sensors[i].hum, 2); html += "<span class='data-unit'>%</span>"; }
      html += "</div></div>";

      html += "<div class='data-item'><div class='data-label'>Signal Strength</div>";
      html += "<div class='data-value rssi'>" + String(sensors[i].rssi);
      html += "<span class='data-unit'>dBm</span></div></div>";

      html += "<div class='data-item'><div class='data-label'>Battery</div>";
      html += "<div class='data-value battery'>";
      if (sensors[i].battery == 255) html += "ERR";
      else { html += String(sensors[i].battery); html += "<span class='data-unit'>%</span>"; }
      html += "</div>";
      {
        String fillClass = "battery-bar-fill";
        if (sensors[i].battery != 255) {
          if      (sensors[i].battery < 20) fillClass += " low";
          else if (sensors[i].battery < 50) fillClass += " mid";
        }
        html += "<div class='battery-bar-bg'><div class='" + fillClass + "' style='width:";
        html += (sensors[i].battery == 255 ? "0" : String(sensors[i].battery));
        html += "%'></div></div>";
      }
      html += "</div></div>";

      unsigned long secAgo = (millis() - sensors[i].lastUpdate) / 1000;
      html += "<div class='last-update'>Last update: ";
      if      (secAgo < 60)   html += String(secAgo) + " seconds ago";
      else if (secAgo < 3600) html += String(secAgo / 60) + " minutes ago";
      else                    html += String(secAgo / 3600) + " hours ago";
      html += "</div></div>";
    }
  }

  html += "<div class='refresh-info'>📡 Page auto-refreshes every 10 seconds</div>";
  html += "</div></body></html>";
  server.send(200, "text/html", html);
}

// Strip everything except safe printable characters from a sensor name.
void sanitizeName(char* name, size_t maxLen) {
  size_t j = 0;
  for (size_t i = 0; name[i] && j < maxLen - 1; i++) {
    char c = name[i];
    if (isalnum((unsigned char)c) || c == ' ' || c == '-' || c == '_' ||
        c == '(' || c == ')' || c == '.' || c == '\'') {
      name[j++] = c;
    }
  }
  name[j] = '\0';
}

// PUT /api/sensors  — body: {"id":N,"name":"..."}
void handleRenameSensor() {
  String body = server.arg("plain");

  // Parse "id"
  int idPos = body.indexOf("\"id\"");
  if (idPos < 0) { server.send(400, "application/json", "{\"error\":\"missing id\"}"); return; }
  int colonId = body.indexOf(':', idPos);
  int id = body.substring(colonId + 1).toInt();
  if (id < 0 || id >= sensorCount) {
    server.send(404, "application/json", "{\"error\":\"sensor not found\"}");
    return;
  }

  // Parse "name"
  int namePos = body.indexOf("\"name\"");
  if (namePos < 0) { server.send(400, "application/json", "{\"error\":\"missing name\"}"); return; }
  int colonName = body.indexOf(':', namePos);
  int q1 = body.indexOf('"', colonName + 1);
  if (q1 < 0) { server.send(400, "application/json", "{\"error\":\"invalid name\"}"); return; }
  int q2 = body.indexOf('"', q1 + 1);
  if (q2 < 0) { server.send(400, "application/json", "{\"error\":\"invalid name\"}"); return; }
  String newName = body.substring(q1 + 1, q2);

  char sanitized[20];
  strncpy(sanitized, newName.c_str(), 19);
  sanitized[19] = '\0';
  sanitizeName(sanitized, sizeof(sanitized));
  if (strlen(sanitized) == 0) {
    server.send(400, "application/json", "{\"error\":\"name empty\"}");
    return;
  }

  strncpy(sensors[id].name, sanitized, sizeof(sensors[id].name));

  // Persist: key = n + MAC bytes 2–5 as hex (fits NVS 15-char key limit)
  char nameKey[10];
  snprintf(nameKey, sizeof(nameKey), "n%02X%02X%02X%02X",
           sensors[id].mac[2], sensors[id].mac[3],
           sensors[id].mac[4], sensors[id].mac[5]);
  prefs.begin("sensors", false);
  prefs.putString(nameKey, sanitized);
  prefs.end();

  // Notify cloud so its database stays in sync with the local rename
  if (cloudConfigured && mqttClient.connected()) {
    char sensorMacStr[18];
    snprintf(sensorMacStr, sizeof(sensorMacStr), "%02X:%02X:%02X:%02X:%02X:%02X",
             sensors[id].mac[0], sensors[id].mac[1], sensors[id].mac[2],
             sensors[id].mac[3], sensors[id].mac[4], sensors[id].mac[5]);
    char renamePayload[120];
    snprintf(renamePayload, sizeof(renamePayload),
             "{\"sensor_mac\":\"%s\",\"name\":\"%s\"}", sensorMacStr, sanitized);
    mqttClient.publish(topicSensorRenamed, renamePayload);
  }

  server.send(200, "application/json", "{\"ok\":true}");
}

// DELETE /api/sensors  — body: {"id":N}
void handleRemoveSensor() {
  String body = server.arg("plain");

  int idPos = body.indexOf("\"id\"");
  if (idPos < 0) { server.send(400, "application/json", "{\"error\":\"missing id\"}"); return; }
  int colonId = body.indexOf(':', idPos);
  int id = body.substring(colonId + 1).toInt();
  if (id < 0 || id >= sensorCount) {
    server.send(404, "application/json", "{\"error\":\"sensor not found\"}");
    return;
  }

  // Capture MAC before the array shifts
  uint8_t mac[6];
  memcpy(mac, sensors[id].mac, 6);

  removeSensorByMac(mac);

  // Notify cloud so it can remove the sensor from its database
  if (cloudConfigured && mqttClient.connected()) {
    char sensorMacStr[18];
    snprintf(sensorMacStr, sizeof(sensorMacStr), "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    char deletePayload[80];
    snprintf(deletePayload, sizeof(deletePayload),
             "{\"sensor_mac\":\"%s\"}", sensorMacStr);
    mqttClient.publish(topicSensorDeleted, deletePayload);
  }

  server.send(200, "application/json", "{\"ok\":true}");
}

void handleJSON() {
  String json = "{\"sensors\":[";
  checkInactiveSensors();
  for (int i = 0; i < sensorCount; i++) {
    if (i > 0) json += ",";
    json += "{";
    json += "\"name\":\"" + String(sensors[i].name) + "\",";
    json += "\"mac\":\"";
    for (int j = 0; j < 6; j++) {
      char buf[3]; sprintf(buf, "%02X", sensors[i].mac[j]);
      json += String(buf); if (j < 5) json += ":";
    }
    json += "\",";
    json += "\"temp\":"    + String(sensors[i].temp, 2) + ",";
    json += "\"hum\":"     + String(sensors[i].hum, 2)  + ",";
    json += "\"rssi\":"    + String(sensors[i].rssi)    + ",";
    json += "\"battery\":" + String(sensors[i].battery) + ",";
    json += "\"active\":"  + String(sensors[i].active ? "true" : "false") + ",";
    json += "\"lastUpdate\":" + String((millis() - sensors[i].lastUpdate) / 1000);
    json += "}";
  }
  json += "],\"count\":" + String(sensorCount) + "}";
  server.send(200, "application/json", json);
}

// Escape characters that would break out of <pre> HTML context.
static String htmlEscape(const char* src, size_t len) {
  String out; out.reserve(len + 16);
  for (size_t i = 0; i < len; i++) {
    char c = src[i];
    switch (c) {
      case '<':  out += "&lt;";   break;
      case '>':  out += "&gt;";   break;
      case '&':  out += "&amp;";  break;
      default:   out += c;        break;
    }
  }
  return out;
}

// /logs — minimal page showing the latest wake-cycle log per sensor.
// Auto-refreshes every 30 s. One <pre> block per sensor, newest at top of section.
void handleLogs() {
  String html;
  html.reserve(4096);
  html += F("<!DOCTYPE html><html><head><meta charset='UTF-8'>"
           "<meta name='viewport' content='width=device-width, initial-scale=1.0'>"
           "<meta http-equiv='refresh' content='30'>"
           "<title>Sensor Logs</title><style>"
           "body{font-family:Arial,sans-serif;margin:20px;background:#f0f0f0;color:#2c3e50;}"
           "h1{color:#333;}h2{margin-top:30px;color:#2c3e50;font-size:1.1em;}"
           ".meta{font-size:0.85em;color:#7f8c8d;font-family:monospace;margin-bottom:6px;}"
           "pre{background:#1e1e1e;color:#d4d4d4;padding:14px;border-radius:6px;"
           "white-space:pre-wrap;word-break:break-word;font-size:0.85em;line-height:1.4;"
           "max-height:400px;overflow:auto;}"
           ".empty{color:#7f8c8d;font-style:italic;padding:14px;background:#fff;border-radius:6px;}"
           ".back{display:inline-block;margin-bottom:12px;color:#3498db;text-decoration:none;}"
           "</style></head><body>"
           "<a class='back' href='/'>← Dashboard</a>"
           "<h1>Sensor Logs</h1>"
           "<p style='color:#7f8c8d;font-size:0.9em;'>Latest wake-cycle log per sensor. Auto-refreshes every 30 s.</p>");

  if (sensorCount == 0) {
    html += F("<p class='empty'>No paired sensors.</p>");
  } else {
    for (int i = 0; i < sensorCount; i++) {
      const SensorData& s = sensors[i];
      char macStr[18];
      snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
               s.mac[0], s.mac[1], s.mac[2], s.mac[3], s.mac[4], s.mac[5]);
      html += "<h2>" + String(s.name) + "</h2>";
      html += "<div class='meta'>" + String(macStr);
      if (s.logUpdated > 0) {
        unsigned long ageSec = (millis() - s.logUpdated) / 1000;
        html += " &nbsp;·&nbsp; updated " + String(ageSec) + " s ago";
        if (s.logChunksRcvd != s.logExpectedTotal) {
          html += " &nbsp;·&nbsp; <span style='color:#e67e22;'>partial ("
               + String(s.logChunksRcvd) + "/" + String(s.logExpectedTotal) + " chunks)</span>";
        }
      }
      html += "</div>";
      if (s.logLen == 0) {
        html += F("<div class='empty'>No log received yet.</div>");
      } else {
        html += "<pre>" + htmlEscape(s.log, s.logLen) + "</pre>";
      }
    }
  }

  html += F("</body></html>");
  server.send(200, "text/html", html);
}

// ─────────────────────────────────────────────────────────────────────────────
// REMOTE LOG ASSEMBLY
// ─────────────────────────────────────────────────────────────────────────────

// Reassemble chunked MSG_LOG packets from a sensor into its SensorData.log buffer.
// seq=0 starts a fresh log; subsequent in-order chunks append. A skipped chunk
// (seq jumps) is left as a gap — we still keep what arrived. Unknown sensors
// (not paired) are ignored.
void handleLogChunk(const uint8_t* mac, const log_message* msg) {
  int idx = findSensor(mac);
  if (idx < 0) return;  // log from a sensor we haven't paired with — drop
  SensorData& s = sensors[idx];

  if (msg->seq == 0) {
    s.logLen           = 0;
    s.logExpectedTotal = msg->total;
    s.logChunksRcvd    = 0;
    s.log[0]           = '\0';
  }

  int chunkLen = msg->len;
  if (chunkLen > LOG_CHUNK_DATA) chunkLen = LOG_CHUNK_DATA;
  int room = (int)sizeof(s.log) - 1 - (int)s.logLen;
  if (chunkLen > room) chunkLen = room;
  if (chunkLen > 0) {
    memcpy(s.log + s.logLen, msg->data, chunkLen);
    s.logLen += chunkLen;
    s.log[s.logLen] = '\0';
  }
  s.logChunksRcvd++;

  if (msg->seq + 1 == msg->total) {
    s.logUpdated = millis();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ESP-NOW CALLBACK
// ─────────────────────────────────────────────────────────────────────────────

void OnDataRecv(const esp_now_recv_info_t* esp_now_info,
                const uint8_t* incomingDataBytes, int len) {
  if (len < 1) return;
  uint8_t msgType = incomingDataBytes[0];

  // Sensor OTA replies. Short frames handled before the struct_message path,
  // which would otherwise reject them on length.
  if (msgType == MSG_OTA_REQ && len >= (int)sizeof(ota_req_message)) {
    const ota_req_message* r = (const ota_req_message*)incomingDataBytes;
    sOtaReqAccept = r->accept;
    sOtaReqReason = r->reason;
    sOtaReqReady  = true;
    return;
  }
  if (msgType == MSG_OTA_ACK && len >= (int)sizeof(ota_ack_message)) {
    const ota_ack_message* a2 = (const ota_ack_message*)incomingDataBytes;
    sOtaAckStatus = a2->status;
    sOtaAckNext   = a2->nextSeq;
    sOtaAckReady  = true;
    return;
  }
  if (msgType == MSG_OTA_DONE && len >= (int)sizeof(ota_done_message)) {
    const ota_done_message* d = (const ota_done_message*)incomingDataBytes;
    sOtaDoneResult = d->result;
    sOtaDoneReady  = true;
    return;
  }

  // MSG_LOG packets are larger than struct_message — dispatch before memcpy.
  if (msgType == MSG_LOG) {
    if (len < (int)sizeof(log_message)) return;
    handleLogChunk(esp_now_info->src_addr, (const log_message*)incomingDataBytes);
    return;
  }

  // Accept both the legacy (pre-1.0) and current message lengths. Anything the
  // sender did not include stays zero, so an un-updated sensor reads as
  // fw 0.0.0 / cfg_ver 0 rather than being dropped.
  if (len < (int)sizeof(legacy_message)) return;
  int copyLen = len < (int)sizeof(incomingData) ? len : (int)sizeof(incomingData);
  memset(&incomingData, 0, sizeof(incomingData));
  memcpy(&incomingData, incomingDataBytes, copyLen);
  incomingRSSI = esp_now_info->rx_ctrl->rssi;

  if (incomingData.msgType == MSG_PAIRING) {
    Serial.printf("Pairing Request from: %02X:%02X:%02X:%02X:%02X:%02X\n",
                  esp_now_info->src_addr[0], esp_now_info->src_addr[1],
                  esp_now_info->src_addr[2], esp_now_info->src_addr[3],
                  esp_now_info->src_addr[4], esp_now_info->src_addr[5]);

    if (!pairingModeActive) {
      Serial.println("[Pairing] Pairing mode OFF — ignoring request");
      return;
    }

    if (cloudConfigured && mqttClient.connected() && !pendingPairing.active) {
      // Cloud connected: publish request and wait for dashboard approval in loop()
      memcpy(pendingPairing.mac, esp_now_info->src_addr, 6);
      pendingPairing.startedAt = millis();
      pendingPairing.active    = true;
      pendingPairing.approved  = false;
      pendingPairing.resolved  = false;

      char sensorMacStr[18];
      snprintf(sensorMacStr, sizeof(sensorMacStr), "%02X:%02X:%02X:%02X:%02X:%02X",
               esp_now_info->src_addr[0], esp_now_info->src_addr[1],
               esp_now_info->src_addr[2], esp_now_info->src_addr[3],
               esp_now_info->src_addr[4], esp_now_info->src_addr[5]);
      char req[80];
      snprintf(req, sizeof(req), "{\"sensor_mac\":\"%s\"}", sensorMacStr);
      mqttClient.publish(topicPairReq, req);
      Serial.printf("[MQTT] Pairing request sent to cloud for %s\n", sensorMacStr);

    } else if (pendingPairing.active) {
      if (memcmp(esp_now_info->src_addr, pendingPairing.mac, 6) == 0) {
        if (pendingPairing.resolved && pendingPairing.approved) {
          // Hub already approved but sensor missed the response — respond again
          Serial.println("[Pairing] Re-broadcast from approved sensor — responding immediately");
          completePairing(esp_now_info->src_addr);
          pendingPairing.active = false;
        } else {
          Serial.println("[Pairing] Sensor re-broadcasting — still awaiting dashboard approval");
        }
      } else {
        Serial.println("[Pairing] Already handling another sensor pairing — ignoring");
      }
    } else {
      // Cloud offline but pairing mode active — auto-accept since user explicitly enabled it
      Serial.println("[Pairing] Cloud offline but pairing mode active — auto-accepting");
      completePairing(esp_now_info->src_addr);
    }
  }
  else if (incomingData.msgType == MSG_DATA) {
    Serial.print("DATA from: ");
    for (int i = 0; i < 5; i++) Serial.printf("%02X:", esp_now_info->src_addr[i]);
    Serial.printf("%02X", esp_now_info->src_addr[5]);

    // -999 is a sentinel, not a bad reading: on hum it means "no humidity
    // sensor" (NTC-only nodes), and on temp it means the probe read failed --
    // open, shorted, or out of range.
    //
    // A failed probe used to be dropped here, so the cloud saw nothing at all
    // and the node just looked quiet. That is the wrong way round: a probe
    // that has stopped working is exactly what someone needs to be told about,
    // so it is forwarded and flagged rather than discarded.
    bool humInvalid  = (incomingData.hum != -999) &&
                       (incomingData.hum < 0 || incomingData.hum > 100);
    bool probeFailed = (incomingData.temp == -999);
    bool tempInvalid = !probeFailed &&
                       (incomingData.temp < -50 || incomingData.temp > 100);
    if (tempInvalid || humInvalid) {
      Serial.println(" | ERROR: Invalid sensor data!"); return;
    }
    if (probeFailed) {
      Serial.print(" | PROBE ERROR — forwarding to cloud");
    }

    Serial.printf(" | Temp: %.2f°C | Hum: %.2f%% | RSSI: %d dBm | Bat: %d%% | ",
                  incomingData.temp, incomingData.hum,
                  incomingRSSI, incomingData.battery);
    printCurrentTime();

    int index = findSensor(esp_now_info->src_addr);
    if (index == -1) {
      Serial.println(" | Unknown sensor — ignoring. Re-pair to register.");
      return;
    }

    // Everything below talks to the radio or the cloud, and a transfer in
    // flight owns both. Skipping it costs one cycle: config, live and firmware
    // offers are all retried on the sensor's next contact.
    if (sOtaRunning) {
      updateSensor(index, incomingData.temp, incomingData.hum,
                   incomingRSSI, incomingData.battery);
      return;
    }

    // Record the reported versions before updateSensor(), so they are kept even
    // when the reading itself is discarded as a duplicate retry.
    sensors[index].fw_major = incomingData.fw_major;
    sensors[index].fw_minor = incomingData.fw_minor;
    sensors[index].fw_patch = incomingData.fw_patch;
    sensors[index].cfg_ver  = incomingData.cfg_ver;

    // The sensor is awake and listening only right now, so any pending config
    // has to go out on this frame.
    pushConfigIfPending(index, esp_now_info->src_addr);

    // A live request rides the same window as a config push, so it costs the
    // node no extra listening. Delivered on any wake, not just a button press.
    if (liveePending && memcmp(esp_now_info->src_addr, livePendingMac, 6) == 0) {
      live_message lm = {};
      lm.msgType    = MSG_LIVE;
      lm.duration_s = liveDuration;
      lm.interval_s = liveInterval;
      if (esp_now_send(esp_now_info->src_addr, (uint8_t*)&lm, sizeof(lm)) == ESP_OK) {
        liveePending = false;
        Serial.println(liveDuration == 0 ? "[LIVE] Stop sent" : "[LIVE] Sent");
        publishLiveState(esp_now_info->src_addr, liveDuration, liveInterval);
      }
    }

    // Firmware is offered on the same contact. The node only listens after a
    // button press, so on an ordinary timer wake this simply lapses.
    //
    // Sent from here rather than deferred to loop(): the node stops listening
    // 400 ms after it transmits, and updateSensor() below publishes over TLS,
    // which can block for longer than that on its own. Only the transfer, which
    // takes seconds, waits for loop().
    int stagedSlot = sOtaRunning ? -1 : sOtaSlotFor(esp_now_info->src_addr);
    if (stagedSlot >= 0) {
      StagedImage &st = sOtaStaged[stagedSlot];
      sOtaActive = stagedSlot;
      memcpy(sOtaMac, st.mac, 6);
      strncpy(sOtaVersion, st.version, sizeof(sOtaVersion) - 1);
      sOtaVersion[sizeof(sOtaVersion) - 1] = 0;

      sOtaReqReady = false;
      esp_now_send(esp_now_info->src_addr, (const uint8_t *)&st.offer, sizeof(st.offer));
      otaOfferSentAt = millis();
      Serial.printf("[SOTA] Offered %s (%u bytes, chunk %u)\n",
                    st.version, (unsigned)st.offer.imageSize, st.offer.chunkSize);

      // Claims the radio and the network for the handshake, which also stops
      // this frame's own reading being published -- it is buffered instead and
      // flushed when the transfer finishes.
      sOtaRunning    = true;
      otaOfferWanted = true;
      memcpy(otaOfferMac, esp_now_info->src_addr, 6);
    }

    updateSensor(index, incomingData.temp, incomingData.hum,
                 incomingRSSI, incomingData.battery);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WIFI EVENT HANDLER
// ─────────────────────────────────────────────────────────────────────────────

// Runs in the WiFi task — keep it short; no heap alloc.
void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      // Record the channel the router assigned so we can restore it on drop.
      lastWifiChannel = WiFi.channel();
      Serial.printf("[WiFi] Connected — channel %d\n", lastWifiChannel);
      break;

    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      // Lock to ch 1 — the sensor falls back to ch 1 too when it cannot see
      // the hub's AP, so both sides agree on a stable offline channel.
      // Auto-reconnect is disabled; maintainWiFi() retries every 30 s so the
      // radio is only off ch 1 for the brief scan burst during that attempt.
      Serial.println("[WiFi] Disconnected — locking to ch 1 for ESP-NOW");
      esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);
      break;

    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RE-PROVISION BUTTON
// ─────────────────────────────────────────────────────────────────────────────

// Poll the BOOT button; if held ~3 s, erase WiFi credentials and reboot into
// BLE provisioning. No-op when the button isn't held. Safe to call from any
// blocking wait loop (boot-time connect, maintainWiFi reconnect, main loop) so
// the user can always escape a dead or unreachable saved network — otherwise
// those blocking waits starve the button and it appears unresponsive.
void checkReprovisionButton() {
  if (!resetButtonHeld()) return;
  delay(50);  // debounce
  unsigned long startPress = millis();
  Serial.println("Button pressed... (hold 3 s to reset WiFi and re-provision)");
  while (resetButtonHeld()) {
    if (millis() - startPress > 3000) {
      Serial.println("\n=== ERASING WiFi CREDENTIALS ===");
      Preferences wPrefs;
      wPrefs.begin("wifi", false);
      wPrefs.clear();
      wPrefs.end();
      Serial.println("Credentials erased. Restarting into BLE provisioning mode...");
      delay(500);
      ESP.restart();
    }
    delay(10);
  }
  Serial.println("Button released.");
}

// ─────────────────────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────────────────────

void setup() {
  pinMode(3, OUTPUT);
  digitalWrite(3, LOW);
  delay(100);
  pinMode(14, OUTPUT);
  digitalWrite(14, HIGH); // external antenna

  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== XIAO ESP32-C6 Hub ===");
  Serial.println("Firmware " FW_VERSION);
  Serial.println(FW_VERSION_TAG);
  loadOfflineBuffer();   // readings queued before the last reboot

  // Must run before anything can reboot us: if this image is pending
  // verification and we reset without confirming, the bootloader rolls back.
  checkOtaPendingVerify();

  pinMode(TRIGGER_PIN,     INPUT_PULLUP);
  pinMode(TRIGGER_PIN_EXT, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // ── Load stored WiFi credentials ────────────────────────────────────────
  Preferences wPrefs;
  wPrefs.begin("wifi", true);
  String storedSsid = wPrefs.getString("ssid", "");
  String storedPass = wPrefs.getString("pass", "");
  bool   provisioned = wPrefs.getBool("provisioned", false);
  wPrefs.end();

  // Enter BLE provisioning unless we have creds AND a prior attempt fully
  // succeeded. Gating on `provisioned` (not just SSID presence) means a failed
  // attempt — e.g. WiFi saved but cloud auth wrong — re-enters provisioning on
  // the next boot instead of booting to normal mode with no BLE (which left the
  // user unable to re-provision without a factory reset).
  if (storedSsid.isEmpty() || !provisioned) {
    startBleProvisioning();
    return;  // unreachable; startBleProvisioning() calls ESP.restart()
  }

  // ── WiFi connect with stored credentials ────────────────────────────────
  // Use AP_STA from the start — switching modes while connected drops the STA.
  // Set tx-power and protocol before connecting so they never disrupt the STA.
  // Keep credentials in RAM for manual reconnects in maintainWiFi().
  strncpy(wifiSsid, storedSsid.c_str(), sizeof(wifiSsid) - 1);
  strncpy(wifiPass, storedPass.c_str(), sizeof(wifiPass) - 1);

  Serial.printf("Connecting to WiFi: %s\n", wifiSsid);
  WiFi.mode(WIFI_AP_STA);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G |
                                      WIFI_PROTOCOL_11N | WIFI_PROTOCOL_LR);
  // Disable auto-reconnect: its continuous channel scanning disrupts ESP-NOW.
  // maintainWiFi() in loop() issues one targeted reconnect attempt every 30 s.
  WiFi.setAutoReconnect(false);
  WiFi.onEvent(onWiFiEvent);
  WiFi.begin(wifiSsid, wifiPass);

  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED) {
    // Escape hatch for an unreachable saved network. Without this, a bad/gone
    // WiFi makes the 30 s timeout → ESP.restart() cycle repeat forever and
    // loop() (where the BOOT-button reset lives) is never reached, so the
    // button appears dead. A 3 s hold here erases creds and re-provisions.
    checkReprovisionButton();
    if (millis() - wifiStart > WIFI_CONNECT_TIMEOUT_MS) {
      // Network outage / router down — keep credentials and restart so the
      // boot logic tries again. Wiping NVS here would force the user to
      // re-provision after any transient disconnect (router reboot, ISP outage).
      // The BOOT button is the only sanctioned way to clear WiFi creds.
      Serial.println("WiFi connection timed out — restarting (credentials preserved).");
      ESP.restart();
    }
    delay(200);
  }
  Serial.printf("✓ WiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());
  esp_wifi_set_ps(WIFI_PS_NONE);  // disable power save — radio must always be listening

  // ── MQTT cloud uplink ────────────────────────────────────────────────────
  loadCloudConfig();
  if (cloudConfigured) {
    buildTopics();
    connectCloud();  // non-fatal if it fails; maintainCloud() retries in loop()
  }

  // Hide the AP — it is required internally for ESP-NOW but should not be
  // visible to end users.  Must be called after STA connects so the channel
  // is known; AP and STA must share the same channel on ESP32.
  WiFi.softAP("TempHub-AP", "", WiFi.channel(), /*hidden=*/1);

  // ── mDNS — device is reachable at http://temp-master.local/ ─────────────
  if (MDNS.begin("temp-hub")) {
    Serial.println("✓ mDNS started: http://temp-hub.local/");
    MDNS.addService("http", "tcp", 80);
  } else {
    Serial.println("mDNS start failed (non-fatal)");
  }

  // ── NTP ─────────────────────────────────────────────────────────────────
  Serial.print("Syncing time");
  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
  struct tm timeinfo;
  int attempts = 0;
  while (!getLocalTime(&timeinfo) && attempts < 20) {
    Serial.print("."); delay(500); attempts++;
  }
  if (attempts < 20) {
    Serial.println("\n✓ Time synced!"); printCurrentTime();
    timeConfigured = true; lastNtpSync = millis();
  } else {
    Serial.println("\n✗ Time sync failed, continuing anyway...");
  }

  // ── Web server ───────────────────────────────────────────────────────────
  // Start before ESP-NOW so the dashboard is available even if ESP-NOW fails.
  server.on("/", handleRoot);
  server.on("/logs", handleLogs);
  server.on("/api/sensors", HTTP_GET,    handleJSON);
  server.on("/api/sensors", HTTP_PUT,    handleRenameSensor);
  server.on("/api/sensors", HTTP_DELETE, handleRemoveSensor);
  server.begin();
  Serial.println("✓ Web server started");

  // ── ESP-NOW ─────────────────────────────────────────────────────────────
  Serial.printf("WiFi channel: %d\n", WiFi.channel());

  if (esp_now_init() != ESP_OK) {
    Serial.println("✗ ESP-NOW init failed! Sensor receiving disabled.");
    return;
  }
  esp_now_set_pmk(PMK_KEY);
  Serial.println("✓ ESP-NOW initialized (encrypted)");

  loadPairedSensors();
  esp_now_register_recv_cb(OnDataRecv);

  // Now that the sensor list is loaded from NVS, tell the cloud what we have.
  // The cloud responds with its authoritative list (retained); applySyncFromCloud
  // in loop() will add/remove sensors to match the cloud truth.
  publishSyncRequest();

  Serial.println("\n=== Hub Ready ===");
  Serial.println("Waiting for sensor data...\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// WIFI RECONNECT
// ─────────────────────────────────────────────────────────────────────────────

// Called every loop() iteration. Attempts one WiFi reconnect every 30 s.
// The function blocks for up to WIFI_TRY_MS (4 s) then explicitly stops
// the IDF connection attempt. Without this, the IDF WiFi driver keeps
// retrying internally and scanning channels for ~10 s, which prevents
// ESP-NOW ACKs from being sent even after the Arduino disconnect event
// fires. By calling WiFi.disconnect() on timeout we guarantee the radio
// is back on ch 1 within WIFI_TRY_MS — safely inside the sensor's 5 s
// retry-wait window.
void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiReconnect < WIFI_RECONNECT_MS) return;
  lastWifiReconnect = millis();
  Serial.println("[WiFi] Reconnecting...");
  WiFi.begin(wifiSsid, wifiPass);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_TRY_MS) {
    // Keep the re-provision button responsive during the 4 s reconnect wait —
    // this wait is longer than the 3 s hold, so without polling here a press
    // that overlaps a reconnect attempt would be swallowed.
    checkReprovisionButton();
    delay(50);
  }

  if (WiFi.status() != WL_CONNECTED) {
    // Stop IDF internal retries so they don't keep the radio off ch 1.
    WiFi.disconnect(false);
    delay(100);
    esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);
    Serial.println("[WiFi] Reconnect failed — restored ch 1");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOOP
// ─────────────────────────────────────────────────────────────────────────────

void loop() {
  server.handleClient();
  maintainWiFi();
  maintainCloud();

  // Run a queued OTA outside the MQTT callback. Blocks for the duration of the
  // download; ESP-NOW readings arriving meanwhile are handled by its callback
  // and buffered as usual.
  if (otaRequested && !otaInProgress) {
    otaRequested = false;
    performOtaUpdate();
  }

  // A sensor transfer blocks for seconds, so it runs here rather than in the
  // ESP-NOW callback that learned the node was awake.
  if (otaOfferWanted) {
    otaOfferWanted = false;
    offerSensorOta(otaOfferMac);
  }

  // Flash write kept out of the ESP-NOW callback: an NVS commit there would
  // stall the WiFi task while sensors are mid-transmission.
  if (offlineBufDirty && !otaInProgress) {
    offlineBufDirty = false;
    saveOfflineBuffer();
  }

  // An unconfirmed image that cannot reach the cloud must reboot itself, or the
  // attempt counter never advances and it would sit here forever instead of
  // reverting. This is the mechanism that actually makes rollback happen.
  if (otaUnconfirmed && !otaInProgress && (long)(millis() - otaVerifyDeadline) >= 0) {
    Serial.println("[OTA] Image failed to reach the cloud in time — restarting");
    Serial.flush();
    delay(100);
    ESP.restart();
  }

  // Cloud-gated pairing: resolve once the dashboard approves/rejects or timeout
  if (pendingPairing.active) {
    if (pendingPairing.resolved) {
      if (pendingPairing.approved) {
        completePairing(pendingPairing.mac);
      } else {
        Serial.println("[Pairing] Rejected by cloud");
      }
      pendingPairing.active = false;
    } else if (millis() - pendingPairing.startedAt > PAIRING_TIMEOUT_MS) {
      Serial.println("[Pairing] Cloud timeout — auto-accepting");
      completePairing(pendingPairing.mac);  // fallback: auto-accept
      pendingPairing.active = false;
    }
  }

  // Auto-expire pairing mode
  if (pairingModeActive && millis() - pairingModeStarted > PAIRING_MODE_TIMEOUT_MS) {
    pairingModeActive = false;
    Serial.println("[Pairing] Pairing mode expired");
    if (mqttClient.connected()) {
      mqttClient.publish(topicPairStatus, "{\"pairing_mode\":false}");
    }
  }

  if (timeConfigured) resyncNTP();

  // BOOT button: hold 3 s to erase WiFi credentials → restart into BLE provisioning
  checkReprovisionButton();

  delay(10);
}
