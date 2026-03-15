import React, { useEffect, useState, useCallback } from 'react';
import {
  View, FlatList, Text, StyleSheet, RefreshControl, ActivityIndicator,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/AppNavigator';
import SensorCard from '../components/SensorCard';
import { getSensors } from '../services/api';
import { connectSocket, getSocket } from '../services/socket';
import { Sensor } from '../types';
import { useAuth } from '../context/AuthContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Main'>;

export default function DashboardScreen({ navigation }: any) {
  const { token } = useAuth();
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchSensors = useCallback(async () => {
    try {
      const { data } = await getSensors();
      setSensors(data);
    } catch (err) {
      // silently keep existing data on refresh failure
    }
  }, []);

  useEffect(() => {
    (async () => {
      await fetchSensors();
      setLoading(false);
    })();

    // Subscribe to Socket.IO live updates
    const socket = token ? connectSocket(token) : getSocket();
    if (!socket) return;

    const handleUpdate = (updated: Partial<Sensor> & { mac: string }) => {
      setSensors((prev) =>
        prev.map((s) => (s.mac === updated.mac ? { ...s, ...updated } : s))
      );
    };

    const handleOffline = (mac: string) => {
      setSensors((prev) =>
        prev.map((s) => (s.mac === mac ? { ...s, active: false } : s))
      );
    };

    socket.on('sensor_update', handleUpdate);
    socket.on('sensor_offline', handleOffline);

    return () => {
      socket.off('sensor_update', handleUpdate);
      socket.off('sensor_offline', handleOffline);
    };
  }, [token, fetchSensors]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchSensors();
    setRefreshing(false);
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
        data={sensors}
        keyExtractor={(item) => item.mac}
        renderItem={({ item }) => (
          <SensorCard
            sensor={item}
            onPress={() =>
              navigation.navigate('SensorDetail', {
                sensorId: item.id,
                sensorName: item.name,
              })
            }
          />
        )}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#38bdf8"
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No sensors found.</Text>
            <Text style={styles.emptyHint}>Pair a sensor node to your hub to see readings here.</Text>
          </View>
        }
      />
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
});
