import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, TextInput, Switch, TouchableOpacity, StyleSheet,
  ScrollView, ActivityIndicator,
} from 'react-native';
import { getAlertRule, saveAlertRule, deleteAlertRule } from '../services/api';

interface Props {
  sensorId: number;
  sensorName: string;
  visible: boolean;
  onClose: (changed: boolean) => void;
}

/**
 * Per-sensor temperature alert editor for the app. Mirrors the web modal:
 * max/min limits, recovery margin, enabled toggle, and dashboard/push channels.
 */
export default function AlertRuleModal({ sensorId, sensorName, visible, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [exists, setExists]   = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [high, setHigh]       = useState('');
  const [low, setLow]         = useState('');
  const [hyst, setHyst]       = useState('1');
  const [channels, setChannels] = useState<string[]>(['dashboard']);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setLoading(true);
    setError(null);
    getAlertRule(sensorId)
      .then(({ data }) => {
        if (!active || !data) return;
        setExists(true);
        setEnabled(data.enabled);
        setHigh(data.high_limit != null ? String(data.high_limit) : '');
        setLow(data.low_limit != null ? String(data.low_limit) : '');
        setHyst(data.hysteresis != null ? String(data.hysteresis) : '1');
        setChannels(data.channels?.length ? data.channels : ['dashboard']);
      })
      .catch(() => { if (active) setError('Failed to load alert settings'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [visible, sensorId]);

  function parseNum(s: string): number | null | typeof NaN {
    if (s.trim() === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  function toggleChannel(ch: string) {
    setChannels((prev) => (prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]));
  }

  async function handleSave() {
    setError(null);
    const highVal = parseNum(high);
    const lowVal  = parseNum(low);
    const hystVal = hyst.trim() === '' ? 1 : parseNum(hyst);

    if ([highVal, lowVal, hystVal].some((v) => Number.isNaN(v))) return setError('Enter valid numbers');
    if (highVal == null && lowVal == null) return setError('Set a max and/or a min temperature');
    if (highVal != null && lowVal != null && (lowVal as number) >= (highVal as number)) return setError('Min must be below max');
    if ((hystVal as number) < 0) return setError('Recovery margin can’t be negative');
    if (channels.length === 0) return setError('Choose at least one notification channel');

    setSaving(true);
    try {
      await saveAlertRule(sensorId, {
        high_limit: highVal as number | null,
        low_limit: lowVal as number | null,
        hysteresis: hystVal as number,
        channels,
        enabled,
      });
      onClose(true);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to save');
      setSaving(false);
    }
  }

  async function handleDelete() {
    setSaving(true);
    try {
      await deleteAlertRule(sensorId);
      onClose(true);
    } catch {
      setError('Failed to remove');
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => onClose(false)}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Temperature alerts</Text>
          <Text style={styles.sub}>{sensorName}</Text>

          {loading ? (
            <ActivityIndicator color="#38bdf8" style={{ marginVertical: 24 }} />
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled">
              {error && <Text style={styles.error}>{error}</Text>}

              <View style={styles.switchRow}>
                <Text style={styles.label}>Alerts enabled</Text>
                <Switch value={enabled} onValueChange={setEnabled}
                  trackColor={{ true: '#0284c7', false: '#334155' }} thumbColor="#f1f5f9" />
              </View>

              <View style={styles.fieldRow}>
                <View style={styles.field}>
                  <Text style={styles.label}>Max temp (°C)</Text>
                  <TextInput style={styles.input} value={high} onChangeText={setHigh}
                    keyboardType="numbers-and-punctuation" placeholder="e.g. 8" placeholderTextColor="#475569" />
                </View>
                <View style={styles.field}>
                  <Text style={styles.label}>Min temp (°C)</Text>
                  <TextInput style={styles.input} value={low} onChangeText={setLow}
                    keyboardType="numbers-and-punctuation" placeholder="e.g. 2" placeholderTextColor="#475569" />
                </View>
              </View>

              <Text style={styles.label}>Recovery margin (°C)</Text>
              <TextInput style={styles.input} value={hyst} onChangeText={setHyst}
                keyboardType="numbers-and-punctuation" />
              <Text style={styles.hint}>Temp must return this far inside the limit before the alert clears.</Text>

              <Text style={[styles.label, { marginTop: 14 }]}>Notify via</Text>
              <View style={styles.switchRow}>
                <Text style={styles.channelLabel}>Dashboard</Text>
                <Switch value={channels.includes('dashboard')} onValueChange={() => toggleChannel('dashboard')}
                  trackColor={{ true: '#0284c7', false: '#334155' }} thumbColor="#f1f5f9" />
              </View>
              <View style={styles.switchRow}>
                <Text style={styles.channelLabel}>Push notification</Text>
                <Switch value={channels.includes('push')} onValueChange={() => toggleChannel('push')}
                  trackColor={{ true: '#0284c7', false: '#334155' }} thumbColor="#f1f5f9" />
              </View>

              <View style={styles.actions}>
                {exists && (
                  <TouchableOpacity style={[styles.btn, styles.btnDanger]} onPress={handleDelete} disabled={saving}>
                    <Text style={styles.btnDangerText}>Remove</Text>
                  </TouchableOpacity>
                )}
                <View style={{ flex: 1 }} />
                <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => onClose(false)} disabled={saving}>
                  <Text style={styles.btnGhostText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={handleSave} disabled={saving}>
                  <Text style={styles.btnPrimaryText}>{saving ? 'Saving…' : 'Save'}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#1e293b',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    maxHeight: '85%',
    borderWidth: 1,
    borderColor: '#334155',
  },
  title: { color: '#f1f5f9', fontSize: 17, fontWeight: '700' },
  sub: { color: '#64748b', fontSize: 13, marginTop: 2, marginBottom: 14 },
  error: { color: '#fca5a5', backgroundColor: '#450a0a', borderRadius: 8, padding: 10, marginBottom: 12, fontSize: 13 },
  label: { color: '#cbd5e1', fontSize: 13, fontWeight: '600', marginBottom: 6 },
  channelLabel: { color: '#cbd5e1', fontSize: 14 },
  fieldRow: { flexDirection: 'row', gap: 12, marginTop: 10 },
  field: { flex: 1 },
  input: {
    backgroundColor: '#0f172a',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#f1f5f9',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#334155',
  },
  hint: { color: '#64748b', fontSize: 12, marginTop: 4 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 20 },
  btn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 },
  btnPrimary: { backgroundColor: '#0284c7' },
  btnPrimaryText: { color: '#fff', fontWeight: '700' },
  btnGhost: { borderWidth: 1, borderColor: '#334155' },
  btnGhostText: { color: '#cbd5e1', fontWeight: '600' },
  btnDanger: { backgroundColor: '#7f1d1d' },
  btnDangerText: { color: '#fecaca', fontWeight: '700' },
});
