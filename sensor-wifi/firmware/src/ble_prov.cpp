#include "ble_prov.h"
#include "config.h"
#include "cloud.h"
#include "json.h"
#include "measure.h"
#include <NimBLEDevice.h>
#include <WiFi.h>
#include <Preferences.h>

static NimBLECharacteristic* s_status   = nullptr;
static NimBLECharacteristic* s_networks = nullptr;
static volatile bool s_scanReq  = false;
static volatile bool s_wifiReq  = false;
static volatile bool s_cloudReq = false;
static bool          s_wifiOk   = false;

static void notifyStatus(const char* state, const char* detail = "") {
  if (!s_status) return;
  String j = String("{\"state\":\"") + state + "\"";
  if (detail && *detail) j += String(",\"detail\":\"") + jsonEsc(detail) + "\"";
  j += "}";
  s_status->setValue(j.c_str());
  s_status->notify();
  Serial.printf("[BLE] Status: %s\n", j.c_str());
}

static void scanNetworks() {
  int n = WiFi.scanNetworks(false, false, false, 300);
  if (n < 0) { WiFi.scanDelete(); return; }
  // Strongest first, at most 10, trimmed to fit one 512-byte notification.
  int idx[10], count = min(n, 10);
  for (int i = 0; i < count; i++) idx[i] = i;
  for (int i = 1; i < count; i++) {
    int k = idx[i], j = i - 1;
    while (j >= 0 && WiFi.RSSI(idx[j]) < WiFi.RSSI(k)) { idx[j + 1] = idx[j]; j--; }
    idx[j + 1] = k;
  }
  String j;
  for (;;) {
    j = "{\"networks\":[";
    for (int i = 0; i < count; i++) {
      if (i) j += ",";
      j += "{\"ssid\":\"" + jsonEsc(WiFi.SSID(idx[i])) + "\",\"rssi\":" + WiFi.RSSI(idx[i]) +
           ",\"enc\":" + (int)WiFi.encryptionType(idx[i]) + "}";
    }
    j += "]}";
    if (j.length() <= 512 || count <= 1) break;
    count--;
  }
  WiFi.scanDelete();
  s_networks->setValue(j.c_str());
  s_networks->notify();
}

class ServerCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*, NimBLEConnInfo&) override {
    digitalWrite(LED_PIN, HIGH);
    s_wifiReq = s_cloudReq = s_scanReq = false;
    s_wifiOk = false;
    notifyStatus("idle");
  }
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) override {
    digitalWrite(LED_PIN, LOW);
    NimBLEDevice::startAdvertising();
  }
};

class WifiCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo&) override {
    String v = c->getValue().c_str();
    String ssid = jsonGetStr(v, "ssid"), pass = jsonGetStr(v, "pass");
    if (ssid.isEmpty()) { notifyStatus("failed", "SSID cannot be empty"); return; }
    Preferences p;
    p.begin("wifi", false);
    p.putString("ssid", ssid);
    p.putString("pass", pass);
    p.end();
    s_wifiReq = true;
    notifyStatus("connecting", "WiFi credentials received");
  }
};

class CloudCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo&) override {
    String v = c->getValue().c_str();
    String host = jsonGetStr(v, "host");
    if (host.isEmpty()) return;
    Preferences p;
    p.begin("cloud", false);
    p.putString("mqtt_host", host);
    p.putInt("mqtt_port", (int)jsonGetInt(v, "port", 8883));
    p.putString("mqtt_user", jsonGetStr(v, "user"));
    p.putString("mqtt_pass", jsonGetStr(v, "pass"));
    p.end();
    if (s_wifiOk) s_cloudReq = true;
  }
};

class ScanCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic*, NimBLEConnInfo&) override { s_scanReq = true; }
};

static void setProvisioned(bool v) {
  Preferences p;
  p.begin("wifi", false);
  p.putBool("provisioned", v);
  p.end();
}

