import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import {
  Screen, Card, T, Row, Chip, Button, Section, Segmented, Stat, Sheet, Field, Notice, Loading, Empty, Icon, IconName,
} from '../ui';
import { confirm, useToast } from '../ui/feedback';
import { TempChart, ChartPoint } from '../components/charts';
import { LiveChips, BatteryLine } from '../components/SensorBits';
import AlertRuleSheet from '../components/AlertRuleSheet';
import SensorConfigSheet from '../components/SensorConfigSheet';
import DateRangeSheet from '../components/DateRangeSheet';
import { useOrgData } from '../store/OrgData';
import { useAuth } from '../context/AuthContext';
import { useLiveState } from '../utils/live';
import * as api from '../services/api';
import { saveCsv, savePdf, reportHtml, statsHtml, tableHtml, chartSvg } from '../services/export';
import { fmt, validHum, statusChip, limitText, sensorLabel, computeStats, BATTERY_TYPE_LABEL } from '../utils/sensor';
import { timeAgo, formatDateTime, formatDate, startOfDay, endOfDay } from '../utils/time';
import type { ScreenProps } from '../navigation/types';
import type { Reading } from '../types';
import { C, F, R, S } from '../theme';

type RangeKey = 24 | 168 | 720 | 'custom';
const RANGES: { value: RangeKey; label: string }[] = [
  { value: 24, label: '24 h' }, { value: 168, label: '7 d' }, { value: 720, label: '30 d' }, { value: 'custom', label: 'Custom' },
];
const TABLE_PAGE = 60;

