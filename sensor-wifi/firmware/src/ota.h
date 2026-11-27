#pragma once
#include <Arduino.h>

// Signed OTA, the hub's scheme: the cloud publishes {url, version, sha256, sig}
// on sensors/<mac>/ota/command; the image is downloaded over plain HTTP, hashed,
// ECDSA-verified against the compiled-in public key, and checked for this
// product's marker before the new slot is ever made bootable.
//
// Rollback is application-level (the bootloader's never arms on this chip, see
// CLAUDE.md): an installed image must deliver a reading within
// OTA_MAX_BOOT_TRIES attempts, or it switches back to the previous slot.

void        otaLoadState();               // once at boot
// Call when this boot is about to try the cloud. Counts an attempt for an
// unconfirmed image and reverts (restarts) once the budget is spent. Boots that
// only log a reading do not count: a long router outage on battery must not
// throw away a good update.
void        otaBeginAttempt();
void        otaConfirm();                 // a reading was delivered
bool        otaWindowExpired();           // mains: unconfirmed for too long

// From the MQTT callback. Records the command only; nothing slow happens here.
void        otaHandleCommand(const String& json, bool onMains);
bool        otaPending();
void        otaRun();                     // from loop(), mains only

const char* otaBootStateName();
