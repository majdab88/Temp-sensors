import React, { useEffect, useState, useCallback } from 'react';
import {
  View, FlatList, Text, StyleSheet, RefreshControl,
  ActivityIndicator, TouchableOpacity, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import PairingCard from '../components/PairingCard';
import { getPairingRequests, getDevices, enablePairing } from '../services/api';
import { PairingRequest, Device } from '../types';

export default function PairingScreen() {
  const [requests, setRequests] = useState<PairingRequest[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [enablingHub, setEnablingHub] = useState<string | null>(null);

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

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  };

  const onResolved = (id: number) => {
    setRequests((prev) => prev.filter((r) => r.id !== id));
  };

  const triggerPairingMode = async (device: Device) => {
    setEnablingHub(device.mac);
    try {
      await enablePairing(device.mac, true);
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
              {devices.map((d) => (
                <TouchableOpacity
                  key={d.mac}
                  style={styles.hubRow}
                  onPress={() => triggerPairingMode(d)}
                  disabled={enablingHub === d.mac}
                >
                  <View style={styles.hubInfo}>
                    <Ionicons name="hardware-chip-outline" size={18} color="#38bdf8" />
                    <Text style={styles.hubName}>{d.name || d.mac}</Text>
                  </View>
                  {enablingHub === d.mac ? (
                    <ActivityIndicator size={16} color="#38bdf8" />
                  ) : (
                    <View style={styles.pairBtn}>
                      <Ionicons name="bluetooth-outline" size={14} color="#fff" />
                      <Text style={styles.pairBtnText}>Enable</Text>
                    </View>
                  )}
                </TouchableOpacity>
              ))}
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
  pendingHeader: { color: '#94a3b8', fontSize: 14, marginBottom: 12 },
  empty: { alignItems: 'center', marginTop: 20 },
  emptyHint: { color: '#475569', fontSize: 13, textAlign: 'center' },
});
