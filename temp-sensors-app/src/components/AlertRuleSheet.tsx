import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Sheet, Field, Toggle, Button, Notice, Loading, Row, T, Picker } from '../ui';
import { confirm, useToast } from '../ui/feedback';
import * as api from '../services/api';
import type { Sensor, AlertRule } from '../types';
import { sensorLabel } from '../utils/sensor';
import { S } from '../theme';

// Channels the backend delivers today. WhatsApp exists only as a placeholder
// on the dashboard (PR #77 closed), so the app does not offer it.
const CHANNELS = [
  { key: 'dashboard', label: 'Dashboard and app', hint: 'Shows on the overview while it lasts' },
  { key: 'push', label: 'Push notification', hint: 'To every phone signed in to this org' },
];

/**
 * Temperature alert rule for one sensor: limits, recovery margin, channels,
 * enabled. With `sensors`, it also lets you pick which sensor (Alerts tab).
 */
export default function AlertRuleSheet({ visible, onClose, sensor, sensors, rules, onSaved }: {
  visible: boolean; onClose: () => void; sensor: Sensor | null;
  sensors?: Sensor[]; rules?: Record<number, AlertRule>;
  onSaved: (sensorId: number, rule: AlertRule | null) => void;
}) {
  const toast = useToast();
  const [sensorId, setSensorId] = useState<number | null>(sensor?.id ?? null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [high, setHigh] = useState('');
  const [low, setLow] = useState('');
  const [hyst, setHyst] = useState('1');
  const [channels, setChannels] = useState<string[]>(['dashboard', 'push']);
  const [cooldown, setCooldown] = useState<number | undefined>(undefined);

  useEffect(() => { if (visible) setSensorId(sensor?.id ?? null); }, [visible, sensor]);

  useEffect(() => {
    if (!visible || sensorId == null) return;
    let live = true;
    setLoading(true); setError(null);
    const fill = (r: AlertRule | null) => {
      setExists(!!r);
      setEnabled(r ? r.enabled : true);
      setHigh(r?.high_limit != null ? String(r.high_limit) : '');
      setLow(r?.low_limit != null ? String(r.low_limit) : '');
      setHyst(r?.hysteresis != null ? String(r.hysteresis) : '1');
      setChannels(r?.channels?.length ? r.channels.filter((c) => c !== 'whatsapp') : ['dashboard', 'push']);
      setCooldown(r?.cooldown_s);
    };
    api.getAlertRule(sensorId)
      .then(({ data }) => { if (live) fill(data); })
      .catch(() => { if (live) { fill(rules?.[sensorId] ?? null); setError('Failed to load alert settings'); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [visible, sensorId, rules]);

  const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')));
  const current = sensors?.find((s) => s.id === sensorId) ?? sensor;

  async function save() {
    setError(null);
    if (sensorId == null) return setError('Choose a sensor');
    const h = num(high), l = num(low), hy = hyst.trim() === '' ? 1 : num(hyst);
    if ([h, l, hy].some((v) => v != null && !Number.isFinite(v))) return setError('Enter valid numbers');
    if (h == null && l == null) return setError('Set a max and/or a min temperature');
    if (h != null && l != null && l >= h) return setError('Min must be below max');
    if ((hy as number) < 0) return setError("Recovery margin can't be negative");
    if (channels.length === 0) return setError('Choose at least one notification channel');
    setSaving(true);
    try {
      const { data } = await api.saveAlertRule(sensorId, {
        high_limit: h, low_limit: l, hysteresis: hy as number, channels, enabled,
        ...(cooldown != null ? { cooldown_s: cooldown } : {}),
      });
      onSaved(sensorId, data ?? { sensor_id: sensorId, high_limit: h, low_limit: l, hysteresis: hy as number, channels, enabled });
      toast.success('Alert rule saved');
      onClose();
    } catch (err) {
      setError(api.errText(err, 'Failed to save'));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (sensorId == null) return;
    const ok = await confirm({
      title: 'Remove alert rule?',
      message: `"${current ? sensorLabel(current) : 'This sensor'}" will no longer trigger temperature alerts.`,
      confirmLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      await api.deleteAlertRule(sensorId);
      onSaved(sensorId, null);
      toast.success('Alert rule removed');
      onClose();
    } catch {
      setError('Failed to remove');
    } finally {
      setSaving(false);
    }
  }

  const toggleChannel = (c: string) => setChannels((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));

  return (
    <Sheet
      visible={visible} onClose={onClose}
      title={exists ? 'Edit alert rule' : 'Temperature alert'}
      subtitle={current ? sensorLabel(current) : undefined}
      footer={
        <>
          {exists && <Button label="Remove" variant="danger" onPress={remove} disabled={saving} small style={{ marginRight: 'auto' }} />}
          <Button label="Cancel" onPress={onClose} disabled={saving} small />
          <Button label="Save" variant="primary" onPress={save} busy={saving} small />
        </>
      }
    >
      {sensors && (
        <Picker
          label="Sensor"
          value={sensorId}
          onChange={(v) => setSensorId(v)}
          options={sensors.map((s) => ({ value: s.id, label: sensorLabel(s), sub: rules?.[s.id] ? 'Has a rule' : s.hub_name ?? undefined }))}
        />
      )}
      {sensorId == null ? null : loading ? <Loading /> : (
        <View>
          {error && <Notice tone="alarm">{error}</Notice>}
          <Toggle label="Alerts enabled" value={enabled} onChange={setEnabled} hint={enabled ? undefined : 'Paused: the limits are kept but nothing fires'} />
          <Row gap={S.md} style={{ marginTop: S.sm, alignItems: 'flex-start' }}>
            <Field style={{ flex: 1 }} label="Max °C" value={high} onChangeText={setHigh} keyboardType="numbers-and-punctuation" placeholder="8" hint="Alert above this" />
            <Field style={{ flex: 1 }} label="Min °C" value={low} onChangeText={setLow} keyboardType="numbers-and-punctuation" placeholder="2" hint="Alert below this" />
          </Row>
          <Field label="Recovery margin °C" value={hyst} onChangeText={setHyst} keyboardType="decimal-pad"
            hint="The temperature must come back this far inside the limit before the alert clears, so it doesn't flap." />
          <T v="label" style={{ marginTop: S.sm }}>Notify via</T>
          {CHANNELS.map((c) => (
            <Toggle key={c.key} label={c.label} hint={c.hint} value={channels.includes(c.key)} onChange={() => toggleChannel(c.key)} />
          ))}
        </View>
      )}
    </Sheet>
  );
}
