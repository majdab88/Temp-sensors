import React from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';
import { VictoryChart, VictoryLine, VictoryAxis, VictoryTheme, VictoryArea } from 'victory-native';
import { Reading } from '../types';

interface Props {
  readings: Reading[];
  field: 'temp' | 'hum';
}

const { width } = Dimensions.get('window');

const FIELD_CONFIG = {
  temp: { label: 'Temperature (°C)', color: '#f87171', unit: '°C' },
  hum:  { label: 'Humidity (%)',      color: '#60a5fa', unit: '%' },
};

export default function ReadingChart({ readings, field }: Props) {
  const cfg = FIELD_CONFIG[field];

  const data = readings
    .filter((r) => r[field] !== -999)
    .map((r) => ({
      x: new Date(r.recordedAt),
      y: r[field],
    }));

  if (data.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No data available</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{cfg.label}</Text>
      <VictoryChart
        width={width - 32}
        height={200}
        theme={VictoryTheme.material}
        padding={{ top: 10, bottom: 40, left: 50, right: 16 }}
      >
        <VictoryAxis
          style={{
            axis: { stroke: '#334155' },
            tickLabels: { fill: '#64748b', fontSize: 10 },
            grid: { stroke: 'transparent' },
          }}
          tickFormat={(t: Date) => {
            const d = new Date(t);
            return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`;
          }}
          tickCount={4}
        />
        <VictoryAxis
          dependentAxis
          style={{
            axis: { stroke: '#334155' },
            tickLabels: { fill: '#64748b', fontSize: 10 },
            grid: { stroke: '#1e293b' },
          }}
          tickFormat={(t: number) => `${t}${cfg.unit}`}
        />
        <VictoryArea
          data={data}
          style={{
            data: {
              fill: cfg.color,
              fillOpacity: 0.1,
              stroke: cfg.color,
              strokeWidth: 2,
            },
          }}
          interpolation="monotoneX"
        />
      </VictoryChart>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: 16 },
  label: { color: '#94a3b8', fontSize: 13, fontWeight: '600', marginBottom: 4, marginLeft: 4 },
  empty: { height: 200, justifyContent: 'center', alignItems: 'center' },
  emptyText: { color: '#475569', fontSize: 14 },
});
