#include <Arduino.h>

#include <esp_now.h>
#include <WiFi.h>
#include <Wire.h>
#include <SensirionI2cSht4x.h>
#include <Preferences.h>
#include <mbedtls/md.h>     // HMAC-SHA256 over each message
#include <esp_wifi.h>
#include <esp_sleep.h>   // Explicit include needed on C6

// --- XIAO ESP32-C6 PIN DEFINITIONS ---
#define LED_PIN   15    // Built-in LED on XIAO ESP32-C6
#define RESET_PIN  0    // External reset button on D0 (GPIO0 — LP GPIO, supports deep sleep wakeup)
#define SDA_PIN   22    // I2C SDA (D4)
#define SCL_PIN   23    // I2C SCL (D5)
#define BAT_ADC_PIN         2   // GPIO2/D2 — ADC input (resistor divider midpoint)
#define DIVIDER_ENABLE_PIN  1   // GPIO1/D1 — ground switch; LOW enables divider, INPUT (Hi-Z) during sleep

// --- SLEEP SETTINGS ---
#define SLEEP_TIME 900  // Seconds

// --- RETRY SETTINGS ---
#define MAX_RETRIES    5
#define RETRY_DELAY_MS 100
#define TX_TIMEOUT_MS  500

// --- COMMUNICATION CHANNEL ---
#define ESPNOW_CHANNEL 0          // 0 = auto-detect
#define HUB_AP_SSID   "TempHub-AP"  // hub's hidden AP — always on the ESP-NOW channel
#define FALLBACK_CHANNEL 1        // used when neither hub AP nor any router is visible

// --- BATTERY MONITOR ---
#define ADC_SAMPLES      20  // Readings to average for a stable result
#define LOW_BATTERY_PCT  15  // "LOW" status below this %
#define CRITICAL_PCT      5  // Sleep immediately below this % to protect the cell

// --- MESSAGE TYPES ---
#define MSG_PAIRING 1
#define MSG_DATA    2

// --- ESP-NOW ENCRYPTION ---
// IMPORTANT: These keys must be identical on all devices (hub + all sensors)
// Change both bytes below to your own secret values before deploying
static const uint8_t PMK_KEY[16] = {
  0x4A, 0x2F, 0x8C, 0x1E, 0x7B, 0x3D, 0x9A, 0x5F,
  0x6E, 0x2C, 0x4B, 0x8D, 0x1A, 0x7F, 0x3E, 0x9C
};
// --- MESSAGE AUTHENTICATION ---
// Must match the hub and every other sensor. The link is no longer encrypted:
// ESP-NOW spends a hardware key slot per encrypted peer, which capped a hub at
// seven sensors, so authenticity lives in the message instead. See the hub's
// AUTH_KEY for the full reasoning.
static const uint8_t AUTH_KEY[32] = {
  0x5B, 0x2E, 0xC4, 0x91, 0x7A, 0x03, 0xD8, 0x66,
  0x1F, 0xB5, 0x40, 0xE7, 0x2C, 0x98, 0x71, 0x0A,
  0xD3, 0x64, 0x8F, 0x25, 0xB1, 0x7C, 0x06, 0xEA,
  0x49, 0x93, 0x2B, 0xF5, 0x18, 0xA7, 0x60, 0xCD,
};

#define AUTH_TAG_LEN 8

// This variant has no OTA receiver, so its version only ever changes by being
// flashed. It is reported so the dashboard can say which nodes are which.
#define FW_MAJOR 1
#define FW_MINOR 0
#define FW_PATCH 0

static const uint8_t LMK_KEY[16] = {
  0xE3, 0x4A, 0x7C, 0x91, 0xB5, 0x2D, 0xF8, 0x6E,
  0x1A, 0x9F, 0x3C, 0x72, 0xD4, 0x5B, 0x8E, 0x20
};

// --- BATTERY LOOKUP TABLE ---
// {voltage, percentage} for 3.7V Li-ion / 18650 measured at rest
struct BatteryPoint {
  float voltage;
  int   percentage;
};
const BatteryPoint batteryTable[] = {
  { 4.20, 100 }, { 4.15,  95 }, { 4.10,  90 }, { 4.05,  85 },
  { 4.00,  80 }, { 3.95,  75 }, { 3.90,  70 }, { 3.85,  65 },
  { 3.80,  60 }, { 3.75,  55 }, { 3.70,  50 }, { 3.65,  45 },
  { 3.60,  40 }, { 3.55,  35 }, { 3.50,  30 }, { 3.45,  25 },
  { 3.40,  20 }, { 3.30,  15 }, { 3.20,  10 }, { 3.10,   5 },
  { 3.00,   0 }
};
const int TABLE_SIZE = sizeof(batteryTable) / sizeof(batteryTable[0]);

