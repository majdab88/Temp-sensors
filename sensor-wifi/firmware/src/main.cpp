// sensor-wifi — NTC sensor on WiFi, USB-C powered, Li-ion backup.
//
// Two programs in one image, chosen at every boot by /PGOOD:
//
//   mains    WiFi + MQTT held up; read every interval, upload at once.
//   battery  deep sleep between readings; every reading is logged to flash,
//            uploads are attempted with back-off, because when the mains is out
//            the router usually is too.
//
// Every reading goes to the flash ring log first and is uploaded from there, in
// both modes, so there is one path to the cloud and it is the one the outage
// case depends on. See ../../DESIGN.md.

#include <Arduino.h>
#include <WiFi.h>
#include <Preferences.h>
#include <esp_mac.h>
#include <esp_sleep.h>
#include <esp_wifi.h>
#include "config.h"
#include "measure.h"
#include "settings.h"
#include "datalog.h"
#include "cloud.h"
#include "ota.h"
#include "ble_prov.h"

char g_macStr[18] = "";

// Battery-mode upload back-off, in wakes. Survives deep sleep only: a power
// cycle should try at once.
RTC_DATA_ATTR static uint8_t r_backoff      = 0;
RTC_DATA_ATTR static uint8_t r_wakesToRetry = 0;

static Reading       s_last;
static unsigned long s_lastReadingMs = 0;
static unsigned long s_lastDrainMs   = 0;
static unsigned long s_pgoodLostAt   = 0;
static bool          s_readNow       = true;

// ── helpers ─────────────────────────────────────────────────────────────────

static void blink(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH); delay(ms);
    digitalWrite(LED_PIN, LOW);  if (i + 1 < times) delay(ms);
  }
}

static void logReading(const Reading& r) {
  LogRec rec = {};
  rec.ts       = timeValid() ? (uint32_t)time(nullptr) : 0;
  rec.tempC100 = (r.temp == TEMP_ERROR) ? LOG_TEMP_ERROR : (int16_t)lroundf(r.temp * 100.0f);
  rec.batMv    = r.batV > 0 ? (uint16_t)(r.batV * 1000.0f) : 0;
  rec.batPct   = r.batPct;
  rec.rssi     = wifiRssi();
  rec.flags    = (r.onMains ? 0 : LOGF_BATTERY) | (r.charging ? LOGF_CHARGING : 0);
  logAppend(rec);
}

// Held for RESET_HOLD_MS: erase WiFi + cloud credentials and restart into BLE
// provisioning. Returns false on a shorter press. Solid LED while held, fast
// blinks once the hold counts — without that a 3 s hold feels like a dead button.
static bool buttonHoldConfirmed() {
  if (digitalRead(BUTTON_PIN) != LOW) return false;
  delay(50);
  if (digitalRead(BUTTON_PIN) != LOW) return false;
  digitalWrite(LED_PIN, HIGH);
  unsigned long start = millis();
  while (digitalRead(BUTTON_PIN) == LOW) {
    if (millis() - start > RESET_HOLD_MS) {
      blink(6, 80);
      Preferences p;
      p.begin("wifi", false);  p.clear(); p.end();
      p.begin("cloud", false); p.clear(); p.end();
      Serial.println("[BTN] Credentials erased — restarting into provisioning");
      delay(300);
      ESP.restart();
    }
    delay(10);
  }
  digitalWrite(LED_PIN, LOW);
  return false;
}

// Mandatory on the C6 before deep sleep: skipping the WiFi teardown has caused
// an illegal-instruction crash (MCAUSE 0x18) on the ESP-NOW sensors.
static void deepSleep(uint32_t secs, bool timer) {
  cloudDisconnect();
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  esp_wifi_stop();
  digitalWrite(LED_PIN, LOW);

  // Wake on USB power returning (/PGOOD low) or a button press. A button stuck
  // low would wake the node continuously, so it is left out while held.
  uint64_t mask = 1ULL << PGOOD_PIN;
  if (digitalRead(BUTTON_PIN) == HIGH) mask |= 1ULL << BUTTON_PIN;
  esp_sleep_enable_ext1_wakeup_io(mask, ESP_EXT1_WAKEUP_ANY_LOW);
  if (timer) esp_sleep_enable_timer_wakeup((uint64_t)secs * 1000000ULL);

  Serial.printf("[SLEEP] %s\n", timer ? (String(secs) + " s").c_str() : "until USB or button");
  Serial.flush();
  esp_deep_sleep_start();
}

// ── battery mode ────────────────────────────────────────────────────────────

