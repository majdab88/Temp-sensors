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

// --- XIAO ESP32-C6 PIN DEFINITIONS ---
#define TRIGGER_PIN 9   // BOOT button
#define LED_PIN     15  // Built-in LED

// --- MESSAGE TYPES ---
#define MSG_PAIRING 1
#define MSG_DATA    2

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
#define WIFI_CONNECT_TIMEOUT_MS 15000  // ms to wait for WiFi after credentials received

// --- NTP CONFIGURATION ---
const char*         ntpServer          = "pool.ntp.org";
const long          gmtOffset_sec      = 7200;
const int           daylightOffset_sec = 3600;
const unsigned long NTP_SYNC_INTERVAL  = 86400000;  // 24 h

bool          timeConfigured = false;
unsigned long lastNtpSync    = 0;

// --- MESSAGE STRUCTURE (must be byte-for-byte identical on hub and all sensors) ---
typedef struct struct_message {
  uint8_t msgType;
  float   temp;
  float   hum;
  uint8_t battery;  // 0–100 %; 255 = read error
} struct_message;

struct_message incomingData;
volatile int   incomingRSSI = 0;

// --- SENSOR DATA STORAGE ---
#define MAX_SENSORS 10

struct SensorData {
  uint8_t       mac[6];
  float         temp;
  float         hum;
  int           rssi;
  unsigned long lastUpdate;
  bool          active;
  char          name[20];
  uint8_t       battery;
};

SensorData sensors[MAX_SENSORS];
int        sensorCount = 0;


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

bool cloudConfigured = false;  // true when MQTT credentials exist in NVS

// Non-blocking pending pairing — sensor waits for cloud approval in loop()
struct {
  uint8_t      mac[6];
  unsigned long startedAt;
  bool          active;
  bool          approved;
  bool          resolved;
} pendingPairing = {};

unsigned long      lastMqttReconnect    = 0;
const unsigned long MQTT_RECONNECT_MS   = 5000;
const unsigned long PAIRING_TIMEOUT_MS  = 60000;

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
            // Bad MQTT credentials — erase them so the user can re-provision
            Preferences cPrefs; cPrefs.begin("cloud", false); cPrefs.clear(); cPrefs.end();
            cloudConfigured = false;
            notifyStatus("failed", "Cloud connection failed — check MQTT credentials");
            NimBLEDevice::startAdvertising();
            // Stay in the provisioning loop; app shows "failed" and user
            // can resend PROV_CLOUD (which will set cloudProvReceived = true)
          } else {
            mqttClient.disconnect();
            wifiSecure.stop();
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
          Preferences cPrefs; cPrefs.begin("cloud", false); cPrefs.clear(); cPrefs.end();
          cloudConfigured = false;
          notifyStatus("failed", "Cloud connection failed — check MQTT credentials");
          NimBLEDevice::startAdvertising();
        } else {
          mqttClient.disconnect();
          wifiSecure.stop();
          notifyStatus("connected", "");
          delay(1200);
          ESP.restart();
        }
      }
    }

    // BOOT button: erase all provisioning data and restart
    if (digitalRead(TRIGGER_PIN) == LOW) {
      delay(50);
      unsigned long press = millis();
      while (digitalRead(TRIGGER_PIN) == LOW) {
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
  sensors[sensorCount].active     = true;
  sensors[sensorCount].temp       = 0;
  sensors[sensorCount].hum        = 0;
  sensors[sensorCount].rssi       = 0;
  sensors[sensorCount].battery    = 0;
  sensors[sensorCount].lastUpdate = millis();
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
  sensors[index].temp       = temp;
  sensors[index].hum        = hum;
  sensors[index].rssi       = rssi;
  sensors[index].battery    = battery;
  sensors[index].lastUpdate = millis();
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
    sensors[sensorCount].active     = false;
    sensors[sensorCount].temp       = 0;
    sensors[sensorCount].hum        = 0;
    sensors[sensorCount].rssi       = 0;
    sensors[sensorCount].battery    = 0;
    sensors[sensorCount].lastUpdate = 0;
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
  Serial.printf("[MQTT] Hub MAC: %s\n", hubMacStr);
}

// Called by PubSubClient when a subscribed message arrives.
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String json = String((char*)payload, length);

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
  sensors[sensorCount].active     = false;
  sensors[sensorCount].temp       = 0;
  sensors[sensorCount].hum        = 0;
  sensors[sensorCount].rssi       = 0;
  sensors[sensorCount].battery    = 0;
  sensors[sensorCount].lastUpdate = 0;

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
// Returns true on success.
bool connectCloud() {
  if (!cloudConfigured) return false;

  // Encrypt the connection but skip CA certificate validation.
  // The broker address is trusted via network (VPS + Let's Encrypt TLS).
  wifiSecure.setInsecure();

  mqttClient.setServer(mqttHost, mqttPort);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1024);  // sync payloads can reach ~500 bytes
  mqttClient.setKeepAlive(30);

  // Client ID includes last 3 MAC octets so it is unique per device
  uint8_t mac[6]; WiFi.macAddress(mac);
  char clientId[24];
  snprintf(clientId, sizeof(clientId), "TempHub-%02X%02X%02X", mac[3], mac[4], mac[5]);

  // LWT: broker publishes this if MQTT connection drops unexpectedly
  const char* lwt = "{\"online\":false}";

  Serial.printf("[MQTT] Connecting to %s:%d as \"%s\"...\n", mqttHost, mqttPort, mqttUser);
  if (!mqttClient.connect(clientId, mqttUser, mqttPass, topicStatus, 0, true, lwt)) {
    Serial.printf("[MQTT] Connection failed (state %d)\n", mqttClient.state());
    return false;
  }

  Serial.println("[MQTT] Connected!");
  mqttClient.subscribe(topicPairResp);
  // Cloud-sync subscriptions: hub receives sensor-list updates from cloud
  mqttClient.subscribe(topicSync);
  mqttClient.subscribe(topicSensorRemove);
  mqttClient.subscribe(topicSensorRename);

  // Publish retained online status so the dashboard sees us immediately
  String status = "{\"online\":true,\"ip\":\"" + WiFi.localIP().toString() + "\"}";
  mqttClient.publish(topicStatus, status.c_str(), /*retain=*/true);

  // Report local sensor list so the cloud can diff and send back its authoritative list
  publishSyncRequest();
  return true;
}

