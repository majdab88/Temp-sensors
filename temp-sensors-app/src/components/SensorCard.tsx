import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Sensor } from '../types';
import BatteryBar from './BatteryBar';

interface Props {
  sensor: Sensor;
  onPress: () => void;
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function SensorCard({ sensor, onPress }: Props) {
  const offline = !sensor.active;
  const tempStr = sensor.temp === -999 ? 'ERR' : `${sensor.temp.toFixed(1)}°C`;
  const humStr = sensor.hum === -999 ? 'N/A' : `${sensor.hum.toFixed(1)}%`;

  return (
    <TouchableOpacity
      style={[styles.card, offline && styles.cardOffline]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <View style={styles.header}>
        <Text style={[styles.name, offline && styles.textDim]} numberOfLines={1}>
          {sensor.name}
        </Text>
        <View style={[styles.badge, offline ? styles.badgeOffline : styles.badgeOnline]}>
          <Text style={styles.badgeText}>{offline ? 'OFFLINE' : 'ACTIVE'}</Text>
        </View>
      </View>

      <Text style={styles.mac}>{sensor.mac}</Text>

      <View style={styles.grid}>
        <View style={styles.cell}>
          <Ionicons name="thermometer-outline" size={16} color="#f87171" />
          <Text style={styles.cellValue}>{tempStr}</Text>
          <Text style={styles.cellLabel}>Temp</Text>
        </View>
        <View style={styles.cell}>
          <Ionicons name="water-outline" size={16} color="#60a5fa" />
          <Text style={styles.cellValue}>{humStr}</Text>
          <Text style={styles.cellLabel}>Humidity</Text>
        </View>
        <View style={styles.cell}>
          <Ionicons name="wifi-outline" size={16} color="#4ade80" />
          <Text style={styles.cellValue}>{sensor.rssi} dBm</Text>
          <Text style={styles.cellLabel}>Signal</Text>
        </View>
      </View>

      <View style={styles.batteryRow}>
        <Ionicons name="battery-half-outline" size={14} color="#fb923c" style={{ marginRight: 4 }} />
        <BatteryBar level={sensor.battery} />
      </View>

      <Text style={styles.lastUpdate}>Updated {timeAgo(sensor.lastUpdate)}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardOffline: {
    opacity: 0.5,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  name: {
    color: '#f1f5f9',
    fontSize: 16,
    fontWeight: '700',
    flex: 1,
    marginRight: 8,
  },
  textDim: { color: '#64748b' },
  badge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeOnline: { backgroundColor: '#14532d' },
  badgeOffline: { backgroundColor: '#450a0a' },
  badgeText: { color: '#f1f5f9', fontSize: 11, fontWeight: '700' },
  mac: { color: '#475569', fontSize: 11, marginBottom: 12 },
  grid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  cell: { alignItems: 'center', flex: 1 },
  cellValue: { color: '#f1f5f9', fontSize: 15, fontWeight: '700', marginTop: 4 },
  cellLabel: { color: '#64748b', fontSize: 11, marginTop: 2 },
  batteryRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  lastUpdate: { color: '#475569', fontSize: 11 },
});