static void batteryCycle(esp_sleep_wakeup_cause_t cause) {
  bool buttonWake = false;
  if (cause == ESP_SLEEP_WAKEUP_EXT1) {
    buttonWake = esp_sleep_get_ext1_wakeup_status() & (1ULL << BUTTON_PIN);
  }
  if (buttonWake) blink(1, 60);

  Reading r = takeReading();
  logReading(r);

  bool batReadable = r.batV >= BAT_ERROR_V;
  if (batReadable && r.batV < BAT_HIBERNATE_V) {
    Serial.printf("[BAT] %.2f V — hibernating until USB returns\n", r.batV);
    deepSleep(0, false);
  }

  bool wifiAllowed = !batReadable || r.batV >= BAT_MIN_WIFI_V;
  bool due = r_wakesToRetry == 0 || buttonWake;

  if (wifiAllowed && due) {
    otaBeginAttempt();
    bool delivered = false;
    if (wifiConnect(WIFI_WAKE_TIMEOUT_MS)) {
      ntpStart();
      if (cloudConnect(r)) {
        // Retained commands (config, OTA) arrive right after subscribing; give
        // them a moment before the backlog fills the socket.
        unsigned long t = millis();
        while (millis() - t < RETAINED_WAIT_MS) { cloudLoop(); delay(10); }
        ntpWait(timeValid() ? 300 : NTP_WAIT_MS);
        int n = cloudDrainLog();
        delivered = n >= 0 && logPending() == 0;
        cloudPublishStatus(r, true, effectiveIntervalS());
      }
    }
    if (delivered) {
      r_backoff = 0;
      r_wakesToRetry = 0;
    } else {
      r_backoff = r_backoff ? min<int>(r_backoff * 2, BACKOFF_MAX_WAKES) : 1;
      r_wakesToRetry = r_backoff;
      Serial.printf("[UP] Failed — next attempt in %u wake(s), %lu reading(s) waiting\n",
                    r_backoff, (unsigned long)logPending());
    }
  } else if (r_wakesToRetry) {
    r_wakesToRetry--;
    Serial.printf("[UP] Skipped (%s), %lu reading(s) waiting\n",
                  wifiAllowed ? "backing off" : "battery too low for WiFi",
                  (unsigned long)logPending());
  }

  deepSleep(effectiveIntervalS(), true);
}

// ── mains mode ──────────────────────────────────────────────────────────────

static void mainsSetup() {
  Serial.println("[MODE] Mains");
  r_backoff = r_wakesToRetry = 0;
  otaBeginAttempt();
  if (wifiConnect(15000)) {
    ntpStart();
    ntpWait(NTP_WAIT_MS);
  }
  s_last = takeReading();   // for the status payload; logged from loop()
  cloudConnect(s_last);
}

// USB power gone. Take one reading now so the dashboard sees the moment it
// happened, try to get it out while the router may still be up, then hand over
// to the battery cycle.
static void onPowerLost() {
  Serial.println("[POWER] Mains lost — switching to battery");
  s_last = takeReading();
  logReading(s_last);
  if (cloudConnected()) {
    cloudDrainLog();
    cloudPublishStatus(s_last, true, effectiveIntervalS());
  }
  deepSleep(effectiveIntervalS(), true);
}

static void mainsLoop() {
  // Power source, debounced.
  if (!mainsPresent()) {
    if (!s_pgoodLostAt) s_pgoodLostAt = millis();
    else if (millis() - s_pgoodLostAt > PGOOD_DEBOUNCE_MS) onPowerLost();
  } else {
    s_pgoodLostAt = 0;
  }

  // Short press: read now. Hold: re-provision (does not return).
  if (digitalRead(BUTTON_PIN) == LOW) {
    buttonHoldConfirmed();
    s_readNow = true;
  }

  wifiMaintain();
  cloudMaintain(s_last);
  ntpMaintain();

  // Hold the first reading until the clock is set (or a minute has passed), so
  // it is not stored without a timestamp.
  bool clockReady = timeValid() || millis() > 60000;
  if (clockReady &&
      (s_readNow || millis() - s_lastReadingMs >= effectiveIntervalS() * 1000UL)) {
    s_readNow = false;
    s_lastReadingMs = millis();
    s_last = takeReading();
    logReading(s_last);
    digitalWrite(LED_PIN, HIGH); delay(30); digitalWrite(LED_PIN, LOW);
    s_lastDrainMs = 0;   // upload straight away
    cloudPublishStatus(s_last, true, effectiveIntervalS());
  }

  if (cloudConnected() && logPending() > 0 &&
      (!s_lastDrainMs || millis() - s_lastDrainMs > 10000)) {
    s_lastDrainMs = millis();
    cloudDrainLog();
  }

  if (otaPending()) otaRun();
  if (otaWindowExpired()) {
    Serial.println("[OTA] Unconfirmed image could not deliver in time — restarting");
    delay(100);
    ESP.restart();
  }
  delay(10);
}

// ── entry ───────────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  measureInitPins();

  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(g_macStr, sizeof(g_macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  // Printing the tag also keeps it in the image, where ota.cpp and the
  // registry look for it.
  Serial.printf("\n[BOOT] " FW_VERSION_TAG "  %s  wake=%d\n", g_macStr, (int)cause);

  buttonHoldConfirmed();   // held through boot or wake: re-provision
  settingsLoad();
  logInit();
  otaLoadState();

  if (!cloudLoadCredentials()) bleProvision();   // does not return

  if (mainsPresent()) mainsSetup();
  else                batteryCycle(cause);       // does not return
}

void loop() {
  mainsLoop();
}
