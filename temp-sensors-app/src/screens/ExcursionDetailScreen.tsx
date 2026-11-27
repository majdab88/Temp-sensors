import React, { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Screen, Card, T, Row, Button, Loading, ErrorState, Stat, KV, Chip } from '../ui';
import { useToast } from '../ui/feedback';
import { BreachChart } from '../components/charts';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import { saveCsv, savePdf, reportHtml, statsHtml, tableHtml, chartSvg } from '../services/export';
import { formatDayMonthTime, formatDuration, formatDateTime, formatDateTimeShort } from '../utils/time';
import type { ScreenProps } from '../navigation/types';
import type { Excursion } from '../types';
import { C, S } from '../theme';

type Data = { excursion: Excursion; readings: { recorded_at: string; temp: number | null; hum: number | null }[] };
const PAD_MS = 30 * 60 * 1000;

/** One excursion: the breach window in context (± 30 min), ack, exports. (ExcursionDetail.jsx) */
export default function ExcursionDetailScreen({ route, navigation }: ScreenProps<'ExcursionDetail'>) {
  const { id } = route.params;
  const toast = useToast();
  const { canEdit } = useAuth();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.getExcursion(id).then((r) => { setData(r.data); setError(null); }).catch(() => setError('Excursion not found'));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (data) navigation.setOptions({ title: data.excursion.sensor_name || data.excursion.sensor_mac });
  }, [data, navigation]);

  if (error) return <Screen><ErrorState message={error} onRetry={load} /></Screen>;
  if (!data) return <Screen><Loading label="Loading excursion…" /></Screen>;

  const ex = data.excursion;
  const ongoing = !ex.ended_at;
  const peak = ex.peak_value != null ? `${Number(ex.peak_value).toFixed(1)}°` : '—';
  const limit = ex.limit_value != null ? `${Number(ex.limit_value).toFixed(1)}°` : '—';

  async function ack() {
    setBusy('ack');
    try {
      const res = await api.ackExcursion(id);
      setData((d) => d && ({ ...d, excursion: { ...d.excursion, ack_at: res.data.ack_at, ack_by: res.data.ack_by } }));
      toast.success('Excursion acknowledged');
    } catch { toast.error('Failed to acknowledge — try again'); }
    finally { setBusy(null); }
  }

  async function exportCsv() {
    setBusy('csv');
    try {
      const from = new Date(new Date(ex.started_at).getTime() - PAD_MS).toISOString();
      const to = new Date((ex.ended_at ? new Date(ex.ended_at).getTime() : Date.now()) + PAD_MS).toISOString();
      const { text } = await api.getCsv(`/sensors/${ex.sensor_id}/readings/export.csv`, { from, to });
      const saved = await saveCsv(text, `excursion-${id}-readings.csv`);
      if (saved) toast.success(saved);
    } catch { toast.error('Export failed — try again'); }
    finally { setBusy(null); }
  }

  async function exportPdf() {
    setBusy('pdf');
    try {
      const pts = data!.readings.filter((r) => r.temp != null).map((r) => ({ t: new Date(r.recorded_at).getTime(), v: r.temp as number }));
      const html = reportHtml(`${ex.kind === 'high' ? 'Over' : 'Under'}-temperature excursion`,
        `${ex.sensor_name || ex.sensor_mac} · ${ex.hub_name || ex.hub_mac}`,
        statsHtml([{ label: 'Peak', value: peak, alarm: true }, { label: 'Limit', value: limit }, { label: ongoing ? 'Ongoing' : 'Duration', value: ongoing ? '—' : formatDuration(ex.duration_s) }]) +
        tableHtml(['Started', 'Ended', 'Acknowledged'], [[
          formatDateTime(ex.started_at), ex.ended_at ? formatDateTime(ex.ended_at) : 'ongoing',
          ex.ack_at ? `${ex.ack_by || 'yes'} · ${formatDateTime(ex.ack_at)}${ex.ack_note ? ` — ${ex.ack_note}` : ''}` : 'no',
        ]]) +
        chartSvg(pts, ex.kind === 'high' ? ex.limit_value : null, ex.kind === 'low' ? ex.limit_value : null) +
        tableHtml(['Time', 'Temp °C'], data!.readings.map((r) => [formatDateTimeShort(r.recorded_at), r.temp != null ? r.temp.toFixed(2) : null])));
      const saved = await savePdf(html, `excursion-${id}.pdf`);
      if (saved) toast.success(saved);
    } catch { toast.error("Couldn't create the PDF"); }
    finally { setBusy(null); }
  }

  return (
    <Screen>
      <Row style={{ justifyContent: 'space-between' }}>
        <T v="small">{ex.kind === 'high' ? 'Over-temperature' : 'Under-temperature'} · {ex.hub_name || ex.hub_mac}</T>
        {ongoing && <Chip tone="alarm" label="Ongoing" />}
      </Row>
      <View style={styles.stats}>
        <Stat label="Peak" value={peak} tone={ongoing ? 'alarm' : undefined} />
        <Stat label="Limit" value={limit} />
        <Stat label={ongoing ? 'Ongoing' : 'Duration'} value={ongoing ? '—' : formatDuration(ex.duration_s)} />
      </View>
      <Card style={{ marginTop: S.md, paddingHorizontal: S.sm }}>
        <BreachChart readings={data.readings} startedAt={ex.started_at} endedAt={ex.ended_at} limit={ex.limit_value} kind={ex.kind} />
      </Card>
      <Card style={{ marginTop: S.md }}>
        <KV k="Started" v={formatDayMonthTime(ex.started_at)} mono />
        <KV k="Ended" v={ex.ended_at ? formatDayMonthTime(ex.ended_at) : 'ongoing'} mono />
        <KV k="Status" v={ex.ack_at
          ? <T v="small" style={{ color: C.ok, textAlign: 'right' }}>✓ {ex.ack_by || 'acknowledged'} · {formatDayMonthTime(ex.ack_at)}</T>
          : <T v="small" style={{ color: C.amber }}>Unacknowledged</T>} />
        {ex.ack_note ? <KV k="Note" v={ex.ack_note} /> : null}
      </Card>
      <Row style={{ marginTop: S.lg, flexWrap: 'wrap' }}>
        {canEdit && !ex.ack_at && <Button label="Acknowledge" variant="primary" icon="check" onPress={ack} busy={busy === 'ack'} />}
        <Button label="Readings CSV" icon="download" small onPress={exportCsv} busy={busy === 'csv'} />
        <Button label="PDF" icon="download" small onPress={exportPdf} busy={busy === 'pdf'} />
      </Row>
    </Screen>
  );
}

const styles = StyleSheet.create({ stats: { flexDirection: 'row', gap: S.sm, marginTop: S.md } });
