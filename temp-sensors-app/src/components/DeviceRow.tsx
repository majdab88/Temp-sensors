import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, Clipboard } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Device } from '../types';

interface Props {
  device: Device;
}

export default function DeviceRow({ device }: Props) {
  const [copied, setCopied] = useState(false);

  const copyApiKey = () => {
    if (!device.apiKey) return;
    Clipboard.setString(device.apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View style={styles.row}>
      <View style={[styles.dot, device.online ? styles.dotOnline : styles.dotOffline]} />
      <View style={styles.info}>
        <Text style={styles.name}>{device.name || device.mac}</Text>
        <Text style={styles.mac}>{device.mac}</Text>
        {device.ip && <Text style={styles.ip}>{device.ip}</Text>}
      </View>
      <View style={styles.right}>
        <View style={[styles.badge, device.online ? styles.badgeOnline : styles.badgeOffline]}>
          <Text style={styles.badgeText}>{device.online ? 'ONLINE' : 'OFFLINE'}</Text>
        </View>
        {device.apiKey && (
          <TouchableOpacity style={styles.copyBtn} onPress={copyApiKey}>
            <Ionicons name={copied ? 'checkmark-outline' : 'copy-outline'} size={16} color={copied ? '#22c55e' : '#64748b'} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  dotOnline: { backgroundColor: '#22c55e' },
  dotOffline: { backgroundColor: '#ef4444' },
  info: { flex: 1 },
  name: { color: '#f1f5f9', fontSize: 15, fontWeight: '600' },
  mac: { color: '#475569', fontSize: 12, marginTop: 2 },
  ip: { color: '#94a3b8', fontSize: 12 },
  right: { alignItems: 'flex-end', gap: 6 },
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  badgeOnline: { backgroundColor: '#14532d' },
  badgeOffline: { backgroundColor: '#450a0a' },
  badgeText: { color: '#f1f5f9', fontSize: 11, fontWeight: '700' },
  copyBtn: { padding: 4 },
});
