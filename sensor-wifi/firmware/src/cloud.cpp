#include "cloud.h"
#include "config.h"
#include "datalog.h"
#include "json.h"
#include "ota.h"
#include "settings.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <esp_sntp.h>
#include <time.h>

static WiFiClientSecure s_tls;
static PubSubClient     s_mqtt(s_tls);

static char s_ssid[65], s_pass[65];
static char s_host[128], s_user[65], s_mqttPass[65];
static int  s_port = 8883;
static int  s_lastState = 0;

static char t_data[48], t_status[48], t_otaCmd[56], t_otaStatus[56];
static char t_cfgSet[56], t_cfgState[56], t_liveReq[56], t_liveState[56], t_echo[56];

// Where the AP was last time. A battery wake that skips the scan joins in well
// under a second instead of several.
RTC_DATA_ATTR static uint8_t r_bssid[6];
RTC_DATA_ATTR static uint8_t r_channel = 0;

RTC_DATA_ATTR static uint32_t r_liveUntil = 0;   // UTC epoch
RTC_DATA_ATTR static uint16_t r_liveIntervalS = 0;

static unsigned long s_lastWifiTry = 0, s_lastMqttTry = 0, s_lastNtp = 0;
static volatile bool s_echoSeen = false;
static char s_echoNonce[12];

int cloudLastState() { return s_lastState; }

// ── credentials ────────────────────────────────────────────────────────────

bool cloudLoadCredentials() {
  Preferences p;
  p.begin("wifi", true);
  bool prov = p.isKey("provisioned") && p.getBool("provisioned", false);
  String ssid = p.isKey("ssid") ? p.getString("ssid", "") : "";
  String pass = p.isKey("pass") ? p.getString("pass", "") : "";
  p.end();

  p.begin("cloud", true);
  String host = p.isKey("mqtt_host") ? p.getString("mqtt_host", "") : "";
  s_port      = p.isKey("mqtt_port") ? p.getInt("mqtt_port", 8883) : 8883;
  String user = p.isKey("mqtt_user") ? p.getString("mqtt_user", "") : "";
  String mp   = p.isKey("mqtt_pass") ? p.getString("mqtt_pass", "") : "";
  p.end();

  strlcpy(s_ssid, ssid.c_str(), sizeof(s_ssid));
  strlcpy(s_pass, pass.c_str(), sizeof(s_pass));
  strlcpy(s_host, host.c_str(), sizeof(s_host));
  strlcpy(s_user, user.c_str(), sizeof(s_user));
  strlcpy(s_mqttPass, mp.c_str(), sizeof(s_mqttPass));
  if (s_port <= 0) s_port = 8883;

  snprintf(t_data,      sizeof(t_data),      "sensors/%s/data",         g_macStr);
  snprintf(t_status,    sizeof(t_status),    "sensors/%s/status",       g_macStr);
  snprintf(t_otaCmd,    sizeof(t_otaCmd),    "sensors/%s/ota/command",  g_macStr);
  snprintf(t_otaStatus, sizeof(t_otaStatus), "sensors/%s/ota/status",   g_macStr);
  snprintf(t_cfgSet,    sizeof(t_cfgSet),    "sensors/%s/config/set",   g_macStr);
  snprintf(t_cfgState,  sizeof(t_cfgState),  "sensors/%s/config/state", g_macStr);
  snprintf(t_liveReq,   sizeof(t_liveReq),   "sensors/%s/live/request", g_macStr);
  snprintf(t_liveState, sizeof(t_liveState), "sensors/%s/live/state",   g_macStr);
  snprintf(t_echo,      sizeof(t_echo),      "sensors/%s/wifi/echo",    g_macStr);

  return prov && s_ssid[0] && s_host[0] && s_user[0];
}

// ── WiFi ───────────────────────────────────────────────────────────────────

bool wifiUp() { return WiFi.status() == WL_CONNECTED; }
int8_t wifiRssi() { return wifiUp() ? (int8_t)WiFi.RSSI() : 0; }

bool wifiConnect(uint32_t timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  unsigned long start = millis();

  if (r_channel) {
    WiFi.begin(s_ssid, s_pass, r_channel, r_bssid);
    while (!wifiUp() && millis() - start < timeoutMs / 2) delay(20);
    if (!wifiUp()) {
      // The AP moved channel or was replaced. Forget it and scan.
      r_channel = 0;
      WiFi.disconnect();
    }
  }
  if (!wifiUp()) {
    WiFi.begin(s_ssid, s_pass);
    while (!wifiUp() && millis() - start < timeoutMs) delay(50);
  }
  if (!wifiUp()) {
    Serial.printf("[WiFi] Could not join \"%s\" in %lu ms\n", s_ssid, millis() - start);
    return false;
  }
  r_channel = WiFi.channel();
  memcpy(r_bssid, WiFi.BSSID(), 6);
  Serial.printf("[WiFi] Joined in %lu ms, ch %u, RSSI %d, IP %s\n", millis() - start,
                r_channel, WiFi.RSSI(), WiFi.localIP().toString().c_str());
  return true;
}

