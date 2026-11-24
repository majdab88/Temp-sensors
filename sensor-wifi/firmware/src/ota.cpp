#include "ota.h"
#include "config.h"
#include "cloud.h"
#include "json.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <esp_ota_ops.h>
#include <mbedtls/md.h>
#include <mbedtls/pk.h>
#include <mbedtls/base64.h>

// Public half of the fleet signing key (tools/firmware-signing). Same key as
// the hub and sensor-ntc; safe in git. If the private key is lost, nothing can
// be updated over the air again.
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

static bool  s_requested = false;
static bool  s_running   = false;
static char  s_url[192]  = "";
static char  s_ver[16]   = "";
static char  s_sha[65]   = "";
static char  s_sig[160]  = "";

static bool          s_unconfirmed = false;
static bool          s_settled     = false;
static unsigned long s_deadline    = 0;
static char          s_rejected[16] = "";
static char          s_bootState[16] = "unknown";

const char* otaBootStateName() { return s_bootState; }
bool otaPending() { return s_requested && !s_running; }

static void status(const char* state, int pct, const char* err) {
  cloudPublishOtaStatus(state, s_ver, pct, err);
}

void otaLoadState() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t st;
  const char* name = "unavailable";
  if (esp_ota_get_state_partition(running, &st) == ESP_OK) {
    switch (st) {
      case ESP_OTA_IMG_NEW:            name = "NEW";            break;
      case ESP_OTA_IMG_PENDING_VERIFY: name = "PENDING_VERIFY"; break;
      case ESP_OTA_IMG_VALID:          name = "VALID";          break;
      case ESP_OTA_IMG_INVALID:        name = "INVALID";        break;
      case ESP_OTA_IMG_ABORTED:        name = "ABORTED";        break;
      default:                         name = "UNDEFINED";      break;
    }
  }
  strlcpy(s_bootState, name, sizeof(s_bootState));

  Preferences p;
  p.begin("ota", true);
  s_unconfirmed = p.isKey("unconf") && p.getBool("unconf", false);
  if (p.isKey("rejected")) p.getString("rejected", s_rejected, sizeof(s_rejected));
  p.end();
  Serial.printf("[OTA] Running '%s' (%s)%s\n", running ? running->label : "?", name,
                s_unconfirmed ? " — UNCONFIRMED image" : "");
}

void otaBeginAttempt() {
  if (!s_unconfirmed) return;
  Preferences p;
  p.begin("ota", false);
  uint8_t tries = p.getUChar("tries", 0) + 1;
  Serial.printf("[OTA] Unconfirmed image, attempt %u of %u\n", tries, OTA_MAX_BOOT_TRIES);
  if (tries > OTA_MAX_BOOT_TRIES) {
    // Remember what we abandoned, or the retained command hands it straight back.
    p.putBool("unconf", false);
    p.putUChar("tries", 0);
    p.putString("rejected", FW_VERSION);
    p.end();
    const esp_partition_t* prev = esp_ota_get_next_update_partition(NULL);
    if (prev && esp_ota_set_boot_partition(prev) == ESP_OK) {
      Serial.printf("[OTA] Reverting to '%s'\n", prev->label);
    } else {
      Serial.println("[OTA] Revert failed — staying on this image");
    }
    delay(200);
    ESP.restart();
  }
  p.putUChar("tries", tries);
  p.end();
  s_deadline = millis() + OTA_VERIFY_WINDOW_MS;
}

bool otaWindowExpired() {
  return s_unconfirmed && s_deadline && (long)(millis() - s_deadline) > 0;
}

void otaConfirm() {
  if (s_settled) return;
  s_settled = true;
  if (s_unconfirmed) {
    s_unconfirmed = false;
    Preferences p;
    p.begin("ota", false);
    p.putBool("unconf", false);
    p.putUChar("tries", 0);
    p.end();
    Serial.println("[OTA] Image delivered a reading — rollback disarmed");
  }
  // A terminal state on every boot, so the dashboard never sticks on
  // "rebooting" (the hub learned this one).
  strlcpy(s_ver, FW_VERSION, sizeof(s_ver));
  status("confirmed", 100, nullptr);
}

