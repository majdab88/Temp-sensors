import React, { useEffect, useState, useCallback } from 'react';
import {
  View, FlatList, Text, StyleSheet, RefreshControl, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/AppNavigator';
import SensorCard from '../components/SensorCard';
import { getSensors, getActiveAlerts, ActiveAlert } from '../services/api';
import { connectSocket, getSocket } from '../services/socket';
import { Sensor } from '../types';
import { useAuth } from '../context/AuthContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Main'>;

export default function DashboardScreen({ navigation }: any) {
  const { token } = useAuth();
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [alerts, setAlerts] = useState<Record<string, ActiveAlert>>({});
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

  const fetchAlerts = useCallback(async () => {
    try {
      const { data } = await getActiveAlerts();
      const map: Record<string, ActiveAlert> = {};
      data.forEach((a) => { map[a.sensor_mac] = a; });
      setAlerts(map);
    } catch {
      // non-fatal — breaches will still arrive via the socket
    }
  }, []);

  // Track which hub rooms we've joined so we can leave on cleanup
  const joinedRoomsRef = React.useRef<string[]>([]);

  useEffect(() => {
    (async () => {
      await Promise.all([fetchSensors(), fetchAlerts()]);
      setLoading(false);
    })();
  }, [fetchSensors, fetchAlerts]);

  // Join Socket.IO rooms for each hub and subscribe to live events
  useEffect(() => {
    const socket = token ? connectSocket(token) : getSocket();
    if (!socket) return;

    // Derive unique hub MACs from the loaded sensors and join their rooms
    const hubMacs = [...new Set(
      sensors.map((s) => (s as any).hub_mac).filter(Boolean) as string[]
    )];
    const prevRooms = joinedRoomsRef.current;

    // Join any new rooms
    hubMacs.forEach((mac) => {
      if (!prevRooms.includes(mac)) {
        socket.emit('join', mac);
      }
    });
    // Leave rooms no longer needed
    prevRooms.forEach((mac) => {
      if (!hubMacs.includes(mac)) {
        socket.emit('leave', mac);
      }
    });
    joinedRoomsRef.current = hubMacs;

    // Backend emits 'sensorData' with { sensor_mac, temp, hum, battery, rssi, ts }
    const handleSensorData = (data: {
      sensor_mac: string;
      temp: number | null;
      hum: number | null;
      battery: number | null;
      rssi: number | null;
      ts: number;
    }) => {
      setSensors((prev) =>
        prev.map((s) =>
          s.mac === data.sensor_mac
            ? {
                ...s,
                temp: data.temp ?? s.temp,
                hum: data.hum ?? s.hum,
                rssi: data.rssi ?? s.rssi,
                battery: data.battery ?? s.battery,
                lastUpdate: Math.floor(data.ts / 1000), // ts is ms, lastUpdate is seconds
                active: true,
              }
            : s
        )
      );
    };

    const handleHubStatus = (data: { hub_mac: string; online: boolean }) => {
      if (!data.online) {
        // Mark all sensors belonging to this hub as inactive
        setSensors((prev) =>
          prev.map((s) =>
            (s as any).hub_mac === data.hub_mac ? { ...s, active: false } : s
          )
        );
      }
    };

    // Alert transitions — keep a map of active breaches; 'recovered' clears one.
    const handleAlert = (a: {
      sensor_mac: string; sensor_name: string; kind: string; value: number; message: string; ts: number;
    }) => {
      setAlerts((prev) => {
        const next = { ...prev };
        if (a.kind === 'recovered') delete next[a.sensor_mac];
        else next[a.sensor_mac] = a as ActiveAlert;
        return next;
      });
    };

    // Re-join rooms on every (re)connect — the socket may connect after this
    // effect runs, and rooms are dropped server-side on disconnect.
    const handleConnect = () => {
      joinedRoomsRef.current.forEach((mac) => socket.emit('join', mac));
    };

    socket.on('sensorData', handleSensorData);
    socket.on('hubStatus', handleHubStatus);
    socket.on('alert', handleAlert);
    socket.on('connect', handleConnect);
    if (socket.connected) handleConnect(); // already connected — join now

    return () => {
      socket.off('sensorData', handleSensorData);
      socket.off('hubStatus', handleHubStatus);
      socket.off('alert', handleAlert);
      socket.off('connect', handleConnect);
      // Leave all rooms on unmount
      joinedRoomsRef.current.forEach((mac) => socket.emit('leave', mac));
      joinedRoomsRef.current = [];
    };
  }, [token, sensors.length]); // re-run when sensor count changes (new hub MACs)

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchSensors(), fetchAlerts()]);
    setRefreshing(false);
  };

  const activeAlerts = Object.values(alerts);

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
            alert={alerts[item.mac] || null}
            onPress={() =>
              navigation.navigate('SensorDetail', {
                sensorId: item.id,
                sensorName: item.name,
              })
            }
          />
        )}
        ListHeaderComponent={
          activeAlerts.length > 0 ? (
            <View style={styles.banner}>
              {activeAlerts.map((a) => (
                <View key={a.sensor_mac} style={styles.bannerItem}>
                  <Ionicons name="warning" size={15} color="#fca5a5" />
                  <Text style={styles.bannerText} numberOfLines={2}>{a.message}</Text>
                </View>
              ))}
            </View>
          ) : null
        }
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
  banner: { marginBottom: 12, gap: 8 },
  bannerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#450a0a',
    borderWidth: 1,
    borderColor: '#7f1d1d',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  bannerText: { color: '#fca5a5', fontSize: 13, fontWeight: '600', flex: 1 },
});