void wifiMaintain() {
  if (wifiUp()) return;
  if (s_lastWifiTry && millis() - s_lastWifiTry < WIFI_RECONNECT_MS) return;
  s_lastWifiTry = millis();
  Serial.println("[WiFi] Reconnecting...");
  WiFi.disconnect();
  WiFi.begin(s_ssid, s_pass);
}

// ── time ───────────────────────────────────────────────────────────────────

bool timeValid() { return time(nullptr) > 1700000000; }

void ntpStart() {
  configTime(0, 0, NTP_SERVER);
}

bool ntpWait(uint32_t timeoutMs) {
  unsigned long start = millis();
  while (sntp_get_sync_status() != SNTP_SYNC_STATUS_COMPLETED && millis() - start < timeoutMs) {
    delay(20);
  }
  bool ok = sntp_get_sync_status() == SNTP_SYNC_STATUS_COMPLETED;
  if (ok) s_lastNtp = millis();
  Serial.printf("[NTP] %s\n", ok ? "synced" : (timeValid() ? "no reply, keeping RTC time" : "no reply, clock not set"));
  return ok;
}

void ntpMaintain() {
  if (!wifiUp()) return;
  if (s_lastNtp && millis() - s_lastNtp < NTP_RESYNC_MS) return;
  s_lastNtp = millis();   // SNTP runs in the background from here
  ntpStart();
}

static void isoTime(uint32_t ts, char* out, size_t n) {
  time_t t = ts;
  struct tm tmv;
  gmtime_r(&t, &tmv);
  strftime(out, n, "%Y-%m-%dT%H:%M:%SZ", &tmv);
}

// ── live mode ──────────────────────────────────────────────────────────────

uint16_t effectiveIntervalS() {
  if (r_liveUntil && timeValid()) {
    if ((uint32_t)time(nullptr) < r_liveUntil) return r_liveIntervalS;
    r_liveUntil = 0;   // a session that is never stopped still ends
  }
  return settings().intervalS;
}

static void publishLiveState(bool started, uint16_t dur, uint16_t iv) {
  char p[160];
  snprintf(p, sizeof(p),
           "{\"sensor_mac\":\"%s\",\"state\":\"%s\",\"duration_s\":%u,\"interval_s\":%u}",
           g_macStr, started ? "started" : "stopped", dur, iv);
  s_mqtt.publish(t_liveState, p);
}

// ── config ─────────────────────────────────────────────────────────────────

static void publishConfigState(uint16_t desired, const char* err) {
  const Settings& s = settings();
  char p[300];
  int n = snprintf(p, sizeof(p),
    "{\"sensor_mac\":\"%s\",\"applied_cfg_ver\":%u,\"desired_cfg_ver\":%u,\"pending\":%s,"
    "\"sleep_secs\":%u,\"sh_a\":%.6e,\"sh_b\":%.6e,\"sh_c\":%.6e,\"r_series\":%.1f",
    g_macStr, s.cfgVer, desired, s.cfgVer == desired ? "false" : "true",
    s.intervalS, s.shA, s.shB, s.shC, s.rSeries);
  if (err) n += snprintf(p + n, sizeof(p) - n, ",\"error\":\"%s\"", err);
  snprintf(p + n, sizeof(p) - n, "}");
  s_mqtt.publish(t_cfgState, p);
}

static void handleConfig(const String& json) {
  if (json.indexOf('{') < 0) return;   // retained clear
  if (!jsonGetStr(json, "sensor_mac").equalsIgnoreCase(g_macStr)) return;

  Settings n;
  long ver  = jsonGetInt(json, "cfg_ver");
  long secs = jsonGetInt(json, "sleep_secs");
  n.cfgVer    = (ver > 0 && ver <= 0xFFFF) ? (uint16_t)ver : 0;
  n.intervalS = (secs > 0 && secs <= 0xFFFF) ? (uint16_t)secs : 0;
  n.shA       = jsonGetFloat(json, "sh_a");
  n.shB       = jsonGetFloat(json, "sh_b");
  n.shC       = jsonGetFloat(json, "sh_c");
  n.rSeries   = jsonGetFloat(json, "r_series");

  if (n.cfgVer && n.cfgVer == settings().cfgVer) {
    publishConfigState(n.cfgVer, nullptr);   // already running it
    return;
  }
  const char* err = settingsApply(n);
  if (err) Serial.printf("[CFG] Rejected v%u: %s\n", n.cfgVer, err);
  // A rejection keeps the old cfg_ver, so the cloud sees it as still pending;
  // the reason rides along for anyone looking at the payload.
  publishConfigState(n.cfgVer, err);
}

