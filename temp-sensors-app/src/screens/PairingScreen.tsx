import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, FlatList, Text, StyleSheet, RefreshControl,
  ActivityIndicator, TouchableOpacity, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import PairingCard from '../components/PairingCard';
import { getPairingRequests, getDevices, enablePairing } from '../services/api';
import { PairingRequest, Device } from '../types';
import { getSocket } from '../services/socket';

const PAIRING_DURATION = 120; // seconds

function formatCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function PairingScreen() {
  const [requests, setRequests] = useState<PairingRequest[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [enablingHub, setEnablingHub] = useState<string | null>(null);

  // Countdown timers per hub MAC
  const [timers, setTimers] = useState<Record<string, number>>({});
  const intervalsRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const fetchAll = useCallback(async () => {
    try {
      const [reqRes, devRes] = await Promise.all([
        getPairingRequests('pending'),
        getDevices(),
      ]);
      setRequests(reqRes.data);
      setDevices(devRes.data);
    } catch {
      // keep existing
    }
  }, []);

  useEffect(() => {
    fetchAll().finally(() => setLoading(false));
  }, [fetchAll]);

  // Real-time pairing request events
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handlePairingRequest = (request: PairingRequest) => {
      setRequests((prev) => {
        if (prev.some((r) => r.id === request.id)) return prev;
        return [request, ...prev];
      });
    };

    const handlePairingModeStatus = (data: { hub_mac: string; enabled: boolean }) => {
      if (!data.enabled) {
        stopTimer(data.hub_mac);
      }
    };

    socket.on('pairingRequest', handlePairingRequest);
    socket.on('pairingModeStatus', handlePairingModeStatus);
    return () => {
      socket.off('pairingRequest', handlePairingRequest);
      socket.off('pairingModeStatus', handlePairingModeStatus);
    };
  }, []);

  // Cleanup intervals on unmount
  useEffect(() => {
    return () => {
      Object.values(intervalsRef.current).forEach(clearInterval);
    };
  }, []);

  const startTimer = (mac: string) => {
    stopTimer(mac); // clear any existing
    setTimers((prev) => ({ ...prev, [mac]: PAIRING_DURATION }));
    intervalsRef.current[mac] = setInterval(() => {
      setTimers((prev) => {
        const remaining = (prev[mac] ?? 0) - 1;
        if (remaining <= 0) {
          clearInterval(intervalsRef.current[mac]);
          delete intervalsRef.current[mac];
          const { [mac]: _, ...rest } = prev;
          return rest;
        }
        return { ...prev, [mac]: remaining };
      });
    }, 1000);
  };

  const stopTimer = (mac: string) => {
    if (intervalsRef.current[mac]) {
      clearInterval(intervalsRef.current[mac]);
      delete intervalsRef.current[mac];
    }
    setTimers((prev) => {
      const { [mac]: _, ...rest } = prev;
      return rest;
    });
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  };

  const onResolved = (id: number) => {
    setRequests((prev) => prev.filter((r) => r.id !== id));
  };

  const triggerPairingMode = async (device: Device) => {
    const isPairing = timers[device.mac] !== undefined;

    if (isPairing) {
      // Stop pairing
      setEnablingHub(device.mac);
      try {
        await enablePairing(device.mac, false);
        stopTimer(device.mac);
      } catch (err: any) {
        Alert.alert('Error', err?.response?.data?.error ?? 'Failed to disable pairing mode.');
      } finally {
        setEnablingHub(null);
      }
      return;
    }

    // Start pairing
    setEnablingHub(device.mac);
    try {
      await enablePairing(device.mac, true);
      startTimer(device.mac);
      Alert.alert(
        'Pairing Mode On',
        `${device.name || device.mac} is now in pairing mode for 2 minutes.\n\nPower on your sensor node — it will appear here automatically.`
      );
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error ?? 'Failed to enable pairing mode.');
    } finally {
      setEnablingHub(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#38bdf8" />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={requests}
      keyExtractor={(item) => String(item.id)}
      renderItem={({ item }) => <PairingCard request={item} onResolved={onResolved} />}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#38bdf8" />
      }
      ListHeaderComponent={
        <View>
          {/* Enable pairing mode per hub */}
          {devices.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Enable Pairing Mode</Text>
              <Text style={styles.sectionHint}>
                Put a hub in pairing mode, then power on your sensor node. It will appear below automatically.
              </Text>
              {devices.map((d) => {
                const isPairing = timers[d.mac] !== undefined;
                return (
                  <TouchableOpacity
                    key={d.mac}
                    style={styles.hubRow}
                    onPress={() => triggerPairingMode(d)}
                    disabled={enablingHub === d.mac}
                  >
                    <View style={styles.hubInfo}>
                      <Ionicons name="hardware-chip-outline" size={18} color="#38bdf8" />
                      <Text style={styles.hubName}>{d.name || d.mac}</Text>
                      {isPairing && (
                        <Text style={styles.countdown}>{formatCountdown(timers[d.mac])}</Text>
                      )}
                    </View>
                    {enablingHub === d.mac ? (
                      <ActivityIndicator size={16} color="#38bdf8" />
                    ) : isPairing ? (
                      <View style={styles.stopBtn}>
                        <Ionicons name="stop-circle-outline" size={14} color="#fff" />
                        <Text style={styles.stopBtnText}>Stop</Text>
                      </View>
                    ) : (
                      <View style={styles.pairBtn}>
                        <Ionicons name="bluetooth-outline" size={14} color="#fff" />
                        <Text style={styles.pairBtnText}>Enable</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Pending requests header */}
          <Text style={styles.pendingHeader}>
            {requests.length === 0
              ? 'No pending pairing requests'
              : `${requests.length} pending request${requests.length > 1 ? 's' : ''}`}
          </Text>
        </View>
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyHint}>
            Sensor nodes will appear here when they request to pair.
          </Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  list: { padding: 16 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' },
  section: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 14,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#334155',
  },
  sectionTitle: { color: '#f1f5f9', fontSize: 15, fontWeight: '700', marginBottom: 4 },
  sectionHint: { color: '#64748b', fontSize: 12, marginBottom: 12 },
  hubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  hubInfo: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  hubName: { color: '#f1f5f9', fontSize: 14, fontWeight: '600' },
  countdown: { color: '#fbbf24', fontSize: 13, fontWeight: '700', marginLeft: 8 },
  pairBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0284c7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 4,
  },
  pairBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#dc2626',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 4,
  },
  stopBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  pendingHeader: { color: '#94a3b8', fontSize: 14, marginBottom: 12 },
  empty: { alignItems: 'center', marginTop: 20 },
  emptyHint: { color: '#475569', fontSize: 13, textAlign: 'center' },
});