// Call every loop() iteration: keeps MQTT alive and reconnects after drops.
void maintainCloud() {
  if (!cloudConfigured) return;
  if (mqttClient.connected()) {
    mqttClient.loop();
    return;
  }
  if (millis() - lastMqttReconnect < MQTT_RECONNECT_MS) return;
  lastMqttReconnect = millis();
  Serial.println("[MQTT] Reconnecting...");
  connectCloud();
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

  // Tell the cloud the pairing is complete so it can persist the sensor to its database.
  publishSyncRequest();

  digitalWrite(LED_PIN, HIGH); delay(200); digitalWrite(LED_PIN, LOW);
}

// Publish one sensor reading to the cloud.
// Called from updateSensor() after the local store is updated.
void publishSensorData(int idx) {
  if (!cloudConfigured || !mqttClient.connected()) return;

  const SensorData& s = sensors[idx];
  char sensorMacStr[18];
  snprintf(sensorMacStr, sizeof(sensorMacStr), "%02X:%02X:%02X:%02X:%02X:%02X",
           s.mac[0], s.mac[1], s.mac[2], s.mac[3], s.mac[4], s.mac[5]);

  // ISO-8601 timestamp (UTC)
  char ts[21] = "";
  struct tm ti;
  if (getLocalTime(&ti)) strftime(ts, sizeof(ts), "%Y-%m-%dT%H:%M:%SZ", &ti);

  char payload[220];
  snprintf(payload, sizeof(payload),
    "{\"sensor_mac\":\"%s\",\"temp\":%.2f,\"hum\":%.2f,"
    "\"battery\":%d,\"rssi\":%d,\"ts\":\"%s\"}",
    sensorMacStr, s.temp, s.hum, s.battery, s.rssi, ts);

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

// ─────────────────────────────────────────────────────────────────────────────
// ESP-NOW CALLBACK (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

void OnDataRecv(const esp_now_recv_info_t* esp_now_info,
                const uint8_t* incomingDataBytes, int len) {
  memcpy(&incomingData, incomingDataBytes, sizeof(incomingData));
  incomingRSSI = esp_now_info->rx_ctrl->rssi;

  if (incomingData.msgType == MSG_PAIRING) {
    Serial.printf("Pairing Request from: %02X:%02X:%02X:%02X:%02X:%02X\n",
                  esp_now_info->src_addr[0], esp_now_info->src_addr[1],
                  esp_now_info->src_addr[2], esp_now_info->src_addr[3],
                  esp_now_info->src_addr[4], esp_now_info->src_addr[5]);

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
      // Cloud not configured or MQTT disconnected — auto-accept immediately (fallback)
      Serial.println("[Pairing] Cloud offline — auto-accepting");
      completePairing(esp_now_info->src_addr);
    }
  }
  else if (incomingData.msgType == MSG_DATA) {
    Serial.print("DATA from: ");
    for (int i = 0; i < 5; i++) Serial.printf("%02X:", esp_now_info->src_addr[i]);
    Serial.printf("%02X", esp_now_info->src_addr[5]);

    if (incomingData.temp < -50 || incomingData.temp > 100 ||
        incomingData.hum  <   0 || incomingData.hum  > 100) {
      Serial.println(" | ERROR: Invalid sensor data!"); return;
    }

    Serial.printf(" | Temp: %.2f°C | Hum: %.2f%% | RSSI: %d dBm | Bat: %d%% | ",
                  incomingData.temp, incomingData.hum,
                  incomingRSSI, incomingData.battery);
    printCurrentTime();

    int index = findSensor(esp_now_info->src_addr);
    if (index == -1) {
      index = addSensor(esp_now_info->src_addr);
      // Sensor was unknown — likely dropped by a cloud-sync race after pairing.
      // Re-register it with the cloud so the dashboard picks it up.
      publishSyncRequest();
    }
    if (index != -1)
      updateSensor(index, incomingData.temp, incomingData.hum,
                   incomingRSSI, incomingData.battery);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== XIAO ESP32-C6 Hub ===");

  pinMode(TRIGGER_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // ── Load stored WiFi credentials ────────────────────────────────────────
  Preferences wPrefs;
  wPrefs.begin("wifi", true);
  String storedSsid = wPrefs.getString("ssid", "");
  String storedPass = wPrefs.getString("pass", "");
  wPrefs.end();

  if (storedSsid.isEmpty()) {
    // No credentials — enter BLE provisioning (blocks until done, then restarts)
    startBleProvisioning();
    return;  // unreachable; startBleProvisioning() calls ESP.restart()
  }

  // ── WiFi connect with stored credentials ────────────────────────────────
  // Use AP_STA from the start — switching modes while connected drops the STA.
  // Set tx-power and protocol before connecting so they never disrupt the STA.
  Serial.printf("Connecting to WiFi: %s\n", storedSsid.c_str());
  WiFi.mode(WIFI_AP_STA);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G |
                                      WIFI_PROTOCOL_11N | WIFI_PROTOCOL_LR);
  WiFi.begin(storedSsid.c_str(), storedPass.c_str());

  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - wifiStart > WIFI_CONNECT_TIMEOUT_MS) {
      Serial.println("WiFi connection timed out — clearing credentials, restarting.");
      wPrefs.begin("wifi", false); wPrefs.clear(); wPrefs.end();
      ESP.restart();
    }
    delay(200);
  }
  Serial.printf("✓ WiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());

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

  Serial.println("\n=== Hub Ready ===");
  Serial.println("Waiting for sensor data...\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// LOOP
// ─────────────────────────────────────────────────────────────────────────────

void loop() {
  server.handleClient();
  maintainCloud();

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

  if (timeConfigured) resyncNTP();

  // BOOT button: hold 3 s to erase WiFi credentials → restart into BLE provisioning
  if (digitalRead(TRIGGER_PIN) == LOW) {
    delay(50);
    unsigned long startPress = millis();
    Serial.println("Button pressed... (hold 3 s to reset WiFi and re-provision)");

    while (digitalRead(TRIGGER_PIN) == LOW) {
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

  delay(10);
}