void otaHandleCommand(const String& json, bool onMains) {
  // An empty retained payload is the cloud clearing a finished command.
  if (json.indexOf('{') < 0) return;

  String url = jsonGetStr(json, "url");
  String ver = jsonGetStr(json, "version");
  String sha = jsonGetStr(json, "sha256");
  String sig = jsonGetStr(json, "sig");
  strlcpy(s_ver, ver.c_str(), sizeof(s_ver));

  if (url.isEmpty() || sha.isEmpty() || sig.isEmpty()) {
    status("failed", 0, "incomplete command");
    return;
  }
  if (s_running || s_requested) return;
  if (ver == FW_VERSION) { status("uptodate", 100, nullptr); return; }
  if (s_unconfirmed) {
    // Installing over an unproven image would overwrite the slot we need to
    // roll back into.
    status("failed", 0, "previous update not yet confirmed");
    return;
  }
  if (s_rejected[0] && ver == s_rejected) {
    status("failed", 0, "version previously rolled back on this device");
    return;
  }
  if (!onMains) {
    // Not a failure: the command is retained and comes back on the next mains
    // connection. Reporting it would overwrite the dashboard's pending state.
    Serial.printf("[OTA] %s deferred — on battery\n", s_ver);
    return;
  }

  strlcpy(s_url, url.c_str(), sizeof(s_url));
  strlcpy(s_sha, sha.c_str(), sizeof(s_sha));
  strlcpy(s_sig, sig.c_str(), sizeof(s_sig));
  s_requested = true;

  if (s_rejected[0]) {
    s_rejected[0] = 0;
    Preferences p; p.begin("ota", false); p.remove("rejected"); p.end();
  }
  Serial.printf("[OTA] Queued %s\n", s_ver);
  status("accepted", 0, nullptr);
}

static bool hexToDigest(const char* hex, uint8_t* out) {
  if (strlen(hex) != 64) return false;
  auto nib = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  for (int i = 0; i < 32; i++) {
    int h = nib(hex[2 * i]), l = nib(hex[2 * i + 1]);
    if (h < 0 || l < 0) return false;
    out[i] = (uint8_t)((h << 4) | l);
  }
  return true;
}

static bool verifySignature(const uint8_t* digest) {
  uint8_t sig[128];
  size_t  sigLen = 0;
  if (mbedtls_base64_decode(sig, sizeof(sig), &sigLen,
                            (const unsigned char*)s_sig, strlen(s_sig)) != 0) return false;
  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  int rc = mbedtls_pk_parse_public_key(&pk, FW_PUBLIC_KEY, sizeof(FW_PUBLIC_KEY));
  if (rc == 0) rc = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, digest, 32, sig, sigLen);
  mbedtls_pk_free(&pk);
  return rc == 0;
}

// Streaming search for FW_TAG_PREFIX across chunk boundaries. The prefix has no
// repeated leading character, so on a mismatch restarting at 0 (or 1 if this
// byte begins the prefix) cannot skip a match.
struct TagScan {
  const char* pat = FW_TAG_PREFIX;
  size_t len = sizeof(FW_TAG_PREFIX) - 1, pos = 0;
  bool found = false;
  void feed(const uint8_t* b, size_t n) {
    for (size_t i = 0; i < n && !found; i++) {
      if (b[i] == (uint8_t)pat[pos]) { if (++pos == len) found = true; }
      else pos = (b[i] == (uint8_t)pat[0]) ? 1 : 0;
    }
  }
};

static void fail(const char* err, int pct) {
  Serial.printf("[OTA] Failed: %s\n", err);
  status("failed", pct, err);
  s_running = s_requested = false;
}

