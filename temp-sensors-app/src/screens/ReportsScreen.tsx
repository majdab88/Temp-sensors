import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Screen, PageHeader, Card, T, Row, Chip, Button, Empty, Loading, ErrorState, Segmented, Picker, Stat } from '../ui';
import { useToast } from '../ui/feedback';
import { useOrgData } from '../store/OrgData';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import { saveCsv, savePdf, reportHtml, statsHtml, tableHtml } from '../services/export';
import { formatDayMonthTime, formatDuration, formatDateTimeShort } from '../utils/time';
import { sensorLabel } from '../utils/sensor';
import type { Excursion } from '../types';
import type { RootStackParamList } from '../navigation/types';
import { C, F, S } from '../theme';

const RANGES: { value: number; label: string }[] = [
  { value: 7, label: '7 d' }, { value: 30, label: '30 d' }, { value: 90, label: '90 d' }, { value: 0, label: 'All' },
];
type Status = 'all' | 'active' | 'unacked';

/** Excursion log — every limit breach, for compliance and sign-off. (Reports.jsx) */
export default function ReportsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const toast = useToast();
  const { canEdit } = useAuth();
  const { sensors } = useOrgData();
  const [sensorId, setSensorId] = useState<number>(0);
  const [status, setStatus] = useState<Status>('all');
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<Excursion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acking, setAcking] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const filter = useCallback((): api.ExcursionFilter => ({
    ...(sensorId ? { sensor_id: sensorId } : {}),
    ...(status === 'active' ? { active: 'true' as const } : {}),
    ...(status === 'unacked' ? { unacked: 'true' as const } : {}),
    ...(days ? { from: new Date(Date.now() - days * 86400000).toISOString() } : {}),
  }), [sensorId, status, days]);

  const load = useCallback(async () => {
    try { setRows((await api.getExcursions(filter())).data); setError(null); }
    catch { setError('Failed to load excursion log'); }
  }, [filter]);

  useEffect(() => { setRows(null); load(); }, [load]);

  async function ack(id: number) {
    setAcking(id);
    try {
      const { data } = await api.ackExcursion(id);
      setRows((p) => p?.map((r) => (r.id === id ? { ...r, ack_at: data.ack_at, ack_by: data.ack_by } : r)) ?? p);
      toast.success('Excursion acknowledged');
    } catch { toast.error('Failed to acknowledge — try again'); }
    finally { setAcking(null); }
  }

  async function exportCsv() {
    setBusy('csv');
    try {
      const { text, filename } = await api.getCsv('/excursions/export.csv', filter());
      const saved = await saveCsv(text, filename ?? 'excursions.csv');
      if (saved) toast.success(saved);
    } catch { toast.error('Export failed — try again'); }
    finally { setBusy(null); }
  }

  async function exportPdf() {
    if (!rows) return;
    setBusy('pdf');
    try {
      const sensorName = sensorId ? sensorLabel(sensors.find((s) => s.id === sensorId) ?? { mac: String(sensorId) }) : 'All sensors';
      const html = reportHtml('Excursion log',
        `${sensorName} · ${status === 'all' ? 'All' : status === 'active' ? 'Ongoing' : 'Unacknowledged'} · ${RANGES.find((r) => r.value === days)?.label}`,
        statsHtml([
          { label: 'Excursions', value: String(rows.length) },
          { label: 'Ongoing', value: String(activeCount), alarm: activeCount > 0 },
          { label: 'Unacknowledged', value: String(unackedCount) },
        ]) + tableHtml(['Sensor', 'Hub', 'Type', 'Started', 'Duration', 'Peak', 'Limit', 'Acknowledged'],
          rows.map((r) => [
            r.sensor_name || r.sensor_mac, r.hub_name || r.hub_mac, r.kind === 'high' ? 'Over' : 'Under',
            formatDateTimeShort(r.started_at), r.ended_at ? formatDuration(r.duration_s) : 'ongoing',
            r.peak_value != null ? `${Number(r.peak_value).toFixed(1)}°` : null,
            r.limit_value != null ? `${Number(r.limit_value).toFixed(1)}°` : null,
            r.ack_at ? `${r.ack_by || 'yes'} · ${formatDateTimeShort(r.ack_at)}` : 'no',
          ])));
      const saved = await savePdf(html, 'excursion-log.pdf');
      if (saved) toast.success(saved);
    } catch { toast.error("Couldn't create the PDF"); }
    finally { setBusy(null); }
  }

  const activeCount = rows?.filter((r) => !r.ended_at).length ?? 0;
  const unackedCount = rows?.filter((r) => !r.ack_at).length ?? 0;

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      <PageHeader title="Reports" subtitle="Excursion log — every limit breach, for sign-off" />
      <Screen refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} style={{ paddingTop: S.sm }}>
        <View style={styles.stats}>
          <Stat label="Excursions" value={rows ? String(rows.length) : '–'} />
          <Stat label="Ongoing" value={rows ? String(activeCount) : '–'} tone={activeCount ? 'alarm' : undefined} />
          <Stat label="Unacked" value={rows ? String(unackedCount) : '–'} tone={unackedCount ? 'amber' : undefined} />
        </View>

        <View style={{ marginTop: S.lg }}>
          <Picker label="Sensor" value={sensorId} onChange={setSensorId}
            options={[{ value: 0, label: 'All sensors' }, ...sensors.map((s) => ({ value: s.id, label: sensorLabel(s), sub: s.hub_name ?? undefined }))]} />
          <Segmented value={status} onChange={setStatus}
            options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Ongoing' }, { value: 'unacked', label: 'Unacknowledged' }]} />
          <Segmented style={{ marginTop: S.sm }} value={days} onChange={setDays} options={RANGES} />
          <Row style={{ marginTop: S.md }}>
            <Button label="Export CSV" icon="download" small onPress={exportCsv} busy={busy === 'csv'} disabled={!rows?.length} />
            <Button label="PDF" icon="file-text" small onPress={exportPdf} busy={busy === 'pdf'} disabled={!rows?.length} />
          </Row>
        </View>

        <View style={{ marginTop: S.lg }}>
          {error ? <ErrorState message={error} onRetry={load} />
            : rows == null ? <Loading label="Loading excursion log…" />
            : rows.length === 0 ? <Card><Empty icon="check-circle" title="No excursions" body="No limit breaches recorded for this filter — that's a good thing." /></Card>
            : rows.map((r) => {
              const ongoing = !r.ended_at;
              return (
                <Pressable key={r.id} onPress={() => nav.navigate('ExcursionDetail', { id: r.id })}>
                  {({ pressed }) => (
                    <Card tone={ongoing ? 'alarm' : undefined} style={[{ marginBottom: S.sm }, pressed && { opacity: 0.8 }]}>
                      <Row style={{ alignItems: 'flex-start' }}>
                        <View style={{ flex: 1 }}>
                          <T v="h3">{r.sensor_name || r.sensor_mac}</T>
                          <T v="caption">{r.hub_name || r.hub_mac}</T>
                        </View>
                        <Chip tone={ongoing ? 'alarm' : 'plain'} label={`${r.kind === 'high' ? 'Over' : 'Under'}${ongoing ? ' · ongoing' : ''}`} />
                      </Row>
                      <Row gap={S.lg} style={{ marginTop: S.md }}>
                        <Fact k="Started" v={formatDayMonthTime(r.started_at)} />
                        <Fact k="Duration" v={ongoing ? '—' : formatDuration(r.duration_s)} />
                        <Fact k="Peak" v={r.peak_value != null ? `${Number(r.peak_value).toFixed(1)}°` : '—'} alarm={ongoing} />
                        <Fact k="Limit" v={r.limit_value != null ? `${Number(r.limit_value).toFixed(1)}°` : '—'} />
                      </Row>
                      <Row style={{ marginTop: S.md, justifyContent: 'space-between' }}>
                        {r.ack_at ? <T v="small" style={{ color: C.ok }}>✓ {r.ack_by || 'acknowledged'}</T>
                          : canEdit ? <Button label="Acknowledge" variant="primary" small busy={acking === r.id} onPress={() => ack(r.id)} />
                          : <T v="small" style={{ color: C.amber }}>Unacknowledged</T>}
                        <T v="caption">Details ›</T>
                      </Row>
                    </Card>
                  )}
                </Pressable>
              );
            })}
        </View>
      </Screen>
    </View>
  );
}

function Fact({ k, v, alarm }: { k: string; v: string; alarm?: boolean }) {
  return (
    <View>
      <T v="caption">{k}</T>
      <Text style={{ fontFamily: F.monoMedium, fontSize: 13, color: alarm ? C.alarm : C.ink }}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({ stats: { flexDirection: 'row', gap: S.sm } });
