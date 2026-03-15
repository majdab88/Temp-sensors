import React, { useEffect, useState, useCallback } from 'react';
import {
  View, FlatList, StyleSheet, RefreshControl,
  TouchableOpacity, Text, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/AppNavigator';
import DeviceRow from '../components/DeviceRow';
import { getDevices } from '../services/api';
import { Device } from '../types';
import { getSocket } from '../services/socket';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function DevicesScreen() {
  const navigation = useNavigation<Nav>();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchDevices = useCallback(async () => {
    try {
      const { data } = await getDevices();
      setDevices(data);
    } catch {
      // keep existing data
    }
  }, []);

  useEffect(() => {
    fetchDevices().finally(() => setLoading(false));
  }, [fetchDevices]);

  // Real-time hub status via Socket.IO
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleHubStatus = (data: { mac: string; online: boolean; ip?: string }) => {
      setDevices((prev) =>
        prev.map((d) =>
          d.mac === data.mac
            ? { ...d, online: data.online, ...(data.ip !== undefined ? { ip: data.ip } : {}) }
            : d
        )
      );
    };

    socket.on('hubStatus', handleHubStatus);
    return () => { socket.off('hubStatus', handleHubStatus); };
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchDevices();
    setRefreshing(false);
  };

  const handleRenamed = (id: number, newName: string) => {
    setDevices((prev) => prev.map((d) => d.id === id ? { ...d, name: newName } : d));
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#38bdf8" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={devices}
        keyExtractor={(item) => item.mac}
        renderItem={({ item }) => <DeviceRow device={item} onRenamed={handleRenamed} />}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#38bdf8" />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No hubs registered.</Text>
            <Text style={styles.emptyHint}>Tap + to provision a new hub via BLE.</Text>
          </View>
        }
      />

      {/* FAB to add device */}
      <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate('AddDevice')}>
        <Ionicons name="add" size={28} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  list: { padding: 16 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' },
  empty: { alignItems: 'center', marginTop: 80 },
  emptyText: { color: '#94a3b8', fontSize: 16, fontWeight: '600' },
  emptyHint: { color: '#475569', fontSize: 13, marginTop: 8, textAlign: 'center' },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    backgroundColor: '#0284c7',
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
  },
});