export default function SensorDetailScreen({ route, navigation }: ScreenProps<'SensorDetail'>) {
  const { sensorId } = route.params;
  const toast = useToast();
  const { canEdit, isSuperadmin } = useAuth();
  const store = useOrgData();
  const sensor = store.sensors.find((s) => s.id === sensorId);
  const reading = sensor ? store.readings[sensor.mac] ?? null : null;
  const alert = sensor ? store.alerts[sensor.mac] ?? null : null;
  const rule = store.rules[sensorId] ?? null;

  const [range, setRange] = useState<RangeKey>(24);
  const [custom, setCustom] = useState<{ from: Date; to: Date } | null>(null);
  const [rows, setRows] = useState<Reading[] | null>(null);
  const [histErr, setHistErr] = useState<string | null>(null);
  const [shown, setShown] = useState(TABLE_PAGE);
  const [sheet, setSheet] = useState<null | 'rename' | 'rule' | 'config' | 'range'>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [liveNote, setLiveNote] = useState('');

  useEffect(() => { navigation.setOptions({ title: sensor ? sensorLabel(sensor) : 'Sensor' }); }, [navigation, sensor?.name]);

  const win = useMemo(() => {
    if (range === 'custom' && custom) return { from: startOfDay(custom.from), to: endOfDay(custom.to) };
    const hours = range === 'custom' ? 24 : range;
    return { from: new Date(Date.now() - hours * 3600000), to: new Date() };
  }, [range, custom]);

  useEffect(() => {
    let live = true;
    setRows(null); setHistErr(null); setShown(TABLE_PAGE);
    api.getReadings(sensorId, { from: win.from.toISOString(), to: win.to.toISOString(), limit: 500 })
      .then((r) => { if (live) setRows([...r.data].reverse()); }) // API is newest-first
      .catch(() => { if (live) setHistErr('Failed to load readings'); });
    return () => { live = false; };
  }, [sensorId, win]);

  const live = useLiveState(sensor ?? ({} as any), reading, sensor ? store.liveSeen[sensor.mac] ?? 0 : 0);

  if (!sensor) {
    return <Screen><Empty icon="slash" title="Sensor not found" body="It may have been removed or moved to another org." /></Screen>;
  }

  const chip = statusChip(sensor, reading, !!alert);
  const limits = limitText(rule);
  const high = rule?.enabled ? rule.high_limit : null;
  const low = rule?.enabled ? rule.low_limit : null;
  const points: ChartPoint[] = (rows ?? []).map((r) => ({ t: new Date(r.recorded_at).getTime(), temp: r.temp, hum: r.hum }));
  const temps = (rows ?? []).map((r) => r.temp).filter((t): t is number => t != null);
  const stats = computeStats(temps, high, low);
  const hasHum = (rows ?? []).some((r) => validHum(r.hum));
  const rangeText = range === 'custom' && custom ? `${formatDate(custom.from)} → ${formatDate(custom.to)}`
    : RANGES.find((r) => r.value === range)?.label ?? '';
  const batteryType = sensor.battery_type || 'lithium';

  // ── actions ────────────────────────────────────────────────────────────────
  async function rename() {
    const name = draft.trim();
    if (!name) return;
    setBusy('rename');
    try {
      await api.renameSensor(sensor!.id, name);
      store.patchSensor(sensor!.id, { name });
      setSheet(null);
      toast.success('Sensor renamed');
    } catch (err) { toast.error(api.errText(err, 'Failed to rename')); }
    finally { setBusy(null); }
  }

  // Which cells are in the holder decides which pack voltage the % is read
  // from (backend/src/battery.js); the backend recomputes and returns it.
  async function setType(type: 'lithium' | 'alkaline') {
    if (type === batteryType) return;
    setBusy('battery');
    try {
      const res = await api.setBatteryType(sensor!.id, type);
      store.patchSensor(sensor!.id, { battery_type: type });
      if (res.data.battery != null) store.setReading(sensor!.mac, { battery: res.data.battery });
      toast.success(`Battery type: ${BATTERY_TYPE_LABEL[type]}`);
    } catch { toast.error('Failed to change battery type'); }
    finally { setBusy(null); }
  }

  // A sleeping node can't be woken on demand: this extends a wake it was going
  // to have anyway, so the wait is up to one reporting interval.
  async function startLive() {
    setBusy('live');
    try {
      const res = await api.requestLive(sensor!.id);
      store.patchSensor(sensor!.id, { live_requested_at: new Date().toISOString() });
      const mins = Math.round((res.data.starts_within_secs || 900) / 60);
      const n = Math.round(res.data.duration_s / res.data.interval_s);
      setLiveNote(`Queued — ${n} readings, one every ${res.data.interval_s}s. Starts on the sensor's next wake (up to ~${mins} min), or press its button to start now.`);
    } catch { setLiveNote('Live request failed.'); }
    finally { setBusy(null); }
  }

  async function endLive() {
    setBusy('live');
    try {
      await api.stopLive(sensor!.id);
      store.patchSensor(sensor!.id, { live_until: null, live_requested_at: null });
      store.clearLiveSeen(sensor!.mac);
      setLiveNote('Stopped.');
    } catch { setLiveNote('Stop failed.'); }
    finally { setBusy(null); }
  }

  async function remove() {
    const ok = await confirm({
      title: 'Remove sensor?',
      message: `"${sensorLabel(sensor!)}" and all its readings will be permanently deleted.`,
      confirmLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await api.deleteSensor(sensor!.id);
      navigation.goBack();
      store.removeSensor(sensor!.id);
      toast.success('Sensor removed');
    } catch { toast.error('Failed to remove sensor'); setBusy(null); }
  }

  async function exportCsv() {
    setBusy('csv');
    try {
      const { text, filename } = await api.getCsv(`/sensors/${sensor!.id}/readings/export.csv`,
        { from: win.from.toISOString(), to: win.to.toISOString() });
      const saved = await saveCsv(text, filename ?? `${sensorLabel(sensor!)}-readings.csv`);
      if (saved) toast.success(saved);
    } catch { toast.error('Export failed — try again'); }
    finally { setBusy(null); }
  }

  async function exportPdf() {
    if (!rows) return;
    setBusy('pdf');
    try {
      const statItems = stats ? [
        { label: 'Min', value: `${stats.min.toFixed(1)}°` }, { label: 'Max', value: `${stats.max.toFixed(1)}°` },
        { label: 'Avg', value: `${stats.avg.toFixed(1)}°` }, { label: 'MKT', value: `${stats.mkt.toFixed(1)}°` },
        ...(stats.inRange != null ? [{ label: 'In range', value: `${stats.inRange.toFixed(1)}%`, alarm: stats.inRange < 100 }] : []),
      ] : [];
      const chart = chartSvg(points.filter((p) => p.temp != null).map((p) => ({ t: p.t, v: p.temp as number })), high, low);
      const table = tableHtml(
        ['#', 'Time', 'Temp °C', ...(hasHum ? ['RH %'] : []), 'RSSI', 'Battery'],
        [...rows].reverse().map((r, i) => [
          rows.length - i, formatDateTime(r.recorded_at), r.temp != null ? r.temp.toFixed(2) : null,
          ...(hasHum ? [validHum(r.hum) ? r.hum.toFixed(1) : null] : []),
          r.rssi != null ? `${r.rssi} dBm` : null, r.battery != null && r.battery !== 255 ? `${r.battery}%` : null,
        ]));
      const html = reportHtml('Temperature history report',
        `${sensorLabel(sensor!)} · ${sensor!.mac}${sensor!.hub_name ? ` · Hub: ${sensor!.hub_name}` : ''} · Range: ${rangeText}${limits ? ` · Limits: ${limits}` : ''}`,
        statsHtml(statItems) + chart + table);
      const saved = await savePdf(html, `${sensorLabel(sensor!)}-report.pdf`);
      if (saved) toast.success(saved);
    } catch { toast.error("Couldn't create the PDF"); }
    finally { setBusy(null); }
  }

  const t = fmt(reading?.temp);
  const actions: { key: string; icon: IconName; label: string; onPress: () => void; show: boolean; danger?: boolean }[] = [
    { key: 'rename', icon: 'edit-2', label: 'Rename', show: canEdit, onPress: () => { setDraft(sensor.name || ''); setSheet('rename'); } },
    { key: 'rule', icon: 'bell', label: rule ? 'Alert rule' : 'Add alert', show: canEdit, onPress: () => setSheet('rule') },
    { key: 'live', icon: live.isLive || live.livePending ? 'stop-circle' : 'radio', label: live.isLive ? 'Stop live' : live.livePending ? 'Cancel live' : 'Live mode', show: canEdit, onPress: live.isLive || live.livePending ? endLive : startLive },
    { key: 'config', icon: 'sliders', label: 'Calibration', show: isSuperadmin, onPress: () => setSheet('config') },
    { key: 'delete', icon: 'trash-2', label: 'Remove', show: canEdit, danger: true, onPress: remove },
  ];

  return (
    <Screen>
      <Card tone={alert ? 'alarm' : undefined}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="caption" numberOfLines={1} style={{ flex: 1 }}>{sensor.hub_name || sensor.hub_mac} · {sensor.mac}</T>
          <Chip tone={chip.tone} label={chip.label} />
        </Row>
        <View style={styles.bigRow}>
          <Text style={[styles.big, !!alert && { color: C.alarm }, t == null && { color: C.ink3 }]}>{t ?? '--'}</Text>
          {t != null && <Text style={styles.bigUnit}>°C</Text>}
          {validHum(reading?.hum) && <Text style={styles.hum}>RH {fmt(reading!.hum, 0)}%</Text>}
        </View>
        <Row gap={6} style={{ flexWrap: 'wrap' }}>
          {limits ? <Chip tone="plain" icon="bell" label={limits} /> : <Chip tone="plain" label="No alert rule" />}
          <LiveChips sensor={sensor} reading={reading} liveSeenAt={store.liveSeen[sensor.mac] ?? 0} />
        </Row>
        <View style={styles.metaGrid}>
          <Meta icon="clock" text={timeAgo(reading?.recorded_at)} />
          {reading?.rssi != null && <Meta icon="wifi" text={`${reading.rssi} dBm`} />}
          {sensor.fw_version ? <Meta icon="cpu" text={`v${sensor.fw_version}`} /> : null}
        </View>
        <View style={{ marginTop: S.sm }}><BatteryLine reading={reading} type={batteryType} /></View>
        <Row style={{ marginTop: S.md, justifyContent: 'space-between' }}>
          <T v="small">Batteries</T>
          {canEdit ? (
            <Segmented
              style={{ width: 190, opacity: busy === 'battery' ? 0.5 : 1 }}
              value={batteryType}
              onChange={(v) => setType(v as 'lithium' | 'alkaline')}
              options={[{ value: 'lithium', label: 'Lithium' }, { value: 'alkaline', label: 'Alkaline' }]}
            />
          ) : <T v="body">{BATTERY_TYPE_LABEL[batteryType]}</T>}
        </Row>
      </Card>

      {actions.some((a) => a.show) && (
        <View style={styles.actions}>
          {actions.filter((a) => a.show).map((a) => (
            <Pressable key={a.key} onPress={a.onPress} disabled={busy === a.key}
              style={({ pressed }) => [styles.action, pressed && { opacity: 0.7 }, busy === a.key && { opacity: 0.5 }]}>
              <Icon name={a.icon} size={18} color={a.danger ? C.alarmDeep : C.ice} />
              <Text style={[styles.actionText, a.danger && { color: C.alarmDeep }]} numberOfLines={1}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {liveNote ? <View style={{ marginTop: S.sm }}><Notice tone="ice" icon="radio">{liveNote}</Notice></View> : null}

      <Section title="History" right={<T v="caption">{rangeText}</T>}>
        <Segmented
          value={range}
          onChange={(v) => { if (v === 'custom') setSheet('range'); else setRange(v); }}
          options={RANGES}
        />
        <Card style={{ marginTop: S.sm, paddingHorizontal: S.sm }}>
          {histErr ? <Notice tone="alarm">{histErr}</Notice>
            : rows == null ? <Loading label="Loading chart data…" />
            : rows.length === 0 ? <Empty icon="bar-chart-2" title="No readings" body="No data for the selected range." />
            : <TempChart points={points} high={high} low={low} />}
        </Card>
        {stats && (
          <View style={styles.stats}>
            <Stat label="Min" value={`${stats.min.toFixed(1)}°`} />
            <Stat label="Max" value={`${stats.max.toFixed(1)}°`} />
            <Stat label="Avg" value={`${stats.avg.toFixed(1)}°`} />
            <Stat label="MKT" value={`${stats.mkt.toFixed(1)}°`} />
            {stats.inRange != null && <Stat label="In range" value={`${stats.inRange.toFixed(1)}%`} tone={stats.inRange < 100 ? 'amber' : 'ok'} />}
          </View>
        )}
        {stats && <T v="caption" style={{ marginTop: 6 }}>MKT is the mean kinetic temperature — the Arrhenius-weighted average used for cold-chain compliance.</T>}
        <Row style={{ marginTop: S.md }}>
          <Button label="Export CSV" icon="download" small onPress={exportCsv} busy={busy === 'csv'} />
          <Button label="PDF report" icon="file-text" small onPress={exportPdf} busy={busy === 'pdf'} disabled={!rows?.length} />
        </Row>
      </Section>

      {rows && rows.length > 0 && (
        <Section title={`Readings · ${rows.length}`}>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <View style={[styles.tr, styles.th]}>
              <Text style={[styles.tdTime, styles.thText]}>Time</Text>
              <Text style={[styles.td, styles.thText]}>°C</Text>
              {hasHum && <Text style={[styles.td, styles.thText]}>RH</Text>}
              <Text style={[styles.td, styles.thText]}>RSSI</Text>
              <Text style={[styles.td, styles.thText]}>Bat</Text>
            </View>
            {[...rows].reverse().slice(0, shown).map((r, i) => (
              <View key={r.id ?? r.recorded_at} style={[styles.tr, i % 2 === 1 && { backgroundColor: C.page }]}>
                <Text style={styles.tdTime}>{formatDateTime(r.recorded_at)}</Text>
                <Text style={[styles.td, { color: C.ink, fontFamily: F.monoMedium }]}>{r.temp != null ? r.temp.toFixed(2) : '—'}</Text>
                {hasHum && <Text style={styles.td}>{validHum(r.hum) ? r.hum.toFixed(1) : '—'}</Text>}
                <Text style={styles.td}>{r.rssi ?? '—'}</Text>
                <Text style={styles.td}>{r.battery != null && r.battery !== 255 ? `${r.battery}%` : '—'}</Text>
              </View>
            ))}
          </Card>
          {shown < rows.length && (
            <Button label={`Show ${Math.min(TABLE_PAGE, rows.length - shown)} more`} variant="ghost" small style={{ alignSelf: 'center', marginTop: S.sm }}
              onPress={() => setShown((n) => n + TABLE_PAGE)} />
          )}
        </Section>
      )}

      <Sheet visible={sheet === 'rename'} onClose={() => setSheet(null)} title="Rename sensor" subtitle={sensor.mac}
        footer={<><Button label="Cancel" small onPress={() => setSheet(null)} /><Button label="Save" variant="primary" small busy={busy === 'rename'} onPress={rename} /></>}>
        <Field label="Name" value={draft} onChangeText={setDraft} maxLength={64} autoFocus onSubmitEditing={rename} returnKeyType="done" />
      </Sheet>
      <AlertRuleSheet visible={sheet === 'rule'} onClose={() => setSheet(null)} sensor={sensor} onSaved={store.setRule} />
      {isSuperadmin && <SensorConfigSheet visible={sheet === 'config'} onClose={() => setSheet(null)} sensor={sensor} />}
      <DateRangeSheet visible={sheet === 'range'} onClose={() => setSheet(null)} initial={custom}
        onApply={(from, to) => { setCustom({ from, to }); setRange('custom'); }} />
    </Screen>
  );
}

function Meta({ icon, text }: { icon: IconName; text: string }) {
  return (
    <Row gap={5}>
      <Icon name={icon} size={13} color={C.ink3} />
      <Text style={styles.metaText}>{text}</Text>
    </Row>
  );
}

const styles = StyleSheet.create({
  bigRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: S.sm, marginBottom: S.sm },
  big: { fontFamily: F.monoMedium, fontSize: 56, color: C.ink, letterSpacing: -2, lineHeight: 64 },
  bigUnit: { fontFamily: F.mono, fontSize: 18, color: C.ink2, marginTop: 10, marginLeft: 4 },
  hum: { fontFamily: F.mono, fontSize: 14, color: C.ink2, marginTop: 14, marginLeft: 'auto' },
  metaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: S.lg, marginTop: S.md },
  metaText: { fontFamily: F.mono, fontSize: 12, color: C.ink2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm, marginTop: S.md },
  action: { flexGrow: 1, flexBasis: 90, backgroundColor: C.surface, borderRadius: R.control, paddingVertical: 12, alignItems: 'center', gap: 4 },
  actionText: { fontFamily: F.medium, fontSize: 12, color: C.ink },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm, marginTop: S.sm },
  tr: { flexDirection: 'row', paddingHorizontal: S.md, paddingVertical: 7, alignItems: 'center' },
  th: { borderBottomWidth: 1, borderBottomColor: C.line },
  thText: { fontFamily: F.medium, color: C.ink3, fontSize: 11 },
  tdTime: { flex: 2.6, fontFamily: F.mono, fontSize: 11, color: C.ink2 },
  td: { flex: 1, fontFamily: F.mono, fontSize: 11, color: C.ink2, textAlign: 'right' },
});