// ── MQTT ───────────────────────────────────────────────────────────────────

static void onMessage(char* topic, byte* payload, unsigned int len) {
  String json((const char*)payload, len);

  if (strcmp(topic, t_echo) == 0) {
    if (json == s_echoNonce) s_echoSeen = true;
    return;
  }
  if (strcmp(topic, t_cfgSet) == 0) { handleConfig(json); return; }
  if (strcmp(topic, t_otaCmd) == 0) { otaHandleCommand(json, mainsPresent()); return; }
  if (strcmp(topic, t_liveReq) == 0) {
    if (json.indexOf('{') < 0) return;
    if (!jsonGetStr(json, "sensor_mac").equalsIgnoreCase(g_macStr)) return;
    long dur = jsonGetInt(json, "duration_s"), iv = jsonGetInt(json, "interval_s");
    if (dur == 0) {
      r_liveUntil = 0;
      publishLiveState(false, 0, 0);
      return;
    }
    if (dur < 0 || iv <= 0 || !timeValid()) return;
    if (dur > LIVE_MAX_DURATION_S) dur = LIVE_MAX_DURATION_S;
    if (iv < LIVE_MIN_INTERVAL_S)  iv  = LIVE_MIN_INTERVAL_S;
    r_liveIntervalS = (uint16_t)iv;
    r_liveUntil     = (uint32_t)time(nullptr) + (uint32_t)dur;
    Serial.printf("[LIVE] Every %ld s for %ld s\n", iv, dur);
    publishLiveState(true, (uint16_t)dur, (uint16_t)iv);
  }
}

bool cloudConnected() { return s_mqtt.connected(); }
void cloudLoop() { if (s_mqtt.connected()) s_mqtt.loop(); }

void cloudPublishStatus(const Reading& r, bool online, uint16_t nextS) {
  if (!s_mqtt.connected()) return;
  char p[320];
  snprintf(p, sizeof(p),
    "{\"online\":%s,\"kind\":\"" DEVICE_KIND "\",\"ip\":\"%s\",\"fw\":\"" FW_VERSION "\","
    "\"img_state\":\"%s\",\"power\":\"%s\",\"charging\":%s,\"bat_v\":%.2f,"
    "\"backlog\":%lu,\"next_s\":%u}",
    online ? "true" : "false", WiFi.localIP().toString().c_str(), otaBootStateName(),
    r.onMains ? "mains" : "battery", r.charging ? "true" : "false", r.batV,
    (unsigned long)logPending(), nextS);
  s_mqtt.publish(t_status, p, /*retain=*/true);
}

void cloudPublishOtaStatus(const char* state, const char* ver, int pct, const char* err) {
  if (!s_mqtt.connected()) return;
  char p[224];
  if (err && *err) {
    snprintf(p, sizeof(p), "{\"state\":\"%s\",\"version\":\"%s\",\"pct\":%d,\"error\":\"%s\",\"fw\":\"" FW_VERSION "\"}",
             state, ver, pct, err);
  } else {
    snprintf(p, sizeof(p), "{\"state\":\"%s\",\"version\":\"%s\",\"pct\":%d,\"fw\":\"" FW_VERSION "\"}",
             state, ver, pct);
  }
  s_mqtt.publish(t_otaStatus, p);
  s_mqtt.loop();
}

