import { BleManager, Device, Characteristic } from 'react-native-ble-plx';
import { Platform } from 'react-native';
import { Buffer } from 'buffer';

// BLE GATT UUIDs (must match NimBLE-Arduino hub firmware)
export const GATT = {
  SERVICE:       '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
  PROV_WIFI:     'beb5483e-36e1-4688-b7f5-ea07361b26a8',
  PROV_CLOUD:    '1c95d5e3-d8f7-413a-bf3d-7a2e5d7be87e',
  PROV_STATUS:   '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
  PROV_NETWORKS: 'd5913036-2d8a-41ee-85b9-4e361aa5c8a3',
  PROV_INFO:     'a9b12301-bc5d-4e8a-9c23-c5d1b3f4a5e6',
} as const;

export interface WiFiNetwork {
  ssid: string;
  rssi: number;
  auth: string; // 'open' | 'wpa2' | etc.
}

export interface ProvStatus {
  state: 'idle' | 'connecting' | 'connected' | 'failed';
  detail?: string;
}

let manager: BleManager | null = null;

function getManager(): BleManager {
  if (!manager) manager = new BleManager();
  return manager;
}

export function destroyManager() {
  manager?.destroy();
  manager = null;
}

/** Scan for TempHub-XXXXXX BLE devices. Calls onDevice for each discovered hub. */
export function scanForHubs(
  onDevice: (device: Device) => void,
  onError: (err: Error) => void
): () => void {
  const mgr = getManager();
  mgr.startDeviceScan(
    [GATT.SERVICE],
    { allowDuplicates: false },
    (error, device) => {
      if (error) { onError(error); return; }
      if (device && device.name?.startsWith('TempHub-')) {
        onDevice(device);
      }
    }
  );
  return () => mgr.stopDeviceScan();
}

function encode(obj: object): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

function decode(b64: string): unknown {
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

/** Connect to hub and return the connected Device (with services/chars discovered). */
export async function connectToHub(device: Device, retries = 3): Promise<Device> {
  const mgr = getManager();
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Cancel any stale connection from a previous attempt
      try { await mgr.cancelDeviceConnection(device.id); } catch { /* ignore */ }

      // Small delay between scan-stop and connect (Android needs this)
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
      else await new Promise((r) => setTimeout(r, 300));

      const connected = await mgr.connectToDevice(device.id, {
        autoConnect: false,
        timeout: 10000,
      });
      await connected.discoverAllServicesAndCharacteristics();
      return connected;
    } catch (err: any) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('Failed to connect to hub.');
}

/** Read hub MAC address from PROV_INFO characteristic. */
export async function readHubMac(device: Device): Promise<string> {
  const char = await device.readCharacteristicForService(GATT.SERVICE, GATT.PROV_INFO);
  const info = decode(char.value ?? '') as { mac: string };
  return info.mac;
}

/** Trigger a WiFi network scan and wait for results via PROV_NETWORKS characteristic. */
export async function scanWifiNetworks(device: Device): Promise<WiFiNetwork[]> {
  // Write empty object to trigger scan
  await device.writeCharacteristicWithResponseForService(
    GATT.SERVICE, GATT.PROV_NETWORKS, encode({ scan: true })
  );
  // Poll for result (hub fills the char after scanning)
  await new Promise((r) => setTimeout(r, 3000));
  const char = await device.readCharacteristicForService(GATT.SERVICE, GATT.PROV_NETWORKS);
  const networks = decode(char.value ?? '[]') as WiFiNetwork[];
  return networks;
}

/** Write WiFi credentials to hub. */
export async function provisionWifi(device: Device, ssid: string, pass: string): Promise<void> {
  await device.writeCharacteristicWithResponseForService(
    GATT.SERVICE, GATT.PROV_WIFI, encode({ ssid, pass })
  );
}

/** Write MQTT/cloud credentials to hub. */
export async function provisionCloud(
  device: Device,
  host: string,
  port: number,
  user: string,
  pass: string
): Promise<void> {
  await device.writeCharacteristicWithResponseForService(
    GATT.SERVICE, GATT.PROV_CLOUD, encode({ host, port, user, pass })
  );
}

/**
 * Subscribe to PROV_STATUS notifications. Calls onStatus for each update.
 * Returns an unsubscribe function.
 */
export function subscribeStatus(
  device: Device,
  onStatus: (status: ProvStatus) => void
): () => void {
  const sub = device.monitorCharacteristicForService(
    GATT.SERVICE,
    GATT.PROV_STATUS,
    (error, char) => {
      if (error || !char?.value) return;
      const status = decode(char.value) as ProvStatus;
      onStatus(status);
    }
  );
  return () => sub.remove();
}

/** Disconnect from hub. */
export async function disconnectHub(device: Device): Promise<void> {
  try {
    await device.cancelConnection();
  } catch {
    // ignore
  }
}
