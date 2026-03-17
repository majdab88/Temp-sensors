import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, ActivityIndicator, Alert, ScrollView,
  PermissionsAndroid, Platform,
} from 'react-native';
import { Device as BLEDevice } from 'react-native-ble-plx';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import {
  scanForHubs, connectToHub, readHubMac, scanWifiNetworks,
  provisionWifi, provisionCloud, subscribeStatus, disconnectHub,
  WiFiNetwork, ProvStatus,
} from '../services/ble';
import { registerDevice } from '../services/api';

type Step = 'scan' | 'wifi' | 'credentials' | 'provisioning' | 'done';

const STEP_LABELS: Record<Step, string> = {
  scan: 'Scan for hubs',
  wifi: 'Select WiFi network',
  credentials: 'Enter WiFi password',
  provisioning: 'Provisioning…',
  done: 'Done!',
};

const PROVISION_STEPS = [
  'Connecting to WiFi…',
  'Connecting to cloud…',
  'Registered!',
];

export default function AddDeviceScreen() {
  const navigation = useNavigation();
  const [step, setStep] = useState<Step>('scan');
  const [hubs, setHubs] = useState<BLEDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [selectedHub, setSelectedHub] = useState<BLEDevice | null>(null);
  const [connectedHub, setConnectedHub] = useState<BLEDevice | null>(null);
  const [networks, setNetworks] = useState<WiFiNetwork[]>([]);
  const [selectedNetwork, setSelectedNetwork] = useState<WiFiNetwork | null>(null);
  const [wifiPass, setWifiPass] = useState('');
  const [provStep, setProvStep] = useState(0);
  const [provError, setProvError] = useState('');
  const stopScanRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      stopScanRef.current?.();
      if (connectedHub) disconnectHub(connectedHub);
    };
  }, [connectedHub]);

  const requestBlePermissions = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    if (Platform.Version >= 31) {
      const results = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
      return Object.values(results).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
    }
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  };

  const startScan = async () => {
    const granted = await requestBlePermissions();
    if (!granted) {
      Alert.alert('Permission Required', 'Bluetooth and location permissions are needed to scan for hub devices.');
      return;
    }
    setHubs([]);
    setScanning(true);
    stopScanRef.current = scanForHubs(
      (device) => {
        setHubs((prev) => {
          if (prev.some((d) => d.id === device.id)) return prev;
          return [...prev, device];
        });
      },
      (err) => {
        setScanning(false);
        Alert.alert('Scan Error', err.message);
      }
    );
    // Auto-stop after 10 s
    setTimeout(() => {
      stopScanRef.current?.();
      setScanning(false);
    }, 10000);
  };

  const selectHub = async (device: BLEDevice) => {
    stopScanRef.current?.();
    setScanning(false);
    setSelectedHub(device);
    try {
      const connected = await connectToHub(device);
      setConnectedHub(connected);
      const nets = await scanWifiNetworks(connected);
      setNetworks(nets);
      setStep('wifi');
    } catch (err: any) {
      Alert.alert('Connection Failed', err.message ?? 'Could not connect to hub.');
      setSelectedHub(null);
    }
  };

  const selectNetwork = (net: WiFiNetwork) => {
    setSelectedNetwork(net);
    setWifiPass('');
    setStep('credentials');
  };

  const startProvisioning = async () => {
    if (!connectedHub || !selectedNetwork) return;
    setStep('provisioning');
    setProvStep(0);
    setProvError('');

    try {
      // Register hub in cloud → get MQTT credentials
      const hubMac = await readHubMac(connectedHub);
      const { data } = await registerDevice(hubMac);
      const { mqttHost, mqttPort, mqttUser, mqttPass } = data;

      // Subscribe status notifications
      const unsubStatus = subscribeStatus(connectedHub, (status: ProvStatus) => {
        if (status.state === 'connecting') setProvStep(1);
        if (status.state === 'connected') setProvStep(2);
        if (status.state === 'failed') setProvError(status.detail ?? 'Provisioning failed.');
      });

      // Write WiFi credentials
      await provisionWifi(connectedHub, selectedNetwork.ssid, wifiPass);
      // Write cloud credentials
      await provisionCloud(connectedHub, mqttHost, mqttPort, mqttUser, mqttPass);

      // Wait for connected or failed status (up to 30 s)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for hub connection.')), 30000);
        const interval = setInterval(() => {
          if (provStep === 2) { clearTimeout(timeout); clearInterval(interval); resolve(); }
          if (provError) { clearTimeout(timeout); clearInterval(interval); reject(new Error(provError)); }
        }, 500);
      });

      unsubStatus();
      await disconnectHub(connectedHub);
      setStep('done');
    } catch (err: any) {
      setProvError(err.message ?? 'Provisioning failed.');
    }
  };

  const finish = () => {
    navigation.goBack();
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (step === 'scan') {
    return (
      <View style={styles.container}>
        <Text style={styles.stepTitle}>Scan for Hub Devices</Text>
        <Text style={styles.hint}>Make sure your hub is powered on and in provisioning mode.</Text>

        <TouchableOpacity style={styles.primaryBtn} onPress={startScan} disabled={scanning}>
          {scanning ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="bluetooth-outline" size={20} color="#fff" />
              <Text style={styles.primaryBtnText}>Start Scan</Text>
            </>
          )}
        </TouchableOpacity>

        <FlatList
          data={hubs}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.deviceRow} onPress={() => selectHub(item)}>
              <Ionicons name="hardware-chip-outline" size={20} color="#38bdf8" />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.deviceName}>{item.name ?? 'Unknown'}</Text>
                <Text style={styles.deviceId}>{item.id}</Text>
              </View>
              <Text style={styles.rssi}>{item.rssi} dBm</Text>
            </TouchableOpacity>
          )}
          style={{ marginTop: 16 }}
        />
        {scanning && hubs.length === 0 && (
          <Text style={styles.scanning}>Scanning for TempHub devices…</Text>
        )}
      </View>
    );
  }

  if (step === 'wifi') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.stepTitle}>Select WiFi Network</Text>
        <Text style={styles.hint}>Connected to: {selectedHub?.name}</Text>

        {networks.length === 0 && (
          <View style={styles.centered}>
            <ActivityIndicator color="#38bdf8" />
            <Text style={styles.hint}>Scanning networks…</Text>
          </View>
        )}

        {networks.map((net) => (
          <TouchableOpacity key={net.ssid} style={styles.deviceRow} onPress={() => selectNetwork(net)}>
            <Ionicons name="wifi-outline" size={20} color="#38bdf8" />
            <Text style={[styles.deviceName, { flex: 1, marginLeft: 12 }]}>{net.ssid}</Text>
            <Text style={styles.rssi}>{net.rssi} dBm</Text>
            {net.auth !== 'open' && <Ionicons name="lock-closed-outline" size={14} color="#64748b" style={{ marginLeft: 4 }} />}
          </TouchableOpacity>
        ))}
      </ScrollView>
    );
  }

  if (step === 'credentials') {
    return (
      <View style={styles.container}>
        <Text style={styles.stepTitle}>WiFi Password</Text>
        <Text style={styles.hint}>Network: {selectedNetwork?.ssid}</Text>

        <TextInput
          style={styles.input}
          placeholder="WiFi password"
          placeholderTextColor="#64748b"
          secureTextEntry
          value={wifiPass}
          onChangeText={setWifiPass}
        />

        <TouchableOpacity style={styles.primaryBtn} onPress={startProvisioning}>
          <Text style={styles.primaryBtnText}>Provision Hub</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (step === 'provisioning') {
    return (
      <View style={styles.centered}>
        {!provError ? (
          <>
            <ActivityIndicator size="large" color="#38bdf8" />
            <Text style={[styles.stepTitle, { marginTop: 24 }]}>{PROVISION_STEPS[provStep]}</Text>
            <View style={styles.progressRow}>
              {PROVISION_STEPS.map((_, i) => (
                <View key={i} style={[styles.dot, i <= provStep && styles.dotActive]} />
              ))}
            </View>
          </>
        ) : (
          <>
            <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
            <Text style={[styles.stepTitle, { color: '#ef4444', marginTop: 16 }]}>Failed</Text>
            <Text style={styles.hint}>{provError}</Text>
            <TouchableOpacity style={[styles.primaryBtn, { marginTop: 24 }]} onPress={() => setStep('scan')}>
              <Text style={styles.primaryBtnText}>Try Again</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    );
  }

  // done
  return (
    <View style={styles.centered}>
      <Ionicons name="checkmark-circle" size={64} color="#22c55e" />
      <Text style={[styles.stepTitle, { marginTop: 16 }]}>Hub Online!</Text>
      <Text style={styles.hint}>Your hub is now connected to the cloud.</Text>
      <TouchableOpacity style={[styles.primaryBtn, { marginTop: 32 }]} onPress={finish}>
        <Text style={styles.primaryBtnText}>Go to Hubs</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a', padding: 20 },
  content: { padding: 20 },
  centered: { flex: 1, backgroundColor: '#0f172a', justifyContent: 'center', alignItems: 'center', padding: 24 },
  stepTitle: { color: '#f1f5f9', fontSize: 20, fontWeight: '700', marginBottom: 8 },
  hint: { color: '#64748b', fontSize: 14, marginBottom: 16, textAlign: 'center' },
  primaryBtn: {
    flexDirection: 'row',
    backgroundColor: '#0284c7',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 16,
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  deviceName: { color: '#f1f5f9', fontSize: 15, fontWeight: '600' },
  deviceId: { color: '#475569', fontSize: 11, marginTop: 2 },
  rssi: { color: '#64748b', fontSize: 12 },
  scanning: { color: '#64748b', textAlign: 'center', marginTop: 20 },
  input: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: '#f1f5f9',
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 16,
  },
  progressRow: { flexDirection: 'row', gap: 8, marginTop: 16 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#334155' },
  dotActive: { backgroundColor: '#38bdf8' },
});