bool cloudConnect(const Reading& r) {
#ifdef OTA_ROLLBACK_TEST
  // Built to fail: never reaches the cloud, so it can never confirm itself.
  Serial.println("[MQTT] ROLLBACK TEST build — refusing to connect");
  s_lastState = -2;
  return false;
#endif
  if (!wifiUp()) return false;

  s_tls.stop();
  // Encrypted, but the broker certificate is not validated — same as the hub.
  s_tls.setInsecure();
  s_tls.setHandshakeTimeout(15);
  s_mqtt.setServer(s_host, s_port);
  s_mqtt.setCallback(onMessage);
  s_mqtt.setBufferSize(1024);
  s_mqtt.setKeepAlive(30);
  s_mqtt.setSocketTimeout(10);

  uint8_t mac[6];
  WiFi.macAddress(mac);
  char clientId[24];
  snprintf(clientId, sizeof(clientId), "TempWifi-%02X%02X%02X", mac[3], mac[4], mac[5]);

  unsigned long t0 = millis();
  if (!s_mqtt.connect(clientId, s_user, s_mqttPass, t_status, 0, true, "{\"online\":false}")) {
    s_lastState = s_mqtt.state();
    Serial.printf("[MQTT] Connect failed (state %d)\n", s_lastState);
    return false;
  }
  s_lastState = 0;
  s_mqtt.setSocketTimeout(3);
  Serial.printf("[MQTT] Connected in %lu ms\n", millis() - t0);

  s_mqtt.subscribe(t_echo);
  s_mqtt.subscribe(t_cfgSet);
  s_mqtt.subscribe(t_otaCmd);
  s_mqtt.subscribe(t_liveReq);
  cloudPublishStatus(r, true, effectiveIntervalS());
  return true;
}

void cloudMaintain(const Reading& last) {
  if (!wifiUp()) return;
  if (s_mqtt.connected()) { s_mqtt.loop(); return; }
  if (s_lastMqttTry && millis() - s_lastMqttTry < MQTT_RECONNECT_MS) return;
  s_lastMqttTry = millis();
  cloudConnect(last);
}

void cloudDisconnect() {
  if (s_mqtt.connected()) {
    s_mqtt.loop();
    s_mqtt.disconnect();   // clean: the broker does not publish the LWT
  }
  s_tls.stop();
}

// Prove that everything published so far reached the broker. MQTT keeps order
// on one connection, so our own echo coming back means every earlier publish
// was accepted ahead of it.
static bool echoBarrier() {
  snprintf(s_echoNonce, sizeof(s_echoNonce), "%08lx", (unsigned long)esp_random());
  s_echoSeen = false;
  if (!s_mqtt.publish(t_echo, s_echoNonce)) return false;
  unsigned long start = millis();
  while (!s_echoSeen && s_mqtt.connected() && millis() - start < ECHO_TIMEOUT_MS) {
    s_mqtt.loop();
    delay(5);
  }
  return s_echoSeen;
}

static bool publishRecord(const LogRec& rec) {
  const Settings& s = settings();
  char ts[24] = "";
  if (rec.ts > 1700000000UL) {
    char iso[21];
    isoTime(rec.ts, iso, sizeof(iso));
    snprintf(ts, sizeof(ts), ",\"ts\":\"%s\"", iso);
  }
  // A record taken before the clock was ever set has no usable time; sent
  // without ts, the backend stamps it on arrival.
  char rssi[16] = "";
  if (rec.rssi) snprintf(rssi, sizeof(rssi), ",\"rssi\":%d", rec.rssi);

  float temp = rec.tempC100 == LOG_TEMP_ERROR ? -999.0f : rec.tempC100 / 100.0f;
  char p[320];
  snprintf(p, sizeof(p),
    "{\"sensor_mac\":\"%s\",\"temp\":%.2f,\"hum\":-999,\"battery\":%u%s%s,"
    "\"fw\":\"" FW_VERSION "\",\"cfg_ver\":%u,\"power\":\"%s\",\"bat_v\":%.2f,\"seq\":%lu}",
    g_macStr, temp, rec.batPct, rssi, ts, s.cfgVer,
    (rec.flags & LOGF_BATTERY) ? "battery" : "mains", rec.batMv / 1000.0f,
    (unsigned long)rec.seq);
  return s_mqtt.publish(t_data, p);
}

int cloudDrainLog() {
  if (!s_mqtt.connected()) return -1;
  int total = 0;
  static LogRec batch[UPLOAD_BATCH];
  while (logPending() > 0) {
    int n = logPeek(batch, UPLOAD_BATCH);
    if (n == 0) break;
    for (int i = 0; i < n; i++) {
      if (!publishRecord(batch[i])) {
        Serial.println("[UP] Publish failed");
        return total ? total : -1;
      }
      s_mqtt.loop();
    }
    if (!echoBarrier()) {
      Serial.println("[UP] Broker did not confirm the batch — will resend");
      return total ? total : -1;
    }
    logMarkUploaded(n);
    total += n;
  }
  if (total > 0) {
    Serial.printf("[UP] Delivered %d reading(s)\n", total);
    otaConfirm();
  }
  return total;
}