struct BatteryInfo {
  float       voltage;
  int         percentage;
  const char* status;
};

// --- MESSAGE STRUCTURE ---
// IMPORTANT: must be byte-for-byte identical on hub and all sensors
// Byte-for-byte identical to the hub's. This variant used to send the short
// legacy frame, which the hub still accepts -- but a short frame carries no
// tag, so it could never be authenticated. Sending the full one is what lets
// these nodes be trusted like the rest.
typedef struct struct_message {
  uint8_t  msgType;
  float    temp;
  float    hum;
  uint8_t  battery;   // 0–100 %; 255 = read error
  uint8_t  fw_major;
  uint8_t  fw_minor;
  uint8_t  fw_patch;
  uint16_t cfg_ver;   // this variant takes no remote config; always 0

  uint32_t auth_ctr;
  uint8_t  auth[AUTH_TAG_LEN];
} struct_message;

#define AUTH_BODY_LEN (sizeof(struct_message) - sizeof(uint32_t) - AUTH_TAG_LEN)

// Counters must never repeat, including across a power cycle, so they are
// claimed from NVS a block at a time and spent from RAM: one flash write per
// AUTH_CTR_BLOCK wakes rather than one per reading. Skipping the unspent tail
// of a block is harmless -- the rule is that they rise, not that none are
// missed.
#define AUTH_CTR_BLOCK 64
RTC_DATA_ATTR uint32_t authCtrNext  = 0;
RTC_DATA_ATTR uint32_t authCtrLimit = 0;

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

static uint32_t authNextCtr() {
  if (authCtrNext >= authCtrLimit) {
    Preferences p;
    p.begin("auth", false);
    uint32_t base = p.getUInt("ctr", 0);
    if (base < authCtrLimit) base = authCtrLimit;
    p.putUInt("ctr", base + AUTH_CTR_BLOCK);
    p.end();
    authCtrNext  = base;
    authCtrLimit = base + AUTH_CTR_BLOCK;
  }
  return authCtrNext++;
}

// --- GLOBALS ---
SensirionI2cSht4x sht4x;  // Lowercase 'c' !!
Preferences preferences;
esp_now_peer_info_t peerInfo;
struct_message myData;

uint8_t hubMac[6];
bool isPaired = false;
uint8_t broadcastAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

volatile bool tx_success  = false;
volatile bool tx_complete = false;

// --- SAFE DEEP SLEEP ---
// ESP32-C6 RISC-V requires proper WiFi/ESP-NOW shutdown before sleep
// Skipping this causes the illegal instruction crash (MCAUSE: 0x18)
void goToSleep(int seconds) {
  Serial.printf("Sleeping for %d seconds...\n\n", seconds);
  Serial.flush();         // Ensure serial output completes

  esp_now_deinit();       // Step 1: Deinit ESP-NOW
  esp_wifi_stop();        // Step 2: Stop WiFi radio
  delay(100);             // Step 3: Allow shutdown to settle

  esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
  // D0 (GPIO0) is an LP GPIO — supports deep sleep GPIO wakeup.
  // Pressing the button wakes the device early for factory reset or manual data send.
  esp_deep_sleep_enable_gpio_wakeup(1ULL << RESET_PIN, ESP_GPIO_WAKEUP_GPIO_LOW);
  esp_deep_sleep_start(); // Step 4: Sleep
}

// --- CALLBACKS ---
void OnDataSent(const wifi_tx_info_t *info, esp_now_send_status_t status) {
  tx_complete = true;
  tx_success  = (status == ESP_NOW_SEND_SUCCESS);
}

