import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { T, Chip, Button, Row } from '../ui';
import { Sparkline, BatteryGlyph } from './charts';
import { useLiveState } from '../utils/live';
import { fmt, validHum, statusChip, limitText, sensorLabel, batteryLevel, volts, BATTERY_TYPE_SHORT } from '../utils/sensor';
import { timeAgo } from '../utils/time';
import type { Sensor, Reading, ActiveAlert, AlertRule } from '../types';
import { C, F, R, S } from '../theme';

/** Live / waking chips for a sensor. */
export function LiveChips({ sensor, reading, liveSeenAt }: { sensor: Sensor; reading: Reading | null; liveSeenAt: number }) {
  const { isLive, livePending, liveLeft, nextWakeIn } = useLiveState(sensor, reading, liveSeenAt);
  if (isLive) return <Chip tone="ice" icon="radio" label={`Live${liveLeft > 0 ? ` ${liveLeft}s` : ''}`} />;
  if (livePending) return <Chip tone="plain" icon="moon" label={`Waking${nextWakeIn ? ` ${nextWakeIn}` : ''}`} />;
  return null;
}

/** Battery glyph + % + the two pack voltages (under load, at rest). */
export function BatteryLine({ reading, type, compact }: { reading: Reading | null; type?: string | null; compact?: boolean }) {
  const lvl = batteryLevel(reading?.battery);
  const typeShort = BATTERY_TYPE_SHORT[type || 'lithium'];
  if (!lvl) return compact ? null : <T v="monoSmall">battery —</T>;
  const load = volts(reading?.bat_load_mv), rest = volts(reading?.bat_mv);
  return (
    <Row gap={6}>
      <BatteryGlyph level={lvl} />
      <Text style={[styles.meta, lvl === 'low' && { color: C.amber }]}>
        {reading!.battery}%{compact ? '' : ` · ${typeShort}`}
      </Text>
      {!compact && (load || rest) ? (
        <Text style={styles.meta}>{[load && `${load} load`, rest && `${rest} rest`].filter(Boolean).join(' · ')}</Text>
      ) : null}
    </Row>
  );
}

/** Overview tile: one sensor at a glance. */
export function SensorTile({ sensor, reading, alert, rule, spark, liveSeenAt, onPress }: {
  sensor: Sensor; reading: Reading | null; alert: ActiveAlert | null; rule: AlertRule | null;
  spark: number[] | null; liveSeenAt: number; onPress: () => void;
}) {
  const chip = statusChip(sensor, reading, !!alert);
  const limits = limitText(rule);
  const t = fmt(reading?.temp);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.tile, !!alert && styles.tileAlarm, pressed && { opacity: 0.8 }]}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={styles.eyebrow} numberOfLines={1}>{sensor.hub_name || sensor.hub_mac}</Text>
        {chip.tone !== 'ok' && <Chip tone={chip.tone} label={chip.label} />}
      </Row>
      <T v="h3" numberOfLines={1} style={{ marginTop: 2 }}>{sensorLabel(sensor)}</T>
      <View style={styles.readingRow}>
        <Text style={[styles.temp, !!alert && { color: C.alarm }, t == null && { color: C.ink3 }]}>{t ?? '--'}</Text>
        {t != null && <Text style={styles.unit}>°C</Text>}
      </View>
      <Text style={styles.meta} numberOfLines={1}>
        {[validHum(reading?.hum) ? `RH ${fmt(reading!.hum, 0)}%` : null, limits].filter(Boolean).join(' · ') || ' '}
      </Text>
      <View style={{ marginVertical: 8 }}><Sparkline points={spark} alarm={!!alert} height={26} /></View>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={styles.meta}>{timeAgo(reading?.recorded_at)}</Text>
        <BatteryLine reading={reading} compact />
      </Row>
      <View style={{ marginTop: 6, flexDirection: 'row' }}><LiveChips sensor={sensor} reading={reading} liveSeenAt={liveSeenAt} /></View>
    </Pressable>
  );
}

/** The worst active breach, measured against the current reading. */
export function AlarmHero({ hero, more, canEdit, acking, onView, onAck, onRules }: {
  hero: ActiveAlert & { delta: number; mins: number }; more: string[]; canEdit: boolean; acking: boolean;
  onView: () => void; onAck: () => void; onRules: () => void;
}) {
  return (
    <View style={styles.hero}>
      <Row gap={6}>
        <View style={styles.heroDot} />
        <Text style={styles.heroEyebrow}>ACTIVE ALARM · {hero.mins} MIN</Text>
      </Row>
      <Text style={styles.heroTitle}>
        {hero.sensor_name || hero.sensor_mac} is {hero.delta.toFixed(1)}° {hero.kind === 'high' ? 'above' : 'below'} its limit
      </Text>
      <Row gap={S.sm} style={{ flexWrap: 'wrap', marginTop: S.md }}>
        <Button label="View sensor" variant="onAlarm" small onPress={onView} />
        {canEdit && hero.excursion_id != null && (hero.acked
          ? <Text style={styles.heroAcked}>✓ Acknowledged{hero.ack_by ? ` · ${hero.ack_by}` : ''}</Text>
          : <Button label="Acknowledge" variant="onAlarmGhost" small busy={acking} onPress={onAck} />)}
        <Button label="Alert rules" variant="onAlarmGhost" small onPress={onRules} />
      </Row>
      {more.length > 0 && <Text style={styles.heroMore}>+ {more.length} more: {more.join(', ')}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { backgroundColor: C.surface, borderRadius: R.tile, padding: S.md, borderWidth: 2, borderColor: 'transparent', flexGrow: 1, flexBasis: 150, maxWidth: '100%' },
  tileAlarm: { borderColor: C.alarm },
  eyebrow: { fontFamily: F.regular, fontSize: 11, color: C.ink3, flex: 1, marginRight: 4 },
  readingRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 4 },
  temp: { fontFamily: F.monoMedium, fontSize: 32, color: C.ink, letterSpacing: -1 },
  unit: { fontFamily: F.mono, fontSize: 13, color: C.ink2, marginTop: 6, marginLeft: 2 },
  meta: { fontFamily: F.mono, fontSize: 11, color: C.ink2 },
  hero: { backgroundColor: C.alarm, borderRadius: R.card, padding: S.lg },
  heroDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.onDark },
  heroEyebrow: { fontFamily: F.monoMedium, fontSize: 11, color: 'rgba(255,255,255,0.85)', letterSpacing: 0.5 },
  heroTitle: { fontFamily: F.bold, fontSize: 21, color: C.onDark, marginTop: 6, lineHeight: 26 },
  heroAcked: { fontFamily: F.medium, fontSize: 13, color: C.onDark, alignSelf: 'center' },
  heroMore: { fontFamily: F.regular, fontSize: 12, color: 'rgba(255,255,255,0.85)', marginTop: S.md },
});
