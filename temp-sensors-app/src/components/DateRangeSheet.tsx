import React, { useEffect, useState } from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import { Sheet, Button, T, IconButton, Row } from '../ui';
import { C, F, R, S } from '../theme';
import { MONTHS, formatDate, startOfDay } from '../utils/time';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/**
 * Custom from → to range on a month calendar, day-first, weeks starting
 * Monday. Pure React Native, so it behaves the same on every platform.
 */
export default function DateRangeSheet({ visible, onClose, initial, onApply }: {
  visible: boolean; onClose: () => void; initial: { from: Date; to: Date } | null;
  onApply: (from: Date, to: Date) => void;
}) {
  const today = startOfDay(new Date());
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [from, setFrom] = useState<Date | null>(null);
  const [to, setTo] = useState<Date | null>(null);

  useEffect(() => {
    if (!visible) return;
    setFrom(initial?.from ?? null);
    setTo(initial?.to ?? null);
    const anchor = initial?.to ?? today;
    setMonth(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function tap(d: Date) {
    if (!from || (from && to)) { setFrom(d); setTo(null); return; }
    if (d < from) { setTo(from); setFrom(d); } else setTo(d);
  }

  const first = (month.getDay() + 6) % 7; // Monday-based offset
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = Array(first).fill(null);
  for (let i = 1; i <= days; i++) cells.push(new Date(month.getFullYear(), month.getMonth(), i));
  while (cells.length % 7) cells.push(null);

  const inRange = (d: Date) => from && to && d >= from && d <= to;
  const isEnd = (d: Date) => (from && +d === +from) || (to && +d === +to);
  const canNext = new Date(month.getFullYear(), month.getMonth() + 1, 1) <= today;

  return (
    <Sheet
      visible={visible} onClose={onClose} title="Custom range"
      subtitle={from ? `${formatDate(from)} → ${to ? formatDate(to) : '…'}` : 'Tap the first day, then the last'}
      footer={<><Button label="Cancel" onPress={onClose} small /><Button label="Apply" variant="primary" small disabled={!from} onPress={() => { onApply(from!, to ?? from!); onClose(); }} /></>}
    >
      <Row style={{ justifyContent: 'space-between', marginBottom: S.sm }}>
        <IconButton name="chevron-left" label="Previous month" onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} />
        <T v="h3">{MONTHS[month.getMonth()]} {month.getFullYear()}</T>
        <IconButton name="chevron-right" label="Next month" disabled={!canNext} onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} />
      </Row>
      <View style={styles.grid}>
        {WEEKDAYS.map((w) => <Text key={w} style={[styles.cell, styles.wd]}>{w}</Text>)}
        {cells.map((d, i) => {
          if (!d) return <View key={i} style={styles.cell} />;
          const future = d > today;
          const end = isEnd(d), mid = inRange(d) && !end;
          return (
            <Pressable key={i} disabled={future} onPress={() => tap(d)} style={[styles.cell, mid && styles.mid]}>
              <View style={[styles.day, end && styles.end]}>
                <Text style={[styles.dayText, future && { color: C.lineStrong }, end && { color: C.onDark, fontFamily: F.monoMedium }]}>{d.getDate()}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, height: 42, alignItems: 'center', justifyContent: 'center' },
  wd: { fontFamily: F.medium, fontSize: 11, color: C.ink3, textAlign: 'center', textAlignVertical: 'center', lineHeight: 42 },
  mid: { backgroundColor: C.iceSoft },
  day: { width: 36, height: 36, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center' },
  end: { backgroundColor: C.ice },
  dayText: { fontFamily: F.mono, fontSize: 14, color: C.ink },
});
