import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Sensor } from '../types';
import { ActiveAlert } from '../services/api';
import BatteryBar from './BatteryBar';

interface Props {
  sensor: Sensor;
  onPress: () => void;
  alert?: ActiveAlert | null;
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

type SensorStatus = 'online' | 'stale' | 'offline';

function getSensorStatus(sensor: Sensor): SensorStatus {
  if (sensor.lastUpdate != null) {
    const ageSec = Math.floor(Date.now() / 1000 - sensor.lastUpdate);
    if (ageSec < 900) return 'online';    // < 15 min
    if (ageSec < 3600) return 'stale';    // 15–60 min
    return 'offline';
  }
  return sensor.active ? 'online' : 'offline';
}

const STATUS_CONFIG: Record<SensorStatus, { label: string; bg: string }> = {
  online:  { label: 'ACTIVE',  bg: '#14532d' },
  stale:   { label: 'STALE',   bg: '#78350f' },
  offline: { label: 'OFFLINE', bg: '#450a0a' },
};

export default function SensorCard({ sensor, onPress, alert }: Props) {
  const status = getSensorStatus(sensor);
  const isOffline = status === 'offline';
  const cfg = STATUS_CONFIG[status];
  const tempStr = (sensor.temp == null || sensor.temp === undefined) ? '--'
    : sensor.temp === -999 ? 'ERR'
    : `${sensor.temp.toFixed(1)}°C`;
  const humStr = (sensor.hum == null || sensor.hum === undefined) ? '--'
    : sensor.hum === -999 ? 'N/A'
    : `${sensor.hum.toFixed(1)}%`;
  const rssiStr = sensor.rssi != null ? `${sensor.rssi} dBm` : '--';
  const lastUpdateStr = sensor.lastUpdate != null ? `Updated ${timeAgo(sensor.lastUpdate)}` : 'No data yet';

  return (
    <TouchableOpacity
      style={[styles.card, isOffline && styles.cardOffline, alert && styles.cardBreached]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <View style={styles.header}>
        <Text style={[styles.name, isOffline && styles.textDim]} numberOfLines={1}>
          {sensor.name}
        </Text>
        <View style={[styles.badge, { backgroundColor: cfg.bg }]}>
          <Text style={styles.badgeText}>{cfg.label}</Text>
        </View>
      </View>

      <Text style={styles.mac}>{sensor.mac}</Text>

      {alert && (
        <View style={styles.breachStrip}>
          <Ionicons name={alert.kind === 'high' ? 'arrow-up' : 'arrow-down'} size={13} color="#fca5a5" />
          <Text style={styles.breachText} numberOfLines={2}>{alert.message}</Text>
        </View>
      )}

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
          <Text style={styles.cellValue}>{rssiStr}</Text>
          <Text style={styles.cellLabel}>Signal</Text>
        </View>
      </View>

      <View style={styles.batteryRow}>
        <Ionicons name="battery-half-outline" size={14} color="#fb923c" style={{ marginRight: 4 }} />
        <BatteryBar level={sensor.battery} />
      </View>

      <Text style={styles.lastUpdate}>{lastUpdateStr}</Text>
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
  cardBreached: {
    borderColor: '#ef4444',
  },
  breachStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#450a0a',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginBottom: 10,
    gap: 6,
  },
  breachText: { color: '#fca5a5', fontSize: 12, fontWeight: '600', flex: 1 },
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
  // badge colors now set inline via STATUS_CONFIG
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
