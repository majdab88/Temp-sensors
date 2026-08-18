# Remote Management Plan — Temp-sensors

Hub firmware OTA, and remote sensor configuration from the dashboard.

Status: **Phase 0 and Phase 1 implemented.** Version reporting is live; hub OTA
is built and builds clean, but has not yet been exercised against real hardware —
see the bench tests in §7 before trusting it on a hub you cannot reach.
Phase 2 (sensor config) is still a proposal.

---

## 0. Scope

| | **In scope now** | **Deferred** |
|---|---|---|
| Hub | Full firmware OTA from the cloud, unattended | — |
| Sensor | **Remote config: sleep interval + calibration**, superadmin only | Firmware OTA (Appendix A) |

Sensor firmware OTA is deferred, not cancelled. The reasoning is in Appendix A;
the short version is that sensor firmware is simple and stable, updates are
expected to be rare, and the relay/signing/registry machinery is a lot of surface
for a handful of uses. Remote configuration delivers most of the practical value
— fixing a calibration error or changing a reporting interval without touching
hardware — for a fraction of the work.

### The one thing to decide before Phase 0

**Both features need the same one-time physical flash of every sensor.**

`struct_message` must be byte-for-byte identical on hub and sensors (CLAUDE.md),
and deployed sensors have no handler for a config downlink. So remote config
cannot bootstrap itself any more than OTA can — every node must be flashed by
hand once, with the enclosure open and an ESP-PROG attached.

That makes the field round the expensive, non-repeatable part. And it means:

> If you flash every sensor to add config support and **do not** include the OTA
> receiver, then the next change to the config protocol — one more tunable, a bug
> in the handler, a wire-format fix — costs another full field round.

The marginal cost of including the OTA receiver *during that same round* is a few
hundred lines. The cost of adding it later is opening every enclosure again.

**Decided: option 2** — the sensor field round will carry both the config handler
and the OTA receiver, so the fleet never needs opening again.

The two options, for the record:

1. **Config only now.** Cheapest to build, and correct if you are confident the
   config protocol is right the first time and will not need to grow.
2. **Config + OTA receiver in the same flash.** More work now, but the field round
   never has to happen again — any future capability arrives over the air.

Option 2 is the recommendation, but it is your call, and the plan below works
either way. If you take option 1, design the config wire format with room to grow
(§3.2) so that at least *adding parameters* does not need new firmware.

---

## 1. Starting position (measured, not assumed)

**The deployed sensor fleet is a single hardware variant: `wroom_v2_sensor_ntc`.**
The XIAO envs are bench/prototype only.

| Device | Image size | Partition table in the shipped build | OTA slots? |
|--------|-----------|--------------------------------------|-----------|
| Hub (`xiao_esp32c6_hub`) | 1,585,514 B, 80.6% of slot | **now `min_spiffs.csv`** → `otadata, app0, app1, spiffs, coredump` (was `huge_app.csv`, single slot) | Yes, as of Phase 0 |
| Sensor (`wroom_v2_sensor_ntc`) | 1,014,746 B, 77.4% of slot | default → `otadata, app0, app1, spiffs, coredump` | Yes |

**Hubs need one physical USB visit before OTA works.** The partition table lives
at `0x8000` and cannot be replaced by an OTA image, so the first OTA-capable hub
firmware must go on over USB-C. After that, hubs update remotely forever.

Existing infrastructure this builds on:

