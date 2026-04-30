#include <Arduino.h>

#include <esp_now.h>
#include <WiFi.h>
#include <Preferences.h>
#include <esp_wifi.h>
#include <esp_sleep.h>   // Explicit include needed on C6

// --- XIAO ESP32-C6 PIN DEFINITIONS ---
#define LED_PIN            15   // Built-in LED on XIAO ESP32-C6
#define RESET_PIN           0   // External reset button on D0 (GPIO0 — LP GPIO, supports deep sleep wakeup)
#define BAT_ADC_PIN         2   // GPIO2/D2 — ADC input (battery resistor divider midpoint)
#define DIVIDER_ENABLE_PIN 21   // GPIO21/D3 — battery divider GND switch; LOW enables divider, INPUT (Hi-Z) during sleep
#define NTC_PIN             1   // GPIO1/D1 — ADC input for NTC voltage divider midpoint
#define NTC_ENABLE_PIN     22   // GPIO22/D4 — NTC divider GND switch; LOW enables divider, INPUT (Hi-Z) during sleep

// --- NTC PROBE PARAMETERS ---
// Adjust these constants to match your specific NTC thermistor's datasheet.
// Common 10kΩ probe (e.g. 10k @ 25°C, B=3950):
#define NTC_NOMINAL     10000   // NTC resistance at reference temperature (Ω)
#define NTC_BCOEFF       3435   // Beta coefficient of the NTC (K) — Eliwell/Carel/Dixell standard NTC 10K curve
#define NTC_T0_CELSIUS     25   // Reference temperature for NTC_NOMINAL (°C)
#define SERIES_RESISTOR 10000   // Series resistor value (Ω) — must be 1% tolerance or better
#define NTC_SAMPLES        20   // ADC readings to average for stable result
// Two-point linear calibration: T_cal = T_raw * NTC_CAL_GAIN + NTC_CAL_OFFSET
// How to calibrate:
//   1. Stabilize sensor, note raw T (serial log) and reference T at a COLD point → (raw1, ref1)
//   2. Repeat at a HOT point (e.g. warm water vs ice water, or fridge vs room) → (raw2, ref2)
//   3. gain   = (ref2 - ref1) / (raw2 - raw1)
//      offset = ref1 - gain * raw1
// Single-point only: leave NTC_CAL_GAIN=1.0 and set NTC_CAL_OFFSET = ref - raw
#define NTC_CAL_GAIN      1.0f  // slope — 1.0 = no gain correction
#define NTC_CAL_OFFSET    0.0f  // °C offset — 0.0 = no offset

// PCB circuit (for reference):
//   3.3V ─── SERIES_RESISTOR ─── NTC_PIN (ADC) ─── NTC probe ─── NTC_ENABLE_PIN (GND switch)
//                                  │
//                                  └── 100 nF filter cap (Cfn) ── GND
// NTC_ENABLE_PIN driven LOW to enable divider; INPUT (Hi-Z) during sleep to cut quiescent current.
// Cfn low-pass filters the ADC input (RC ≈ 0.5 ms with ~5 kΩ source impedance).
// The existing 10 ms settling delay after enabling the divider covers the filter-cap charge-up.

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
  uint8_t msgType;
  float temp;
  float hum;
  uint8_t battery;   // 0–100 %; 255 = read error
} struct_message;

// --- GLOBALS ---
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
  delay(10); // Let divider + 100 nF filter cap settle (RC ≈ 0.5 ms, 10 ms covers 20× time constants)

  analogReadResolution(12);
  analogRead(NTC_PIN);                       // Initialise ADC channel
  analogSetPinAttenuation(NTC_PIN, ADC_6db); // 0–2.2 V range — covers -40°C to +40°C for 10K NTC
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
  float vcc    = 3.3f;

  if (adcV <= 0.01f || adcV >= (vcc - 0.01f)) {
    // Saturated ADC almost certainly means open or shorted probe
    Serial.println("✗ NTC read failed — probe open or shorted (check wiring)");
    return -999;
  }

  // Resolve NTC resistance from voltage divider equation
  // V_adc = vcc * R_series / (R_ntc + R_series)  =>  R_ntc = R_series * (vcc - V_adc) / V_adc
  float r_ntc = SERIES_RESISTOR * (vcc - adcV) / adcV;

  // Steinhart-Hart beta equation
  float t0K      = (float)(NTC_T0_CELSIUS) + 273.15f;
  float steinhart = log(r_ntc / (float)NTC_NOMINAL) / (float)NTC_BCOEFF + 1.0f / t0K;
  float tempC    = (1.0f / steinhart) - 273.15f;

  tempC = tempC * NTC_CAL_GAIN + NTC_CAL_OFFSET;
  Serial.printf("[NTC] adc=%.0fmV  R_ntc=%.0fΩ  T=%.2f°C\n", adcMv, r_ntc, tempC);

  if (tempC < -55.0f || tempC > 125.0f) {
    Serial.println("✗ NTC temperature out of valid range");
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
  Serial.printf("✓ Temp: %.2f°C  Hum: N/A\n", myData.temp);
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
  pinMode(3, OUTPUT);
  digitalWrite(3, LOW);
  delay(100);
  pinMode(14, OUTPUT);
  digitalWrite(14, HIGH); // external antenna

  Serial.begin(115200);
  delay(500); // C6 needs extra time for serial to stabilize
  Serial.println("\n=== XIAO ESP32-C6 Sensor (NTC Probe) ===");

  pinMode(RESET_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  checkFactoryReset();

  esp_sleep_wakeup_cause_t wakeup_reason = esp_sleep_get_wakeup_cause();
  if (wakeup_reason == ESP_SLEEP_WAKEUP_GPIO) {
    Serial.println("Wakeup caused by button press on D0");
  }

  // Read battery BEFORE radio init
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
    peerInfo.encrypt = true;
    memcpy(peerInfo.lmk, LMK_KEY, 16);

    if (esp_now_add_peer(&peerInfo) != ESP_OK) {
      Serial.println("✗ Peer add failed, restarting...");
      ESP.restart();
    }

    myData.msgType  = MSG_DATA;
    myData.battery  = (uint8_t)bat.percentage;
    readSensor();

    if (!sendDataWithRetry()) {
      Serial.println("Waiting 5s then re-scanning and retrying...");
      delay(5000);
      uint8_t ch = detectWiFiChannel();
      esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
      sendDataWithRetry();
    }

    goToSleep(SLEEP_TIME);
  } else {
    enterPairingMode();
  }
}

void loop() {
  // Never reached
}
