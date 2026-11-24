#pragma once

// BLE provisioning — the hub's GATT service and flow, unchanged on the wire, so
// the mobile app and ble-provision.html provision this device as they would a
// hub. Blocks until WiFi and the cloud are both proven, then restarts.
void bleProvision();
