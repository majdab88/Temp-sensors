import React from 'react';
import { Text, StyleSheet } from 'react-native';
import Svg, { Rect } from 'react-native-svg';

interface Props {
  level: number; // 0-100, or 255 for error, or null/undefined for unknown
}

/**
 * Coarse battery indicator — full / half / low — from the L91 pack % (derived
 * from true pack voltage). No number shown; the exact % is in the hub logs.
 *   Full >= 40%  ·  Half 22-40%  ·  Low < 22%
 */
export default function BatteryBar({ level }: Props) {
  if (level == null || level === 255) {
    return <Text style={styles.muted}>—</Text>;
  }

  const lvl   = level < 22 ? 'low' : level < 40 ? 'half' : 'full';
  const color = lvl === 'low' ? '#ef4444' : lvl === 'half' ? '#eab308' : '#22c55e';
  const fillW = lvl === 'low' ? 4 : lvl === 'half' ? 8.5 : 15;

  return (
    <Svg width={24} height={13} viewBox="0 0 22 12">
      <Rect x={0.75} y={0.75} width={18} height={10.5} rx={2} fill="none" stroke="#64748b" strokeWidth={1} />
      <Rect x={19.5} y={3.5} width={2} height={5} rx={1} fill="#64748b" />
      <Rect x={2.25} y={2.25} width={fillW} height={7.5} rx={1} fill={color} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  muted: { color: '#64748b', fontSize: 12 },
});
