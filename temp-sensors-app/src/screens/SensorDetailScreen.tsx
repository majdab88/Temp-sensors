import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  RefreshControl, Alert, ActivityIndicator, TextInput,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList } from '../navigation/AppNavigator';
import ReadingChart from '../components/ReadingChart';
import { getSensorReadings, renameSensor, deleteSensor } from '../services/api';
import { Reading, TimeRange } from '../types';
import { useAuth } from '../context/AuthContext';
import { canEdit } from '../utils/permissions';

type Props = NativeStackScreenProps<RootStackParamList, 'SensorDetail'>;

const TIME_RANGES: TimeRange[] = ['24h', '7d', '30d'];

export default function SensorDetailScreen({ route, navigation }: Props) {
  const { sensorId, sensorName: initialName } = route.params;
  const { user } = useAuth();
  const editor = canEdit(user);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [range, setRange] = useState<TimeRange>('24h');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initialName);
  const [nameInput, setNameInput] = useState(initialName);
  const [saving, setSaving] = useState(false);

  const fetchReadings = useCallback(async () => {
    try {
      const { data } = await getSensorReadings(sensorId, range);
      setReadings(data);
    } catch {
      // keep existing data
    }
  }, [sensorId, range]);

  useEffect(() => {
    setLoading(true);
    fetchReadings().finally(() => setLoading(false));
  }, [fetchReadings]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchReadings();
    setRefreshing(false);
  };

  const saveName = async () => {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === name) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await renameSensor(sensorId, trimmed);
      setName(trimmed);
      navigation.setOptions({ title: trimmed });
      setEditing(false);
    } catch {
      Alert.alert('Error', 'Failed to rename sensor.');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      'Remove Sensor',
      `Remove "${name}" and all its readings? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteSensor(sensorId);
              navigation.goBack();
            } catch {
              Alert.alert('Error', 'Failed to remove sensor.');
            }
          },
        },
      ]
    );
  };

  // Update header title on name change
  useEffect(() => {
    navigation.setOptions({ title: name });
  }, [name, navigation]);

  const hasHumData = readings.some((r) => r.hum !== -999);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#38bdf8" />}
    >
      {/* Name row */}
      <View style={styles.nameRow}>
        {editing ? (
          <>
            <TextInput
              style={styles.nameInput}
              value={nameInput}
              onChangeText={setNameInput}
              autoFocus
              maxLength={19}
            />
            <TouchableOpacity onPress={saveName} disabled={saving} style={styles.iconBtn}>
              {saving ? (
                <ActivityIndicator size={18} color="#38bdf8" />
              ) : (
                <Ionicons name="checkmark-circle" size={24} color="#22c55e" />
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setEditing(false); setNameInput(name); }} style={styles.iconBtn}>
              <Ionicons name="close-circle" size={24} color="#ef4444" />
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.sensorName}>{name}</Text>
            {editor && (
              <TouchableOpacity onPress={() => { setEditing(true); setNameInput(name); }} style={styles.iconBtn}>
                <Ionicons name="pencil-outline" size={20} color="#64748b" />
              </TouchableOpacity>
            )}
            {editor && (
              <TouchableOpacity onPress={confirmDelete} style={styles.iconBtn}>
                <Ionicons name="trash-outline" size={20} color="#ef4444" />
              </TouchableOpacity>
            )}
          </>
        )}
      </View>

      {/* Time range selector */}
      <View style={styles.rangeRow}>
        {TIME_RANGES.map((r) => (
          <TouchableOpacity
            key={r}
            style={[styles.rangeBtn, range === r && styles.rangeBtnActive]}
            onPress={() => setRange(r)}
          >
            <Text style={[styles.rangeBtnText, range === r && styles.rangeBtnTextActive]}>{r}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator size="large" color="#38bdf8" style={{ marginTop: 40 }} />
      ) : (
        <>
          <ReadingChart readings={readings} field="temp" />
          {hasHumData && <ReadingChart readings={readings} field="hum" />}

          {/* Readings data table */}
          {readings.length > 0 && (
            <View style={styles.tableSection}>
              <Text style={styles.tableTitle}>Readings ({readings.length})</Text>
              <View style={styles.tableHeader}>
                <Text style={[styles.tableHeaderCell, { flex: 2 }]}>Time</Text>
                <Text style={styles.tableHeaderCell}>Temp</Text>
                <Text style={styles.tableHeaderCell}>Hum</Text>
                <Text style={styles.tableHeaderCell}>RSSI</Text>
                <Text style={styles.tableHeaderCell}>Bat</Text>
              </View>
              {[...readings].reverse().slice(0, 100).map((r, i) => (
                <View key={r.id ?? i} style={[styles.tableRow, i % 2 === 0 && styles.tableRowAlt]}>
                  <Text style={[styles.tableCell, { flex: 2 }]}>
                    {new Date(r.recorded_at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </Text>
                  <Text style={styles.tableCell}>
                    {r.temp === -999 ? 'ERR' : r.temp?.toFixed(2) ?? '—'}
                  </Text>
                  <Text style={styles.tableCell}>
                    {r.hum === -999 ? 'N/A' : r.hum?.toFixed(1) ?? '—'}
                  </Text>
                  <Text style={styles.tableCell}>
                    {r.rssi ?? '—'}
                  </Text>
                  <Text style={styles.tableCell}>
                    {r.battery != null && r.battery !== 255 ? `${r.battery}%` : '—'}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  content: { padding: 16 },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  sensorName: { color: '#f1f5f9', fontSize: 20, fontWeight: '700', flex: 1 },
  nameInput: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#f1f5f9',
    fontSize: 18,
    fontWeight: '700',
    borderWidth: 1,
    borderColor: '#0284c7',
    marginRight: 4,
  },
  iconBtn: { padding: 4, marginLeft: 4 },
  rangeRow: {
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 4,
    marginBottom: 20,
  },
  rangeBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  rangeBtnActive: { backgroundColor: '#0284c7' },
  rangeBtnText: { color: '#64748b', fontWeight: '600' },
  rangeBtnTextActive: { color: '#fff' },
  tableSection: {
    marginTop: 24,
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  tableTitle: { color: '#94a3b8', fontSize: 13, fontWeight: '700', marginBottom: 8 },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    paddingBottom: 6,
    marginBottom: 4,
  },
  tableHeaderCell: { flex: 1, color: '#64748b', fontSize: 11, fontWeight: '700' },
  tableRow: { flexDirection: 'row', paddingVertical: 5 },
  tableRowAlt: { backgroundColor: '#0f172a', borderRadius: 4 },
  tableCell: { flex: 1, color: '#cbd5e1', fontSize: 12 },
});
