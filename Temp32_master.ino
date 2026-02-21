#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <WiFiManager.h>
#include <WebServer.h>
#include <Preferences.h>
#include "time.h"

// --- XIAO ESP32-C6 PIN DEFINITIONS ---
#define TRIGGER_PIN 9   // BOOT button on XIAO ESP32-C6
#define LED_PIN 15      // Built-in LED on XIAO ESP32-C6

// --- MESSAGE TYPES ---
#define MSG_PAIRING 1
#define MSG_DATA    2

// --- ESP-NOW ENCRYPTION ---
// IMPORTANT: These keys must be identical on all devices (master + all slaves)
// Change both bytes below to your own secret values before deploying
static const uint8_t PMK_KEY[16] = {
  0x4A, 0x2F, 0x8C, 0x1E, 0x7B, 0x3D, 0x9A, 0x5F,
  0x6E, 0x2C, 0x4B, 0x8D, 0x1A, 0x7F, 0x3E, 0x9C
};
static const uint8_t LMK_KEY[16] = {
  0xE3, 0x4A, 0x7C, 0x91, 0xB5, 0x2D, 0xF8, 0x6E,
  0x1A, 0x9F, 0x3C, 0x72, 0xD4, 0x5B, 0x8E, 0x20
};

// --- NTP CONFIGURATION ---
const char* ntpServer = "pool.ntp.org";
const long  gmtOffset_sec = 7200;
const int   daylightOffset_sec = 3600;

// --- TIME SYNC MANAGEMENT ---
bool timeConfigured = false;
unsigned long lastNtpSync = 0;
const unsigned long NTP_SYNC_INTERVAL = 86400000;

// --- MESSAGE STRUCTURE ---
// IMPORTANT: must be byte-for-byte identical on master and all slaves
typedef struct struct_message {
  uint8_t  msgType;
  float    temp;
  float    hum;
  uint8_t  battery;   // 0–100 %; 255 = read error
  uint32_t age_s;     // seconds since measurement; 0 = current reading
} struct_message;

struct_message incomingData;
volatile int incomingRSSI = 0;

// --- SENSOR DATA STORAGE ---
#define MAX_SENSORS 10

struct SensorData {
  uint8_t mac[6];
  float temp;
  float hum;
  int rssi;
  unsigned long lastUpdate;    // millis() adjusted to actual measurement time
  unsigned long lastReceived;  // millis() when the packet arrived; drives active/offline
  bool active;
  char name[20];
  uint8_t battery;   // 0–100 %; 255 = read error
};

SensorData sensors[MAX_SENSORS];
int sensorCount = 0;

// --- WEB SERVER ---
WebServer server(80);

// --- NVS STORAGE ---
Preferences prefs;

// --- FUNCTIONS ---

void printCurrentTime() {
  struct tm timeinfo;
  if(!getLocalTime(&timeinfo)){
    Serial.println("Failed to obtain time");
    return;
  }
  Serial.println(&timeinfo, "%d/%m/%y - %H:%M:%S");
}

void resyncNTP() {
  if (millis() - lastNtpSync > NTP_SYNC_INTERVAL) {
    Serial.println("Resyncing NTP...");
    configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
    lastNtpSync = millis();
    
    struct tm timeinfo;
    if(getLocalTime(&timeinfo)) {
      Serial.println("NTP resync successful!");
    }
  }
}

int findSensor(const uint8_t *mac) {
  for(int i = 0; i < sensorCount; i++) {
    if(memcmp(sensors[i].mac, mac, 6) == 0) {
      return i;
    }
  }
  return -1;
}

int addSensor(const uint8_t *mac) {
  if(sensorCount >= MAX_SENSORS) {
    Serial.println("WARNING: Max sensors reached!");
    return -1;
  }
  
  memcpy(sensors[sensorCount].mac, mac, 6);
  sensors[sensorCount].active       = true;
  sensors[sensorCount].temp         = 0;
  sensors[sensorCount].hum          = 0;
  sensors[sensorCount].rssi         = 0;
  sensors[sensorCount].battery      = 0;
  sensors[sensorCount].lastUpdate   = millis();
  sensors[sensorCount].lastReceived = millis();
  
  sprintf(sensors[sensorCount].name, "Sensor-%02X%02X", mac[4], mac[5]);
  
  sensorCount++;
  Serial.printf("Sensor added. Total: %d\n", sensorCount);

  // Persist MAC so the peer can be re-registered after master reboot
  char key[8];
  snprintf(key, sizeof(key), "mac%d", sensorCount - 1);
  prefs.begin("sensors", false);
  prefs.putBytes(key, mac, 6);
  prefs.putInt("count", sensorCount);
  prefs.end();

  return sensorCount - 1;
}

