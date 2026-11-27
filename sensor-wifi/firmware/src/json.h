#pragma once
// Minimal key extraction for the flat payloads the cloud sends. Same helpers
// as the hub: no escaped quotes inside values, which none of them contain.
#include <Arduino.h>
#include <math.h>

inline String jsonGetStr(const String& json, const char* key) {
  String search = String("\"") + key + "\":\"";
  int start = json.indexOf(search);
  if (start < 0) return "";
  start += search.length();
  int end = json.indexOf('"', start);
  return end < 0 ? "" : json.substring(start, end);
}

inline String jsonRawValue(const String& json, const char* key) {
  String search = String("\"") + key + "\":";
  int start = json.indexOf(search);
  if (start < 0) return "";
  start += search.length();
  int end = json.indexOf(',', start), end2 = json.indexOf('}', start);
  if (end < 0 || (end2 >= 0 && end2 < end)) end = end2;
  return end < 0 ? "" : json.substring(start, end);
}

inline float jsonGetFloat(const String& json, const char* key) {
  String v = jsonRawValue(json, key);
  return v.length() ? v.toFloat() : NAN;
}

inline long jsonGetInt(const String& json, const char* key, long dflt = -1) {
  String v = jsonRawValue(json, key);
  return v.length() ? v.toInt() : dflt;
}

inline String jsonEsc(const String& s) {
  String out;
  out.reserve(s.length() + 8);
  for (unsigned i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if ((uint8_t)c < 0x20) { char b[7]; snprintf(b, sizeof(b), "\\u%04x", (uint8_t)c); out += b; }
    else out += c;
  }
  return out;
}
