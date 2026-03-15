import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface Props {
  level: number; // 0-100, or 255 for error
}

export default function BatteryBar({ level }: Props) {
  if (level === 255) {
    return <Text style={styles.error}>N/A</Text>;
  }

  const pct = Math.max(0, Math.min(100, level));
  const color = pct < 20 ? '#ef4444' : pct < 50 ? '#f97316' : '#22c55e';

  return (
    <View style={styles.container}>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      <Text style={[styles.label, { color }]}>{pct}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  track: {
    flex: 1,
    height: 6,
    backgroundColor: '#334155',
    borderRadius: 3,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: 3 },
  label: { fontSize: 12, fontWeight: '600', minWidth: 36, textAlign: 'right' },
  error: { color: '#64748b', fontSize: 12 },
});