void OnDataRecv(const esp_now_recv_info_t *esp_now_info, const uint8_t *incomingData, int len) {
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

// --- READ SHT40 ---
bool readSensor() {
  Serial.println("Reading SHT40...");

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);
  delay(10); // I2C stabilization delay needed on C6

  sht4x.begin(Wire, 0x44);

  uint16_t error = sht4x.softReset();
  if (error) {
    Serial.printf("✗ SHT40 reset failed (error %d). Check wiring:\n", error);
    Serial.println("  SDA → D4 (GPIO22)  SCL → D5 (GPIO23)  VCC → 3V3  GND → GND");
    myData.temp = -999;
    myData.hum  = -999;
    return false;
  }
  delay(10);

  float temp, hum;
  error = sht4x.measureHighPrecision(temp, hum);

  if (error) {
    Serial.printf("✗ Measurement failed (error %d)\n", error);
    myData.temp = -999;
    myData.hum  = -999;
    return false;
  }

  if (isnan(temp) || isnan(hum)) {
    Serial.println("✗ Read failed (NaN)");
    myData.temp = -999;
    myData.hum  = -999;
    return false;
  }

  if (temp < -40 || temp > 125 || hum < 0 || hum > 100) {
    Serial.println("✗ Values out of range");
    myData.temp = -999;
    myData.hum  = -999;
    return false;
  }

  myData.temp = temp;
  myData.hum  = hum;
  Serial.printf("✓ Temp: %.2f°C  Hum: %.2f%%\n", myData.temp, myData.hum);
  return true;
}

