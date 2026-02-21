/*
 * BattDebug.ino — Battery hardware debugging sketch
 * Target : XIAO ESP32-C6
 * Baud   : 115200
 *
 * No deep sleep / ESP-NOW / WiFi — pure ADC measurement loop.
 * Prints a full diagnostic table every 2 s so you can probe the board
 * with a multimeter while watching the serial output.
 *
 * ── Probe points ────────────────────────────────────────────────────
 *   TP4056 OUT+   expected: battery voltage (~4.2 V fully charged)
 *   GPIO2         expected: OUT+ ÷ 2 while divider is ON  (~2.1 V)
 *   GPIO4 (D2)    expected: 0 V while divider is ON
 *   3V3 pin       expected: ~3.30 V (ESP32 LDO output)
 *   GND           reference
 * ────────────────────────────────────────────────────────────────────
 *
 * Divider circuit:
 *   OUT+  ──R1(120k)──  GPIO2(ADC)  ──R2(120k)──  GPIO4/D2(GND switch)
 *
 * The sketch leaves the divider ON between printouts so you have a
 * full 2-second window to measure steady-state voltages.
 */

#define LED_PIN            15   // Built-in LED
#define BAT_ADC_PIN         2   // Divider midpoint
#define DIVIDER_ENABLE_PIN  4   // OUTPUT LOW → divider active
                                // INPUT Hi-Z  → divider off (zero current)

// ── helpers ──────────────────────────────────────────────────────────

// Take one reading at the requested attenuation and print it.
// Call only while divider is already ON and settled.
void printAtten(const char* label, adc_attenuation_t atten) {
  analogSetPinAttenuation(BAT_ADC_PIN, atten);
  analogRead(BAT_ADC_PIN);          // latch new attenuation; discard
  delay(5);

  int raw = analogRead(BAT_ADC_PIN);
  int mv  = analogReadMilliVolts(BAT_ADC_PIN);
  // bat_v = pin_mv * 2  (equal-resistor divider)
  Serial.printf("    %-22s raw=%4d  pin_mv=%4d  bat_v=%.3f V\n",
                label, raw, mv, mv * 2.0f / 1000.0f);
}

// ── setup ─────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  delay(500);   // C6 needs extra time for serial to stabilise

  pinMode(LED_PIN,            OUTPUT);
  pinMode(DIVIDER_ENABLE_PIN, INPUT);   // start Hi-Z (divider off)
  digitalWrite(LED_PIN, LOW);

  analogReadResolution(12);   // 12-bit (0–4095)

  Serial.println("\n╔══════════════════════════════════════════╗");
  Serial.println("║   Battery Debug Sketch — XIAO ESP32-C6  ║");
  Serial.println("╚══════════════════════════════════════════╝");
  Serial.println("Probe TP4056 OUT+, GPIO2, GPIO4 (D2), and 3V3 with multimeter.");
  Serial.println("Divider stays ON between prints — 2-second window to probe.");
  Serial.println();
}

// ── loop ──────────────────────────────────────────────────────────────

void loop() {
  Serial.println("──────────────────────────────────────────────────────");

  // ── 1. Divider OFF ────────────────────────────────────────────────
  //  GPIO3 is Hi-Z; R2 bottom is floating.
  //  GPIO2 should read near 0 V (pulled down through R1 to battery minus)
  //  or float — either way this confirms the divider is truly switching.
  pinMode(DIVIDER_ENABLE_PIN, INPUT);   // Hi-Z
  delay(10);

  // Initialise ADC channel then set 11 dB
  analogRead(BAT_ADC_PIN);
  analogSetPinAttenuation(BAT_ADC_PIN, ADC_11db);
  analogRead(BAT_ADC_PIN);
  delay(5);

  int raw_off = analogRead(BAT_ADC_PIN);
  int mv_off  = analogReadMilliVolts(BAT_ADC_PIN);
  Serial.printf("[Divider OFF]  GPIO4=Hi-Z   raw=%4d  pin_mv=%4d\n",
                raw_off, mv_off);
  Serial.println("  (GPIO2 should read ~0 V or float; bat_v meaningless here)");

  // ── 2. Divider ON ─────────────────────────────────────────────────
  pinMode(DIVIDER_ENABLE_PIN, OUTPUT);
  digitalWrite(DIVIDER_ENABLE_PIN, LOW);
  delay(20);   // let RC settle before first read

  Serial.println("[Divider ON ]  GPIO4=0 V");
  printAtten("0dB   (0 – 750 mV)", ADC_0db);
  printAtten("6dB   (0 – 1750 mV)", ADC_6db);
  printAtten("11dB  (0 – 3100 mV)", ADC_11db);

  // ── 3. Sanity summary ─────────────────────────────────────────────
  //  Re-read at 11 dB for the "headline" voltage
  analogSetPinAttenuation(BAT_ADC_PIN, ADC_11db);
  analogRead(BAT_ADC_PIN);
  delay(5);
  int mv11 = analogReadMilliVolts(BAT_ADC_PIN);
  float bat_v = mv11 * 2.0f / 1000.0f;

  Serial.println();
  Serial.printf("  >> Headline bat_v = %.3f V  (11dB reading × 2)\n", bat_v);

  if (bat_v < 0.1f) {
    Serial.println("  !! ~0 V: divider not reaching ADC. Check R1 / OUT+ connection.");
  } else if (bat_v < 2.5f) {
    Serial.println("  !! < 2.5 V: battery deeply discharged, protection IC may be tripped,");
    Serial.println("             or OUT+ is not connected to battery positive.");
  } else if (bat_v < 3.5f) {
    Serial.println("  !! Low battery (< 3.5 V).");
  } else if (bat_v <= 4.25f) {
    Serial.println("  OK Battery voltage in normal range.");
  } else {
    Serial.println("  !! > 4.25 V: check divider ratio — R1 and R2 may not be equal.");
  }

  // ── LED heartbeat ─────────────────────────────────────────────────
  // Divider stays ON here so you can probe for a full 2-second window.
  digitalWrite(LED_PIN, HIGH); delay(80); digitalWrite(LED_PIN, LOW);

  delay(2000);
}
