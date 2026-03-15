import React, { useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Clipboard, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Device } from '../types';
import { renameDevice } from '../services/api';

interface Props {
  device: Device;
  onRenamed?: (id: number, newName: string) => void;
}

export default function DeviceRow({ device, onRenamed }: Props) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState(device.name || '');
  const [saving, setSaving] = useState(false);

  const copyApiKey = () => {
    const key = device.apiKey || device.api_key;
    if (!key) return;
    Clipboard.setString(key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const saveName = async () => {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === device.name) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await renameDevice(device.id, trimmed);
      onRenamed?.(device.id, trimmed);
      setEditing(false);
    } catch {
      // keep editing open
    } finally {
      setSaving(false);
    }
  };

  const apiKey = device.apiKey || device.api_key;

  return (
    <View style={styles.row}>
      <View style={[styles.dot, device.online ? styles.dotOnline : styles.dotOffline]} />
      <View style={styles.info}>
        {editing ? (
          <View style={styles.editRow}>
            <TextInput
              style={styles.editInput}
              value={nameInput}
              onChangeText={setNameInput}
              autoFocus
              maxLength={30}
            />
            <TouchableOpacity onPress={saveName} disabled={saving} style={styles.editBtn}>
              {saving ? (
                <ActivityIndicator size={14} color="#38bdf8" />
              ) : (
                <Ionicons name="checkmark-circle" size={20} color="#22c55e" />
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setEditing(false); setNameInput(device.name || ''); }} style={styles.editBtn}>
              <Ionicons name="close-circle" size={20} color="#ef4444" />
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.nameRow}>
            <Text style={styles.name}>{device.name || device.mac}</Text>
            <TouchableOpacity onPress={() => { setEditing(true); setNameInput(device.name || ''); }} style={styles.editBtn}>
              <Ionicons name="pencil-outline" size={14} color="#64748b" />
            </TouchableOpacity>
          </View>
        )}
        <Text style={styles.mac}>{device.mac}</Text>
        {device.ip && <Text style={styles.ip}>{device.ip}</Text>}
        {device.registered_at && (
          <Text style={styles.regDate}>
            Registered: {new Date(device.registered_at).toLocaleDateString()}
          </Text>
        )}
      </View>
      <View style={styles.right}>
        <View style={[styles.badge, device.online ? styles.badgeOnline : styles.badgeOffline]}>
          <Text style={styles.badgeText}>{device.online ? 'ONLINE' : 'OFFLINE'}</Text>
        </View>
        {apiKey && (
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
  regDate: { color: '#475569', fontSize: 11, marginTop: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  editRow: { flexDirection: 'row', alignItems: 'center' },
  editInput: {
    flex: 1,
    backgroundColor: '#0f172a',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    color: '#f1f5f9',
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#0284c7',
  },
  editBtn: { padding: 4, marginLeft: 4 },
  right: { alignItems: 'flex-end', gap: 6 },
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  badgeOnline: { backgroundColor: '#14532d' },
  badgeOffline: { backgroundColor: '#450a0a' },
  badgeText: { color: '#f1f5f9', fontSize: 11, fontWeight: '700' },
  copyBtn: { padding: 4 },
});