void updateSensor(int index, float temp, float hum, int rssi, uint8_t battery, uint32_t age_s) {
  if(index < 0 || index >= sensorCount) return;

  sensors[index].temp         = temp;
  sensors[index].hum          = hum;
  sensors[index].rssi         = rssi;
  sensors[index].battery      = battery;
  sensors[index].lastReceived = millis();
  sensors[index].active       = true;

  // Shift lastUpdate back so "X minutes ago" reflects actual measurement time
  unsigned long ago = (unsigned long)age_s * 1000UL;
  sensors[index].lastUpdate = (ago < millis()) ? (millis() - ago) : 0;
}

void checkInactiveSensors() {
  unsigned long now = millis();
  for(int i = 0; i < sensorCount; i++) {
    if(now - sensors[i].lastReceived > 600000) {
      sensors[i].active = false;
    }
  }
}

// --- RESTORE PAIRED SENSORS FROM NVS ---
// Called once in setup() after esp_now_init(). Registers each saved MAC as an
// encrypted peer so that the master can decrypt data frames immediately after
// reboot without requiring the slaves to re-pair.
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
    sensors[sensorCount].active       = false;  // no data yet
    sensors[sensorCount].temp         = 0;
    sensors[sensorCount].hum          = 0;
    sensors[sensorCount].rssi         = 0;
    sensors[sensorCount].battery      = 0;
    sensors[sensorCount].lastUpdate   = 0;
    sensors[sensorCount].lastReceived = 0;
    sprintf(sensors[sensorCount].name, "Sensor-%02X%02X", mac[4], mac[5]);
    sensorCount++;

    // Register as encrypted peer so incoming data frames can be decrypted
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

// --- WEB PAGE HTML ---
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
  html += ".temp { color: #e74c3c; }";
  html += ".hum { color: #3498db; }";
  html += ".rssi { color: #27ae60; }";
  html += ".battery { color: #f39c12; }";
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
  html += "</style>";
  html += "<script>";
  html += "setTimeout(function(){ location.reload(); }, 10000);";
  html += "</script>";
  html += "</head><body>";
  
  html += "<div class='container'>";
  html += "<h1>🌡️ XIAO ESP32-C6 Temperature Monitor</h1>";
  html += "<div class='hardware-info'>Using SHT40 High-Precision Sensors (±0.2°C accuracy)</div>";
  
  if(sensorCount == 0) {
    html += "<div class='sensor-card'>";
    html += "<p>No sensors paired yet. Waiting for sensor data...</p>";
    html += "</div>";
  } else {
    checkInactiveSensors();
    
    for(int i = 0; i < sensorCount; i++) {
      html += "<div class='sensor-card";
      if(!sensors[i].active) html += " inactive";
      html += "'>";
      
      html += "<div class='sensor-header'>";
      html += "<div>";
      html += "<div class='sensor-name'>" + String(sensors[i].name) + "</div>";
      html += "<div class='sensor-mac'>MAC: ";
      for(int j = 0; j < 6; j++) {
        char buf[3];
        sprintf(buf, "%02X", sensors[i].mac[j]);
        html += String(buf);
        if(j < 5) html += ":";
      }
      html += "</div></div>";
      
      html += "<span class='status ";
      html += sensors[i].active ? "active'>ACTIVE" : "inactive'>OFFLINE";
      html += "</span>";
      html += "</div>";
      
      html += "<div class='sensor-data'>";
      
      html += "<div class='data-item'>";
      html += "<div class='data-label'>Temperature</div>";
      html += "<div class='data-value temp'>";
      if(sensors[i].temp == -999) {
        html += "ERR";
      } else {
        html += String(sensors[i].temp, 2);  // 2 decimals for SHT40 precision
        html += "<span class='data-unit'>°C</span>";
      }
      html += "</div></div>";
      
      html += "<div class='data-item'>";
      html += "<div class='data-label'>Humidity</div>";
      html += "<div class='data-value hum'>";
      if(sensors[i].hum == -999) {
        html += "ERR";
      } else {
        html += String(sensors[i].hum, 2);  // 2 decimals for SHT40 precision
        html += "<span class='data-unit'>%</span>";
      }
      html += "</div></div>";
      
      html += "<div class='data-item'>";
      html += "<div class='data-label'>Signal Strength</div>";
      html += "<div class='data-value rssi'>" + String(sensors[i].rssi);
      html += "<span class='data-unit'>dBm</span>";
      html += "</div></div>";

      html += "<div class='data-item'>";
      html += "<div class='data-label'>Battery</div>";
      html += "<div class='data-value battery'>";
      if(sensors[i].battery == 255) {
        html += "ERR";
      } else {
        html += String(sensors[i].battery);
        html += "<span class='data-unit'>%</span>";
      }
      html += "</div>";
      {
        String fillClass = "battery-bar-fill";
        if(sensors[i].battery != 255) {
          if(sensors[i].battery < 20)      fillClass += " low";
          else if(sensors[i].battery < 50) fillClass += " mid";
        }
        html += "<div class='battery-bar-bg'><div class='" + fillClass + "' style='width:";
        html += (sensors[i].battery == 255 ? "0" : String(sensors[i].battery));
        html += "%'></div></div>";
      }
      html += "</div>";

      html += "</div>";
      
      unsigned long secAgo = (millis() - sensors[i].lastUpdate) / 1000;
      html += "<div class='last-update'>Last update: ";
      if(secAgo < 60) {
        html += String(secAgo) + " seconds ago";
      } else if(secAgo < 3600) {
        html += String(secAgo / 60) + " minutes ago";
      } else {
        html += String(secAgo / 3600) + " hours ago";
      }
      html += "</div>";
      
      html += "</div>";
    }
  }
  
  html += "<div class='refresh-info'>📡 Page auto-refreshes every 10 seconds</div>";
  html += "</div></body></html>";
  
  server.send(200, "text/html", html);
}