// WiFi is up: prove the cloud credentials too before declaring success, so a
// half-provisioned device comes back here on the next boot instead of running
// with no way to reach it.
static void tryCloud() {
  // cloudLoadCredentials() reports "not provisioned" until the flag is set, so
  // check the cloud keys directly.
  Preferences p;
  p.begin("cloud", true);
  bool haveCloud = p.isKey("mqtt_host");
  p.end();
  if (!haveCloud) {
    notifyStatus("connecting", "WiFi OK — waiting for cloud credentials...");
    return;
  }
  cloudLoadCredentials();
  notifyStatus("connecting", "WiFi OK — connecting to cloud...");
  Reading r = {};
  r.onMains = mainsPresent();
  if (!cloudConnect(r)) {
    int st = cloudLastState();
    bool auth = (st == 4 || st == 5);
    if (auth) { Preferences c; c.begin("cloud", false); c.clear(); c.end(); }
    char msg[96];
    snprintf(msg, sizeof(msg), auth ? "Cloud auth failed (rc %d) — check MQTT username/password"
                                    : "Cloud unreachable (rc %d) — check host/port/network", st);
    notifyStatus("failed", msg);
    NimBLEDevice::startAdvertising();
    return;
  }
  cloudDisconnect();
  setProvisioned(true);
  notifyStatus("connected", "");
  delay(1200);
  ESP.restart();
}

void bleProvision() {
  Serial.println("\n=== BLE PROVISIONING ===");
  WiFi.mode(WIFI_STA);
  setProvisioned(false);

  uint8_t mac[6];
  WiFi.macAddress(mac);
  // "TempHub-" prefix: the app lists only names starting with it. The -W suffix
  // tells a person in the list which kind of device they are looking at.
  char name[24];
  snprintf(name, sizeof(name), "TempHub-%02X%02X%02X-W", mac[3], mac[4], mac[5]);

  NimBLEDevice::init(name);
  NimBLEDevice::setMTU(517);
  NimBLEDevice::setPower(3);
  NimBLEServer* srv = NimBLEDevice::createServer();
  srv->setCallbacks(new ServerCb());
  NimBLEService* svc = srv->createService(PROV_SERVICE_UUID);

  svc->createCharacteristic(PROV_CHAR_WIFI,  NIMBLE_PROPERTY::WRITE)->setCallbacks(new WifiCb());
  svc->createCharacteristic(PROV_CHAR_CLOUD, NIMBLE_PROPERTY::WRITE)->setCallbacks(new CloudCb());
  s_status = svc->createCharacteristic(PROV_CHAR_STATUS, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  s_status->setValue("{\"state\":\"idle\"}");
  s_networks = svc->createCharacteristic(PROV_CHAR_NETWORKS, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
  s_networks->setCallbacks(new ScanCb());
  // A String, not a fixed buffer: NimBLE would send the trailing garbage too.
  String info = String("{\"mac\":\"") + g_macStr + "\",\"kind\":\"" DEVICE_KIND "\"}";
  svc->createCharacteristic(PROV_CHAR_INFO, NIMBLE_PROPERTY::READ)->setValue(info.c_str());
  svc->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(PROV_SERVICE_UUID);
  NimBLEAdvertisementData rsp;
  rsp.setName(name);
  adv->setScanResponseData(rsp);
  NimBLEDevice::startAdvertising();
  Serial.printf("Advertising as %s\n", name);

  unsigned long blink = 0;
  for (;;) {
    if (s_scanReq) { s_scanReq = false; scanNetworks(); }

    if (s_wifiReq) {
      s_wifiReq = false;
      WiFi.disconnect(true);
      delay(100);
      Preferences p;
      p.begin("wifi", true);
      String ssid = p.getString("ssid", ""), pass = p.getString("pass", "");
      p.end();
      WiFi.begin(ssid.c_str(), pass.c_str());
      unsigned long t = millis();
      while (WiFi.status() != WL_CONNECTED && millis() - t < WIFI_CONNECT_TIMEOUT_MS) delay(200);
      if (WiFi.status() == WL_CONNECTED) {
        s_wifiOk = true;
        tryCloud();
      } else {
        WiFi.disconnect(true);
        Preferences w; w.begin("wifi", false); w.remove("ssid"); w.remove("pass"); w.end();
        notifyStatus("failed", "Wrong password or network unreachable");
        NimBLEDevice::startAdvertising();
      }
    }

    if (s_cloudReq && s_wifiOk) { s_cloudReq = false; tryCloud(); }

    // Slow blink: waiting to be provisioned.
    if (millis() - blink > 1000 && NimBLEDevice::getServer()->getConnectedCount() == 0) {
      blink = millis();
      digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    }
    delay(10);
  }
}
