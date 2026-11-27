import React, { useCallback, useEffect, useState } from 'react';
import { View, TextInput, StyleSheet } from 'react-native';
import { Screen, PageHeader, Section, Card, T, Row, Chip, Button, Empty, Loading, ErrorState, Toggle, Notice, Divider } from '../ui';
import { confirm, useToast } from '../ui/feedback';
import AlertRuleSheet from '../components/AlertRuleSheet';
import { useOrgData } from '../store/OrgData';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import { sensorLabel } from '../utils/sensor';
import type { Sensor, AlertRule, HealthSettings } from '../types';
import { C, F, R, S } from '../theme';

function conditionText(rule: AlertRule) {
  const parts: string[] = [];
  if (rule.high_limit != null) parts.push(`above ${rule.high_limit} °C`);
  if (rule.low_limit != null) parts.push(`below ${rule.low_limit} °C`);
  return parts.join(' or ');
}
const channelText = (ch: string[]) => ch.filter((c) => c !== 'whatsapp').map((c) => (c === 'push' ? 'Push' : 'Dashboard')).join(' + ');

/** Alert rules for every sensor, plus the org-wide device health alerts. (AlertRules.jsx) */
export default function AlertsScreen() {
  const toast = useToast();
  const { canEdit } = useAuth();
  const { sensors, rules, alerts, loading, error, refresh, setRule } = useOrgData();
  const [sheet, setSheet] = useState<{ sensor: Sensor | null } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => { setRefreshing(true); await refresh(); setRefreshing(false); };

  async function togglePause(s: Sensor) {
    const rule = rules[s.id];
    if (!rule) return;
    try {
      const { data } = await api.saveAlertRule(s.id, {
        high_limit: rule.high_limit, low_limit: rule.low_limit, hysteresis: rule.hysteresis,
        channels: rule.channels, cooldown_s: rule.cooldown_s, enabled: !rule.enabled,
      });
      setRule(s.id, data ?? { ...rule, enabled: !rule.enabled });
    } catch { toast.error('Failed to update rule'); }
  }

  async function removeRule(s: Sensor) {
    const ok = await confirm({ title: 'Remove alert rule?', message: `"${sensorLabel(s)}" will no longer trigger temperature alerts.`, confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try { await api.deleteAlertRule(s.id); setRule(s.id, null); toast.success('Alert rule removed'); }
    catch { toast.error('Failed to remove rule'); }
  }

  const withRules = sensors.filter((s) => rules[s.id]);
  const firing = withRules.filter((s) => alerts[s.mac] && rules[s.id].enabled).length;
  const header = <PageHeader title="Alerts" subtitle={loading ? undefined : `${withRules.length} rule${withRules.length !== 1 ? 's' : ''} · ${firing} firing`}
    right={canEdit && sensors.length > 0 ? <Button label="New rule" icon="plus" variant="primary" small onPress={() => setSheet({ sensor: null })} /> : undefined} />;

  if (loading) return <View style={{ flex: 1, backgroundColor: C.page }}>{header}<Loading /></View>;
  if (error) return <View style={{ flex: 1, backgroundColor: C.page }}>{header}<ErrorState message={error} onRetry={refresh} /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      {header}
      <Screen refreshing={refreshing} onRefresh={onRefresh} style={{ paddingTop: S.sm }}>
        <Section title="Temperature rules" style={{ marginTop: S.sm }}>
          {sensors.length === 0 ? (
            <Card><Empty icon="bell" title="No sensors" body="Pair a sensor first, then set its temperature limits here." /></Card>
          ) : sensors.map((s) => {
            const rule = rules[s.id];
            const status = !rule ? null : alerts[s.mac] && rule.enabled ? { l: 'Firing', t: 'alarm' as const }
              : rule.enabled ? { l: 'Armed', t: 'ice' as const } : { l: 'Paused', t: 'muted' as const };
            return (
              <Card key={s.id} tone={status?.t === 'alarm' ? 'alarm' : undefined} style={{ marginBottom: S.sm }}>
                <Row style={{ alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <T v="h3">{sensorLabel(s)}</T>
                    <T v="caption">{s.hub_name || s.hub_mac}</T>
                  </View>
                  {status && <Chip tone={status.t} label={status.l} />}
                </Row>
                {rule ? (
                  <View style={{ marginTop: S.sm }}>
                    <T v="mono" style={{ fontSize: 13 }}>{conditionText(rule)}</T>
                    <T v="caption">Notify: {channelText(rule.channels) || '—'} · recovery margin {rule.hysteresis}°</T>
                  </View>
                ) : <T v="small" style={{ marginTop: S.sm, color: C.ink3 }}>No rule</T>}
                {canEdit && (
                  <Row style={{ marginTop: S.md, flexWrap: 'wrap' }}>
                    {rule ? (
                      <>
                        <Button label={rule.enabled ? 'Pause' : 'Arm'} icon={rule.enabled ? 'pause' : 'play'} small onPress={() => togglePause(s)} />
                        <Button label="Edit" icon="edit-2" small onPress={() => setSheet({ sensor: s })} />
                        <Button label="Remove" variant="danger" small onPress={() => removeRule(s)} />
                      </>
                    ) : <Button label="Add rule" icon="plus" small onPress={() => setSheet({ sensor: s })} />}
                  </Row>
                )}
              </Card>
            );
          })}
        </Section>

        <HealthPanel canEdit={canEdit} />
      </Screen>
      <AlertRuleSheet
        visible={!!sheet} onClose={() => setSheet(null)} sensor={sheet?.sensor ?? null}
        sensors={sheet && !sheet.sensor ? sensors : undefined} rules={rules} onSaved={setRule}
      />
    </View>
  );
}

/** Org-wide device health alerts: offline sensors/hubs, low battery, escalation. */
function HealthPanel({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const [h, setH] = useState<HealthSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(() => { api.getHealthSettings().then((r) => setH(r.data)).catch(() => {}); }, []);
  useEffect(load, [load]);
  if (!h) return null;

  const set = (patch: Partial<HealthSettings>) => { setH({ ...h, ...patch }); setDirty(true); };

  async function save() {
    setSaving(true);
    try {
      const { data } = await api.saveHealthSettings({
        sensor_offline_enabled: !!h!.sensor_offline_enabled,
        sensor_offline_minutes: parseInt(String(h!.sensor_offline_minutes), 10),
        hub_offline_enabled: !!h!.hub_offline_enabled,
        hub_offline_minutes: parseInt(String(h!.hub_offline_minutes), 10),
        low_battery_enabled: !!h!.low_battery_enabled,
        escalation_enabled: !!h!.escalation_enabled,
        escalation_minutes: parseInt(String(h!.escalation_minutes), 10),
      });
      setH(data); setDirty(false);
      toast.success('Health alerts saved');
    } catch (err) { toast.error(api.errText(err, 'Failed to save')); }
    finally { setSaving(false); }
  }

  return (
    <Section title="Device health alerts" right={canEdit && dirty ? <Button label="Save" variant="primary" small busy={saving} onPress={save} /> : undefined}>
      <Card>
        {!canEdit && <Notice tone="ice">Only editors can change these.</Notice>}
        <Toggle label="Sensor offline" value={!!h.sensor_offline_enabled} disabled={!canEdit} onChange={(v) => set({ sensor_offline_enabled: v })} />
        <Minutes label="No reading for" value={h.sensor_offline_minutes} disabled={!canEdit || !h.sensor_offline_enabled} onChange={(v) => set({ sensor_offline_minutes: v })} />
        <Divider style={{ marginVertical: 4 }} />
        <Toggle label="Hub offline" value={!!h.hub_offline_enabled} disabled={!canEdit} onChange={(v) => set({ hub_offline_enabled: v })} />
        <Minutes label="Grace" value={h.hub_offline_minutes} disabled={!canEdit || !h.hub_offline_enabled} onChange={(v) => set({ hub_offline_minutes: v })} />
        <Divider style={{ marginVertical: 4 }} />
        <Toggle label="Low battery" hint="Notify when a pack runs low" value={!!h.low_battery_enabled} disabled={!canEdit} onChange={(v) => set({ low_battery_enabled: v })} />
        <Divider style={{ marginVertical: 4 }} />
        <Toggle label="Unacknowledged alarm" hint="Re-notify until someone acknowledges" value={!!h.escalation_enabled} disabled={!canEdit} onChange={(v) => set({ escalation_enabled: v })} />
        <Minutes label="Re-notify every" value={h.escalation_minutes ?? 30} disabled={!canEdit} onChange={(v) => set({ escalation_minutes: v })} />
        <T v="caption">Sensor offline 5–1440 min · hub grace 1–1440 min · re-notify 5–1440 min.</T>
      </Card>
    </Section>
  );
}

function Minutes({ value, onChange, disabled, label }: { value: number | string; onChange: (v: string) => void; disabled: boolean; label: string }) {
  return (
    <Row gap={6} style={{ paddingLeft: 2, paddingBottom: S.sm }}>
      <T v="small">{label}</T>
      <TextInput value={String(value ?? '')} onChangeText={onChange} editable={!disabled} keyboardType="number-pad"
        style={[styles.num, disabled && { color: C.ink3, backgroundColor: C.inset }]} />
      <T v="small">min</T>
    </Row>
  );
}

const styles = StyleSheet.create({
  num: { width: 64, textAlign: 'center', fontFamily: F.monoMedium, fontSize: 14, color: C.ink, backgroundColor: C.page, borderRadius: R.control, borderWidth: 1, borderColor: C.line, paddingVertical: 6 },
});