- Hub has TLS + MQTT ([hub/src/main.cpp:7-8](hub/src/main.cpp#L7-L8)) and per-hub cloud command topics ([hub/src/main.cpp:869-885](hub/src/main.cpp#L869-L885)).
- `requireSuperadmin` middleware already exists ([auth.js:42](temp-sensors-cloud/backend/src/middleware/auth.js#L42)).
- `audit.js` already exists for recording who changed what.
- Sensors have **no WiFi and no internet path**; ESP-NOW to their hub is the only link.
- No firmware-version or config-version field exists anywhere yet.

---

## 2. Hub firmware OTA

A plain-HTTP pull into the inactive OTA slot, with authenticity provided by an
ECDSA signature checked on-device. Nothing exotic — the hub is mains-powered and
always awake. See the transport note below for why HTTP rather than HTTPS.

**Partition change.** Switch to the stock `min_spiffs.csv`
(`board_build.partitions = min_spiffs.csv`): app0/app1 of 1920 KiB each, 81% full
at the current 1.53 MiB, 356 KiB headroom, 128 KiB SPIFFS. No custom CSV needed.
`nvs` sits at `0x9000`/`0x5000` in both `huge_app.csv` and `min_spiffs.csv`, so
**a plain `pio run -t upload` preserves WiFi and cloud credentials** — do not run
`erase_flash`.

**Signature verification.** Sign the image's SHA-256 with an offline key at build
time; the private key never enters the repo or the droplet. The hub already links
mbedTLS for its MQTT socket (`MBEDTLS_ECDSA_C`, `MBEDTLS_ECP_C`, `SECP256R1` all
enabled in the prebuilt libs), so verification costs no extra flash.

**Rollback — already available.** `sdkconfig.h:435` has
`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE 1`. `esp_ota_set_boot_partition()` marks
the new slot `NEW`; the bootloader boots it and flips it to `PENDING_VERIFY`; on
the next boot, if the app never called `esp_ota_mark_app_valid_cancel_rollback()`,
it reverts automatically. This catches failures *before* your code runs — corrupt
image, crash in early init — which no application-level scheme can.

Mark valid only after the hub has proven itself: WiFi up, MQTT connected, one
successful publish. Not at the top of `setup()`.

**Rollout.** Canary one hub, confirm it reports the new version and stays
connected for 24 h, then the rest. A kill switch that clears pending stages.

**Transport — implemented differently to this plan's first draft.** That draft
called for HTTPS plus a short-lived signed URL token. Both were dropped, for
reasons that only became clear once the hub code existed:

- **Plain HTTP, not HTTPS.** The hub calls `WiFiClientSecure.setInsecure()`
  ([hub/src/main.cpp](hub/src/main.cpp)), so it never authenticated the server anyway — TLS here
  proves nothing about where an image came from. What it *would* cost is a second
  concurrent TLS session competing with the MQTT socket for the C6's heap. The
  ECDSA signature does the entire job, on-device, before the slot is made
  bootable.
- **No URL token.** Images are content-addressed as `/firmware/<sha256>.bin`, so
  paths are unguessable, immutable, and cacheable. Firmware binaries are not
  secret, and a token would have added an auth path to the hub to protect
  something the signature already protects.

The upshot: authenticity lives entirely in the signature, and the transport is
deliberately dumb. `tools/firmware-signing/` holds the key handling.

**Belt and braces at upload.** The backend computes the SHA-256 itself from the
uploaded bytes rather than accepting one from the client, which removes "pasted
the wrong hash" as a failure mode. If `FW_PUBLIC_KEY_PEM` is set it also verifies
the signature at upload time, so a mismatch surfaces in the dashboard instead of
on a hub that then refuses to install.

---

## 3. Sensor remote configuration

### 3.1 The downlink window is already there

A sleeping sensor cannot be pushed to, and ESP-NOW's MAC ACK carries no payload.
But the sensor does not sleep immediately after transmitting: `goToSleep()` calls
`sendLogToHub()` **before** `esp_now_deinit()`
([sensor-ntc/src/main.cpp:296-303](sensor-ntc/src/main.cpp#L296-L303)), and each log chunk paces at
`delay(40)`. ESP-NOW is live and `OnDataRecv` is registered throughout.

So the flow needs almost no new radio time:

1. Sensor wakes, reads NTC, sends `MSG_DATA` (now carrying `cfg_ver`).
2. Hub's `OnDataRecv` fires within a few ms. If the cloud's desired `cfg_ver` for
   that MAC differs, it immediately replies `MSG_CONFIG`.
3. Reply lands during the existing log-transmission window.
4. Sensor validates, clamps, writes NVS, bumps its `cfg_ver`, sleeps.
5. Next wake reports the new `cfg_ver` — the cloud sees the change landed.

**One gap to close:** `sendLogToHub()` returns immediately when the log buffer is
empty, leaving no window at all. Add a bounded wait — ~60 ms — before
`esp_now_deinit()`, taken only when the hub has indicated a config is pending, or
unconditionally if simpler. At 96 wakes/day, 60 ms costs roughly 30 mAh/year
(~1% of the pack); taken only when needed it is negligible.

### 3.2 Parameters

Start small. Every parameter is a thing that can be set wrong remotely.

| Parameter | Type | Clamp | Why |
|---|---|---|---|
| `sleep_interval` | uint16, seconds | **300 – 3600** | Reporting cadence |
| `temp_offset` | float, °C | **±10.0** | Single-point (ice-bath) calibration |
| `temp_gain` | float | **0.9 – 1.1** | Two-point calibration — corrects slope, not just offset |

`t_corrected = temp_gain * t_raw + temp_offset`, applied after the
Steinhart-Hart conversion.

Offset alone cannot fix a slope error, and this project has already been bitten
by one — the ADC-nonlinearity issue that caused ~11 °C over-reading at −17 °C
(CLAUDE.md). Gain costs one extra float and makes real two-point calibration
possible.

**Do not expose `NTC_BCOEFF`, `NTC_NOMINAL`, or `SERIES_RESISTOR` initially.**
They only change when the probe hardware changes, they interact in ways that are
hard to reason about from a dashboard, and a wrong Beta produces plausible-looking
but wrong readings across the whole range. Add them later if you actually start
swapping probe types.

**Leave room to grow.** Give the config message a fixed-size payload with explicit
unused bytes and a `cfg_schema` byte. Then adding a parameter later is a cloud +
hub change; only sensors that need to *act* on the new field require new firmware,
and older sensors ignore it safely.

### 3.3 Config version echo — non-negotiable

Add `cfg_ver` (uint16) to `struct_message`, reported in every data frame. The
dashboard shows *applied* version vs *desired* version:

- Equal → config is live, show the actual values.
- Different → "pending, applies within one reporting interval."

Without this you are guessing whether a change landed on a device you cannot see.
This is the same discipline as firmware version reporting, and it is the single
most valuable field in the whole feature.

### 3.4 Safety

**Clamp on the sensor, not just in the cloud.** The cloud-side clamp is UX; the
sensor-side clamp is the actual protection, because it survives a backend bug, a
bad migration, or a malformed message.

**The sleep-interval ceiling is a self-rescue constraint.** A config change can
only land while the sensor is awake. Set the interval to 24 h and your next
correction takes 24 h to arrive. Cap it at 3600 s so you are never more than an
hour from fixing a mistake.

**Reject, don't truncate, on out-of-range values** — and report the rejection back
so the dashboard can show it, rather than silently applying a clamped value the
operator did not choose.

**Config applies at the end of the current wake cycle**, not mid-cycle. Write NVS,
then sleep for the *new* interval.

**Existing factory reset stays the escape hatch.** Holding D0 for 3 s already
erases NVS and re-enters pairing; make sure it clears config back to compiled
defaults too. That is the recovery path if a node ends up in a bad state — and it
needs no tooling, so the customer can do it over the phone.

**Superadmin only**, via the existing `requireSuperadmin`. Every change written to
`audit.js`: who, which sensor, old value, new value, and whether it was confirmed
applied.

### 3.5 What the dashboard must show

Latency is inherent — up to one full sleep interval — so the UI has to make
pending state obvious or it will look broken.

- Current applied values and `cfg_ver`, per sensor.
- Pending values, with "applies within ~N minutes."
- Last-confirmed timestamp.
- Rejected-value feedback.
- Calibration is destructive to historical comparability: changing offset/gain
  shifts every future reading. Record the change in the audit log **and** mark
  the point on temperature charts so a step change is explicable later.

---

## 4. Cloud changes

**Schema:**
- `firmware_images` — id, device_kind (`hub`|`sensor`), version, size, sha256,
  signature, url, notes, created_at, `is_released`.
- `hub_firmware` — hub mac, current_version, pending_version, state, last_error,
  updated_at.
- `sensor_config` — sensor mac, desired json, desired_cfg_ver, applied_cfg_ver,
  applied_at, last_rejected_reason.

**MQTT topics**, matching the existing `sensors/<hubmac>/...` convention:
- `sensors/<hubmac>/ota/command` / `ota/status` — hub firmware (implemented)
- `sensors/<hubmac>/config/set` — cloud → hub: desired config for a sensor MAC
- `sensors/<hubmac>/config/state` — hub → cloud: applied `cfg_ver` + values, rejections
- Add `fw` to the hub's `status` payload and `cfg_ver` to per-sensor `data`.

**Backend:** `src/routes/firmware.js` and `src/routes/sensor-config.js` (the
latter behind `requireSuperadmin`), handling in `src/mqtt.js`, events into
`src/audit.js`.

**Hub-side state.** The hub holds the desired config per sensor MAC in RAM (and
NVS, so it survives a hub reboot) and pushes on the next contact. It already
tracks up to 10 sensors by MAC, so this is an extra field on an existing record.

---

## 5. Phasing

| Phase | Scope |
|---|---|
| **0. Plumbing + field round** | `FW_VERSION` on hub, `cfg_ver` on sensor, both reported to cloud/dashboard. Hub repartitioned to `min_spiffs.csv`, flashed via USB. Sensors flashed by hand with the config handler — **and the OTA receiver too, if you take option 2 in §0.** |
| **1. Hub OTA** ✅ | HTTP pull, ECDSA signature, bootloader rollback, MQTT stage/status, firmware registry + dashboard. **Implemented.** Still to do: bench-test rollback with a deliberately crashing image before trusting it in the field. |
| **2. Sensor config** | Config downlink, NVS storage, clamping, echo, superadmin route, dashboard UI. |
| **3. Sensor firmware OTA** | Deferred — Appendix A. |

Phases 1 and 2 are independent after Phase 0 and can be built in either order.
Hub OTA first is the safer sequencing: it exercises the signing pipeline and the
cloud→hub command path on a device you can physically reach.

**Watch the headroom.** Hub 81% of slot, sensor 80%. Add a CI check that fails the
build above 90%. Hub image size cannot be meaningfully reduced — 455 KiB of it is
BLE, of which 227 KiB is Espressif's closed controller blob, and NimBLE's
role-trimming options are overridden by the framework's prebuilt `sdkconfig.h`.

---

## 6. What NOT to include

- **No ESP32 Secure Boot v2, no flash encryption.** eFuse burns are irreversible,
  a mistake bricks the board permanently, and it breaks the ESP-PROG flow.
- **No custom bootloader, no bootloader or partition-table OTA.** Only ever write
  app slots.
- **No app-level rollback scheme for the hub.** The bootloader's is enabled and is
  better (§2). Two mechanisms fighting over `otadata` is worse than one.
- **No firmware upload form on the hub's local web dashboard.** It has no
  authentication; an unauthenticated `POST /update` on the LAN is a remote code
  execution primitive. Firmware enters only from the cloud, signed.
- **No exposing NTC Beta/nominal/series-R in the first version** (§3.2).
- **No unclamped config values, ever**, and no cloud-side-only validation.
- **No sleep interval above one hour** — it is a self-rescue constraint, not a
  preference (§3.4).
- **No silent config changes.** Superadmin gate, audit entry, dashboard
  confirmation via `cfg_ver` echo, and a chart annotation for calibration changes.
- **No config state machine in the sensor's `loop()`.** Keep the
  everything-in-`setup()`-then-sleep architecture.

---

## 7. Open questions

1. **§0 option 1 or 2** — ship the OTA receiver during the field round, or accept
   that a future protocol change means opening every enclosure again. Decide
   before Phase 0, because it cannot be revisited cheaply.
2. **Does bootloader rollback fire as expected on the hub?** Bench-test with a
   deliberately crashing image before trusting it in the field. (The hub is always
   awake, so the deep-sleep-wake question in Appendix A does not apply here.)
3. **Is a fixed 60 ms config window acceptable**, or should it be conditional on
   the hub signalling a pending change? Measure the real reply latency first.
4. **Two-point calibration procedure.** Gain+offset is only useful if there is a
   documented way to derive them — ice bath plus one warm reference. Write that
   down alongside the feature, or the fields will be set by guesswork.

---

## Appendix A — Sensor firmware OTA (deferred)

Retained so the analysis is not lost if this is revisited.

**Why deferred:** sensor firmware is simple and stable (read ADC, transmit,
sleep), updates are expected to be rare, and the operator would be the customer
walked through it by phone. The relay, signing path, and registry are substantial
machinery for a handful of uses — and machinery that sits dormant for a year has
quietly rotted by the time it is needed.

**Why it may still be worth building during the Phase 0 field round:** see §0. The
one-time cost of touching every node is already being paid.

**Findings that would carry over:**

- **Transport must be a streaming relay, not hub-side staging.** After two 1920 KiB
  app slots the hub has 128 KiB of SPIFFS against a 1026 KiB image. The hub would
  hold an open HTTPS `Range` connection and pump bytes straight out over ESP-NOW.
- **ESP-NOW v2 is available** — `ESP_NOW_MAX_DATA_LEN_V2 = 1470` and
  `esp_now_get_version()` are declared in the pinned SDK's `esp_now.h`. That is
  ~750 frames for a 1026 KiB image instead of ~4,378 at the v1 250-byte limit.
  Confirm `esp_now_get_version() == 2` at runtime; the header's `esp_now_send`
  note still carries stale v1 text.
- **Trigger via the D0 button**, not a periodic listen window. The node already
  forces a channel rescan on button wake. Standing energy cost: zero.
- **Do not use `Update.h` or `esp_ota_begin`** on the sensor — `esp_ota_begin`
  erases the whole partition up front and the handle state is RAM-only. Use
  `esp_partition_erase_range` + `esp_partition_write` directly.
- **Bootloader rollback needs one extra check on the sensor:** confirm the
  `PENDING_VERIFY`→rollback transition fires on a *deep-sleep wake* boot, given
  IDF's deep-sleep boot shortcuts (`CONFIG_BOOTLOADER_SKIP_VALIDATE_IN_DEEP_SLEEP`).
  Also ensure the existing brownout guard
  ([sensor-ntc/src/main.cpp:693-700](sensor-ntc/src/main.cpp#L693-L700)) does not discard a good image
  by sleeping without marking it valid.
- **Signature verification on the sensor costs 30–60 KiB** (mbedTLS ECP + bignum,
  linked fresh since the sensor has no TLS today) against 254 KiB of slot
  headroom. The alternative — hub verifies, sensor checks only SHA-256 — is
  cheaper but means a stolen fleet-wide `LMK_KEY` can flash sensors.
- **Image identity check:** parse `esp_app_desc_t` from the first 256 bytes and
  confirm `project_name` before writing. Cheap protection against staging a hub
  or SHT40 image onto a sensor, which on a USB-less v2 board means opening the
  enclosure to recover.
- **Budget at close range:** ~750 frames plus ~1 MB of flash writes and ~256
  sector erases → 10–20 s awake, ~0.3–0.5 mAh. Negligible as a rare event.
- **LED is the customer's only local feedback** — three states (working / done /
  problem), with the diagnostic detail going to the dashboard over MQTT, which
  you watch while they hold the node.