void handleJSON() {
  String json = "{\"sensors\":[";
  
  checkInactiveSensors();
  
  for(int i = 0; i < sensorCount; i++) {
    if(i > 0) json += ",";
    
    json += "{";
    json += "\"name\":\"" + String(sensors[i].name) + "\",";
    json += "\"mac\":\"";
    for(int j = 0; j < 6; j++) {
      char buf[3];
      sprintf(buf, "%02X", sensors[i].mac[j]);
      json += String(buf);
      if(j < 5) json += ":";
    }
    json += "\",";
    json += "\"temp\":" + String(sensors[i].temp, 2) + ",";
    json += "\"hum\":" + String(sensors[i].hum, 2) + ",";
    json += "\"rssi\":" + String(sensors[i].rssi) + ",";
    json += "\"battery\":" + String(sensors[i].battery) + ",";
    json += "\"active\":" + String(sensors[i].active ? "true" : "false") + ",";
    json += "\"lastUpdate\":" + String((millis() - sensors[i].lastUpdate) / 1000);
    json += "}";
  }
  
  json += "],\"count\":" + String(sensorCount) + "}";
  
  server.send(200, "application/json", json);
}

// --- ESP-NOW CALLBACK ---
void OnDataRecv(const esp_now_recv_info_t * esp_now_info, const uint8_t *incomingDataBytes, int len) {
  memcpy(&incomingData, incomingDataBytes, sizeof(incomingData));
  incomingRSSI = esp_now_info->rx_ctrl->rssi;
  
  if (incomingData.msgType == MSG_PAIRING) {
    Serial.printf("Pairing Request from: %02X:%02X:%02X:%02X:%02X:%02X\n",
                  esp_now_info->src_addr[0], esp_now_info->src_addr[1], 
                  esp_now_info->src_addr[2], esp_now_info->src_addr[3], 
                  esp_now_info->src_addr[4], esp_now_info->src_addr[5]);

    esp_now_peer_info_t tempPeerInfo = {};
    memcpy(tempPeerInfo.peer_addr, esp_now_info->src_addr, 6);
    tempPeerInfo.channel = 0;
    tempPeerInfo.encrypt = false;
    
    if (!esp_now_is_peer_exist(esp_now_info->src_addr)) {
      esp_err_t addStatus = esp_now_add_peer(&tempPeerInfo);
      if (addStatus != ESP_OK) {
        Serial.printf("Failed to add peer: %d\n", addStatus);
        return;
      }
    } else {
      // Peer exists from a previous session (likely registered as encrypted).
      // Downgrade to unencrypted so the pairing reply is sent in plaintext —
      // the slave has no peer registered for us yet and cannot decrypt it.
      esp_now_mod_peer(&tempPeerInfo);
    }

    struct_message reply = {.msgType = MSG_PAIRING, .temp = 0, .hum = 0, .battery = 0};
    esp_err_t result = esp_now_send(esp_now_info->src_addr, (uint8_t *)&reply, sizeof(reply));
    
    if (result == ESP_OK) {
      Serial.println("✓ Pairing confirmation sent!");

      // Upgrade peer from unencrypted (pairing) to encrypted (data)
      esp_now_peer_info_t encPeer = {};
      memcpy(encPeer.peer_addr, esp_now_info->src_addr, 6);
      encPeer.channel = 0;
      encPeer.encrypt = true;
      memcpy(encPeer.lmk, LMK_KEY, 16);
      esp_now_mod_peer(&encPeer);

      int index = findSensor(esp_now_info->src_addr);
      if(index == -1) {
        addSensor(esp_now_info->src_addr);
      }

      // LED blink on pairing
      digitalWrite(LED_PIN, HIGH);
      delay(200);
      digitalWrite(LED_PIN, LOW);
    }
  }
  
  else if (incomingData.msgType == MSG_DATA) {
    Serial.print("DATA from: ");
    for(int i=0; i<5; i++) Serial.printf("%02X:", esp_now_info->src_addr[i]);
    Serial.printf("%02X", esp_now_info->src_addr[5]);
    
    if(incomingData.temp < -50 || incomingData.temp > 100 || 
       incomingData.hum < 0 || incomingData.hum > 100) {
      Serial.println(" | ERROR: Invalid sensor data!");
      return;
    }
    
    Serial.printf(" | Temp: %.2f°C", incomingData.temp);  // 2 decimals for SHT40
    Serial.printf(" | Hum: %.2f%%", incomingData.hum);
    Serial.printf(" | RSSI: %d dBm", incomingRSSI);
    Serial.printf(" | Bat: %d%%", incomingData.battery);
    if (incomingData.age_s > 0) {
      Serial.printf(" | REPLAYED (measured %lus ago)", (unsigned long)incomingData.age_s);
    }
    Serial.print(" | ");
    printCurrentTime();

    int index = findSensor(esp_now_info->src_addr);
    if(index == -1) {
      index = addSensor(esp_now_info->src_addr);
    }
    if(index != -1) {
      updateSensor(index, incomingData.temp, incomingData.hum, incomingRSSI,
                   incomingData.battery, incomingData.age_s);
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== XIAO ESP32-C6 Master Station ===");
  
  pinMode(TRIGGER_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  
  // --- WIFI MANAGER SETUP ---
  WiFiManager wm;
  wm.setDebugOutput(true);
  wm.setConfigPortalTimeout(180);
  
  Serial.println("Connecting to WiFi...");
  if(!wm.autoConnect("Temp-sensor-Master", "12345678")) {
    Serial.println("Failed to connect to WiFi");
    ESP.restart();
  } else {
    Serial.println("✓ Connected to WiFi!");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.println("\n🌐 OPEN YOUR BROWSER TO:");
    Serial.print("    http://");
    Serial.println(WiFi.localIP());
    Serial.println();
  }
  
  // --- NTP TIME SYNC ---
  Serial.print("Syncing time");
  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
  
  struct tm timeinfo;
  int attempts = 0;
  while(!getLocalTime(&timeinfo) && attempts < 20){
    Serial.print(".");
    delay(500);
    attempts++;
  }
  
  if(attempts < 20) {
    Serial.println("\n✓ Time synced!");
    printCurrentTime();
    timeConfigured = true;
    lastNtpSync = millis();
  } else {
    Serial.println("\n✗ Time sync failed, continuing anyway...");
  }
  
  // --- ESP-NOW SETUP ---
  WiFi.mode(WIFI_AP_STA);
  
  uint8_t currentChannel = WiFi.channel();
  Serial.printf("WiFi Channel: %d\n", currentChannel);
  
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | 
                        WIFI_PROTOCOL_11N | WIFI_PROTOCOL_LR);
  
  if (esp_now_init() != ESP_OK) {
    Serial.println("✗ ESP-NOW init failed!");
    return;
  }
  esp_now_set_pmk(PMK_KEY);
  Serial.println("✓ ESP-NOW initialized (encrypted)");

  loadPairedSensors();

  esp_now_register_recv_cb(OnDataRecv);
  
  // --- WEB SERVER SETUP ---
  server.on("/", handleRoot);
  server.on("/api/sensors", handleJSON);
  server.begin();
  Serial.println("✓ Web server started");
  
  Serial.println("\n=== Master Ready ===");
  Serial.println("Waiting for sensor data...\n");
}

void loop() {
  server.handleClient();
  
  if(timeConfigured) {
    resyncNTP();
  }
  
  if (digitalRead(TRIGGER_PIN) == LOW) {
    delay(50);
    unsigned long startPress = millis();
    
    Serial.println("Button pressed... (hold 3s to reset WiFi)");
    
    while(digitalRead(TRIGGER_PIN) == LOW) {
      if(millis() - startPress > 3000) {
        Serial.println("\n=== ERASING WIFI SETTINGS ===");
        WiFiManager wm;
        wm.resetSettings();
        delay(1000);
        Serial.println("Restarting...");
        ESP.restart();
      }
      delay(10);
    }
    Serial.println("Button released.");
  }
  
  delay(10);
}