void otaRun() {
  if (!otaPending()) return;
  s_running = true;
  Serial.printf("[OTA] Updating to %s from %s\n", s_ver, s_url);

  uint8_t expected[32];
  if (!hexToDigest(s_sha, expected)) return fail("bad sha256 in command", 0);
  const esp_partition_t* target = esp_ota_get_next_update_partition(NULL);
  if (!target) return fail("no OTA partition", 0);

  // Plain HTTP by design: the signature authenticates the image, not the
  // transport, and a second TLS session would compete with MQTT for heap.
  WiFiClient net;
  HTTPClient http;
  http.setTimeout(OTA_HTTP_TIMEOUT_MS);
  http.setConnectTimeout(OTA_HTTP_TIMEOUT_MS);
  if (!http.begin(net, s_url)) return fail("bad url", 0);
  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    char e[24]; snprintf(e, sizeof(e), "http %d", code);
    http.end();
    return fail(e, 0);
  }
  int total = http.getSize();
  if (total <= 0)                       { http.end(); return fail("no content-length", 0); }
  if ((size_t)total > target->size)     { http.end(); return fail("image larger than partition", 0); }

  // Erases ~1 MB before returning; seconds, not milliseconds.
  esp_ota_handle_t h = 0;
  if (esp_ota_begin(target, total, &h) != ESP_OK) { http.end(); return fail("ota_begin failed", 0); }

  mbedtls_md_context_t md;
  mbedtls_md_init(&md);
  mbedtls_md_setup(&md, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
  mbedtls_md_starts(&md);
  TagScan tag;

  status("downloading", 0, nullptr);
  WiFiClient* stream = http.getStreamPtr();
  static uint8_t buf[OTA_BUF_SIZE];
  int written = 0, lastPct = 0;
  unsigned long lastData = millis();
  bool ok = true;
  while (written < total) {
    size_t avail = stream->available();
    if (!avail) {
      if (millis() - lastData > OTA_HTTP_TIMEOUT_MS) { ok = false; break; }
      delay(1);
      continue;
    }
    lastData = millis();
    int n = stream->readBytes(buf, avail > sizeof(buf) ? sizeof(buf) : avail);
    if (n <= 0) continue;
    if (esp_ota_write(h, buf, n) != ESP_OK) { ok = false; break; }
    mbedtls_md_update(&md, buf, n);
    tag.feed(buf, n);
    written += n;
    int pct = (int)((int64_t)written * 100 / total);
    if (pct >= lastPct + 10) {
      lastPct = pct;
      status("downloading", pct, nullptr);   // doubles as MQTT keepalive
      cloudLoop();
    }
  }
  http.end();
  uint8_t digest[32];
  mbedtls_md_finish(&md, digest);
  mbedtls_md_free(&md);

  if (!ok || written != total) { esp_ota_abort(h); return fail("download incomplete", lastPct); }
  status("verifying", 100, nullptr);
  if (memcmp(digest, expected, 32) != 0) { esp_ota_abort(h); return fail("sha256 mismatch", 100); }
  if (!verifySignature(digest))          { esp_ota_abort(h); return fail("signature invalid", 100); }
  // Signed by the fleet key is not the same as built for this board: hub and
  // sensor images carry the same signature scheme and would boot here.
  if (!tag.found)                        { esp_ota_abort(h); return fail("not a sensor-wifi image", 100); }
  if (esp_ota_end(h) != ESP_OK)          return fail("image rejected by esp_ota_end", 100);
  if (esp_ota_set_boot_partition(target) != ESP_OK) return fail("set_boot_partition failed", 100);

  Preferences p;
  p.begin("ota", false);
  p.putBool("unconf", true);
  p.putUChar("tries", 0);
  p.end();

  Serial.println("[OTA] Verified and staged — rebooting");
  status("rebooting", 100, nullptr);
  cloudLoop();
  delay(300);
  ESP.restart();
}