// --- BATTERY MONITOR ---
// Circuit: BAT+ → R1(120kΩ) → GPIO2/D2(ADC) → R2(120kΩ) → GPIO1/D1(GND switch)
// D1=OUTPUT LOW enables divider; D1=INPUT (Hi-Z) cuts current during sleep.
float readADCVoltage() {
  // Attenuation already set and latched in getBatteryInfo(); divider settled.
  analogReadMilliVolts(BAT_ADC_PIN);   // discard first conversion (settling)
  delay(5);
  long sum = 0;
  for (int i = 0; i < ADC_SAMPLES; i++) {
    sum += analogReadMilliVolts(BAT_ADC_PIN);
    delay(5);
  }

  // Disable divider immediately after reading
  pinMode(DIVIDER_ENABLE_PIN, INPUT);   // Hi-Z — zero current draw

  float adcMv      = sum / (float)ADC_SAMPLES;
  float adcVoltage = adcMv / 1000.0f;
  int   rawCount   = analogRead(BAT_ADC_PIN);  // diagnostic: raw 12-bit count
  Serial.printf("[BAT] pin_mv=%.0f  raw=%d  bat_v=%.3f\n", adcMv, rawCount, adcVoltage * 2.0f);
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

BatteryInfo getBatteryInfo() {
  analogReadResolution(12);

  // Enable divider: drive GPIO4 LOW to complete the GND path
  pinMode(DIVIDER_ENABLE_PIN, OUTPUT);
  digitalWrite(DIVIDER_ENABLE_PIN, LOW);
  delay(10);  // let divider settle before warm-up reads

  // On ESP32-C6 core 3.x the attenuation must be set AFTER the channel is
  // first initialised by analogRead(), otherwise it silently no-ops.
  analogRead(BAT_ADC_PIN);                        // initialise channel
  analogSetPinAttenuation(BAT_ADC_PIN, ADC_11db); // switch to 11 dB
  analogRead(BAT_ADC_PIN);                        // latch new attenuation

  float voltage = readADCVoltage();
  int   pct;
  if (voltage < 2.5f) {
    pct = 255;  // implausible — circuit not connected or no battery
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
  // Version and config fields are filled here rather than at every call site,
  // so a reading cannot go out describing itself as coming from nowhere.
  myData.fw_major = FW_MAJOR;
  myData.fw_minor = FW_MINOR;
  myData.fw_patch = FW_PATCH;
  myData.cfg_ver  = 0;

  // One counter and one tag for the whole attempt, not one per retry: a retry
  // is the same reading said again, and the hub's duplicate filter needs the
  // frames to be identical.
  myData.auth_ctr = authNextCtr();
  {
    uint8_t self[6];
    WiFi.macAddress(self);
    authTag(self, myData.auth_ctr, (const uint8_t *)&myData, AUTH_BODY_LEN, myData.auth);
  }

  for (int retry = 0; retry < MAX_RETRIES; retry++) {
    tx_complete = false;
    tx_success  = false;

    esp_err_t result = esp_now_send(hubMac, (uint8_t *)&myData, sizeof(myData));

    if (result != ESP_OK) {
      Serial.printf("✗ Send error: 0x%X  Retry %d/%d\n", result, retry+1, MAX_RETRIES);
      delay(RETRY_DELAY_MS);
      continue;
    }

    // Wait for TX callback
    unsigned long start = millis();
    while (!tx_complete && (millis() - start < TX_TIMEOUT_MS)) {
      delay(5);
    }

    if (tx_success) {
      Serial.println("✓ Delivered!");
      digitalWrite(LED_PIN, HIGH); delay(100); digitalWrite(LED_PIN, LOW);
      return true;
    }

    Serial.printf("✗ %s  Retry %d/%d\n",
      tx_complete ? "No ACK" : "Timeout",
      retry+1, MAX_RETRIES);
    delay(RETRY_DELAY_MS);
  }

  Serial.println("✗ All retries failed.");
  return false;
}

// Scan for the hub's hidden AP first — it is always on the exact channel the
// hub's ESP-NOW radio is listening on (ch 1 when WiFi is down, router channel
// when WiFi is up). Fall back to the strongest visible router if the hub AP
// is not seen, and to FALLBACK_CHANNEL (1) if nothing is found at all.
uint8_t detectWiFiChannel() {
  Serial.print("Scanning for WiFi channel...");
  // show_hidden=true is required to see the hub's hidden AP "TempHub-AP".
  int n = WiFi.scanNetworks(/*async=*/false, /*show_hidden=*/true);

  // Prefer the hub's own AP — its channel is always correct.
  for (int i = 0; i < n; i++) {
    if (WiFi.SSID(i) == HUB_AP_SSID) {
      uint8_t ch = (uint8_t)WiFi.channel(i);
      Serial.printf(" hub AP on ch %d\n", ch);
      WiFi.scanDelete();
      return ch;
    }
  }

  // Hub AP not visible — use the strongest router as a channel hint.
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
    // Re-broadcast every 2 s so the hub doesn't need to catch the very first packet
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
  pinMode(3, OUTPUT);
  digitalWrite(3, LOW);
  delay(100);
  pinMode(14, OUTPUT);
  digitalWrite(14, HIGH); // external antenna

  Serial.begin(115200);
  delay(500); // C6 needs extra time for serial to stabilize
  Serial.println("\n=== XIAO ESP32-C6 Sensor (SHT40) ===");

  pinMode(RESET_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  checkFactoryReset();

  // Log wakeup reason
  esp_sleep_wakeup_cause_t wakeup_reason = esp_sleep_get_wakeup_cause();
  if (wakeup_reason == ESP_SLEEP_WAKEUP_GPIO) {
    Serial.println("Wakeup caused by button press on D0");
  }

  // Read battery BEFORE radio init — divider must be off during sleep
  BatteryInfo bat = getBatteryInfo();
  Serial.printf("Battery: %.2fV  %d%%  %s\n", bat.voltage, bat.percentage, bat.status);
  if (bat.percentage != 255 && bat.percentage <= CRITICAL_PCT) {
    Serial.println("Battery critical — sleeping to protect cell.");
    esp_sleep_enable_timer_wakeup((uint64_t)SLEEP_TIME * 1000000ULL);
    esp_deep_sleep_start();
  }

  // Load pairing
  preferences.begin("network", true);
  size_t len = preferences.getBytes("hubMac", hubMac, 6);
  preferences.end();
  isPaired = (len == 6);

  if (isPaired) {
    Serial.printf("✓ Paired to: %02X:%02X:%02X:%02X:%02X:%02X\n",
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

  // Match the hub's WiFi channel before ESP-NOW init — required for both
  // data mode and pairing mode since the hub is locked to its router's channel.
  {
    uint8_t ch = detectWiFiChannel();
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
    // Unencrypted by design: authenticity is carried in the message, so a hub is
  // not limited to seven sensors by the radio's key slots.
  peerInfo.encrypt = false;
    memcpy(peerInfo.lmk, LMK_KEY, 16);

    if (esp_now_add_peer(&peerInfo) != ESP_OK) {
      Serial.println("✗ Peer add failed, restarting...");
      ESP.restart();
    }

    myData.msgType  = MSG_DATA;
    myData.battery  = (uint8_t)bat.percentage;
    readSensor();

    if (!sendDataWithRetry()) {
      // All retries failed. The hub may have been mid-WiFi-reconnect when we
      // scanned, making its AP invisible and landing us on the wrong channel.
      // Wait 5 s for the hub to finish and re-scan so we pick up TempHub-AP
      // (now back on ch 1) before the final attempt.
      Serial.println("Waiting 5s then re-scanning and retrying...");
      delay(5000);
      uint8_t ch = detectWiFiChannel();
      esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
      sendDataWithRetry();
    }

    goToSleep(SLEEP_TIME);
    //ESP.restart();  // Use this instead during testing
  } else {
    enterPairingMode();
  }
}

void loop() {
  // Never reached
}
