#include "measure.h"
#include "config.h"
#include "settings.h"

void measureInitPins() {
  // Both dividers are switched on their low side; Hi-Z means no current.
  pinMode(NTC_EN_PIN, INPUT);
  pinMode(BAT_DIV_EN_PIN, INPUT);
  // /PGOOD and /CHG are open drain with external 100k pull-ups.
  pinMode(PGOOD_PIN, INPUT);
  pinMode(CHG_PIN, INPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  analogReadResolution(12);
}

bool mainsPresent() { return digitalRead(PGOOD_PIN) == LOW; }
bool isCharging()   { return digitalRead(CHG_PIN) == LOW; }

static float averageMv(int pin, int samples) {
  analogReadMilliVolts(pin);      // discard the first conversion
  delay(5);
  long sum = 0;
  for (int i = 0; i < samples; i++) {
    sum += analogReadMilliVolts(pin);
    delay(5);
  }
  return sum / (float)samples;
}

// Coefficients can each be plausible and still be nonsense together. An NTC's
// resistance falls as temperature rises, so check the curve does that across
// the deployment range. Same check as sensor-ntc.
bool shCoefficientsSane(float a, float b, float c) {
  const float probes[3] = { 5000.0f, 20000.0f, 80000.0f };
  float prev = 999.0f;
  for (int i = 0; i < 3; i++) {
    float lnR = logf(probes[i]);
    float denom = a + b * lnR + c * lnR * lnR * lnR;
    if (denom <= 0.0f) return false;
    float t = 1.0f / denom - 273.15f;
    if (t < -60.0f || t > 100.0f) return false;
    if (t >= prev) return false;
    prev = t;
  }
  return true;
}

float readNtc() {
  pinMode(NTC_EN_PIN, OUTPUT);
  digitalWrite(NTC_EN_PIN, LOW);
  // 100 nF against at most ~10k (R_series || R_ntc): RC <= 1 ms. 60 ms is ample.
  delay(60);

  analogRead(NTC_ADC_PIN);
  analogSetPinAttenuation(NTC_ADC_PIN, ADC_11db);
  analogRead(NTC_ADC_PIN);
  float mv = averageMv(NTC_ADC_PIN, NTC_SAMPLES);

  pinMode(NTC_EN_PIN, INPUT);

  float v = mv / 1000.0f;
  if (v <= 0.01f || v >= NTC_VCC - 0.01f) {
    Serial.printf("[NTC] %.0f mV — probe open or shorted\n", mv);
    return TEMP_ERROR;
  }

  const Settings& s = settings();
  float r   = s.rSeries * (NTC_VCC - v) / v;   // NTC on the high side
  float lnR = logf(r);
  float t   = 1.0f / (s.shA + s.shB * lnR + s.shC * lnR * lnR * lnR) - 273.15f;
  Serial.printf("[NTC] adc=%.0f mV  R=%.0f ohm  T=%.2f C\n", mv, r, t);

  if (t < -55.0f || t > 125.0f) return TEMP_ERROR;
  return t;
}

float readBatteryV() {
  pinMode(BAT_DIV_EN_PIN, OUTPUT);
  digitalWrite(BAT_DIV_EN_PIN, LOW);
  delay(10);   // 10 nF against 50k: RC 0.5 ms

  analogRead(BAT_ADC_PIN);
  analogSetPinAttenuation(BAT_ADC_PIN, ADC_11db);
  analogRead(BAT_ADC_PIN);
  float mv = averageMv(BAT_ADC_PIN, 20);

  pinMode(BAT_DIV_EN_PIN, INPUT);
  return mv / 1000.0f * BAT_DIVIDER_RATIO;
}

// Resting Li-ion curve. While charging the terminal voltage reads high, so the
// percentage is optimistic on mains — it is a backup gauge, not a fuel gauge.
static const struct { float v; uint8_t pct; } LIION[] = {
  {4.20f, 100}, {4.10f, 90}, {4.00f, 80}, {3.90f, 65}, {3.80f, 50},
  {3.75f,  40}, {3.70f, 30}, {3.65f, 20}, {3.60f, 12}, {3.50f,  5},
  {3.40f,   2}, {3.30f,  0},
};

uint8_t batteryPct(float v) {
  if (v < BAT_ERROR_V) return 255;
  const int n = sizeof(LIION) / sizeof(LIION[0]);
  if (v >= LIION[0].v)     return 100;
  if (v <= LIION[n - 1].v) return 0;
  for (int i = 0; i < n - 1; i++) {
    if (v <= LIION[i].v && v > LIION[i + 1].v) {
      float f = (v - LIION[i + 1].v) / (LIION[i].v - LIION[i + 1].v);
      return LIION[i + 1].pct + (uint8_t)(f * (LIION[i].pct - LIION[i + 1].pct));
    }
  }
  return 0;
}

Reading takeReading() {
  Reading r;
  r.onMains  = mainsPresent();
  r.charging = r.onMains && isCharging();
  r.batV     = readBatteryV();
  r.batPct   = batteryPct(r.batV);
  r.temp     = readNtc();
  Serial.printf("[READ] T=%.2f  bat=%.3f V (%u%%)  %s%s\n", r.temp, r.batV, r.batPct,
                r.onMains ? "mains" : "battery", r.charging ? ", charging" : "");
  return r;
}
