import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Sheet, Field, Button, Notice, Loading, Row, T, Divider } from '../ui';
import { confirm } from '../ui/feedback';
import * as api from '../services/api';
import type { Sensor, SensorConfig } from '../types';
import { sensorLabel } from '../utils/sensor';
import { formatDayMonthTime } from '../utils/time';
import { C, S } from '../theme';

// Coefficients are tiny numbers whose full expansion is unreadable; four
// significant figures is more than the hardware resolves.
function coef(v: number | null | undefined) {
  if (v == null) return '—';
  const n = Number(v);
  return Math.abs(n) < 0.01 ? n.toExponential(3) : n.toFixed(4);
}

/**
 * Per-sensor remote configuration — superadmin only (the backend refuses
 * anyone else). Changes are queued, not applied: a sleeping node can only be
 * reached in the moment after it transmits, so a change lands within one
 * reporting interval. The sheet says so, or it looks broken.
 */
export default function SensorConfigSheet({ visible, onClose, sensor }: { visible: boolean; onClose: () => void; sensor: Sensor }) {
  const [cfg, setCfg] = useState<SensorConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sleepMins, setSleepMins] = useState('');
  const [shA, setShA] = useState('');
  const [shB, setShB] = useState('');
  const [shC, setShC] = useState('');
  const [rSeries, setRSeries] = useState('');

  const load = () => api.getSensorConfig(sensor.id).then((res) => {
    const d = res.data;
    setCfg(d);
    setSleepMins(String(Math.round((d.cfg_sleep_secs ?? 900) / 60)));
    setShA(String(d.cfg_sh_a ?? 2.535e-3));
    setShB(String(d.cfg_sh_b ?? 3.01e-5));
    setShC(String(d.cfg_sh_c ?? 7.23e-7));
    setRSeries(String(d.cfg_r_series ?? 10000));
  });

  useEffect(() => {
    if (!visible) return;
    setError(''); setNotice(''); setCfg(null);
    load().catch(() => setError('Failed to load configuration'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sensor.id]);

  async function save() {
    if (!cfg) return;
    setError(''); setNotice('');
    const payload = {
      sleep_secs: Math.round(Number(sleepMins) * 60),
      sh_a: Number(shA), sh_b: Number(shB), sh_c: Number(shC), r_series: Number(rSeries),
    };
    if (Object.values(payload).some((v) => !Number.isFinite(v))) return setError('Enter valid numbers');
    const changesCalibration = payload.sh_a !== cfg.cfg_sh_a || payload.sh_b !== cfg.cfg_sh_b ||
      payload.sh_c !== cfg.cfg_sh_c || payload.r_series !== cfg.cfg_r_series;
    if (changesCalibration && !(await confirm({
      title: 'Change calibration?',
      message: 'Changing calibration shifts every future reading from this sensor. Past readings are not altered, so the history will show a step at this point. The change is recorded.',
      confirmLabel: 'Queue change',
    }))) return;

    setBusy(true);
    try {
      const res = await api.putSensorConfig(sensor.id, payload);
      if (res.data.unchanged) setNotice('No change — these are the settings already queued for this sensor.');
      else setNotice(`Queued — applies within about ${Math.round((res.data.applies_within_secs || 900) / 60)} min, when the sensor next reports.`);
      await load();
    } catch (err) {
      setError(api.errText(err, 'Failed to queue configuration'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      visible={visible} onClose={onClose} title="Interval and calibration" subtitle={sensorLabel(sensor)}
      footer={<><Button label="Close" onPress={onClose} small /><Button label="Queue change" variant="primary" onPress={save} busy={busy} disabled={!cfg} small /></>}
    >
      {error ? <Notice tone="alarm">{error}</Notice> : null}
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {!cfg ? (error ? null : <Loading />) : (
        <View>
          {cfg.pending && (
            <Notice tone="amber">A change is waiting for this sensor to wake — it is still running its previous settings. It applies on the next reading.</Notice>
          )}
          <Field label="Reporting interval (minutes)" value={sleepMins} onChangeText={setSleepMins} keyboardType="number-pad"
            hint="5–60 minutes. The one-hour ceiling is deliberate: a change only reaches a sensor while it is awake, so a longer interval puts every future correction that far away." />
          <Field label="Series resistor (Ω)" value={rSeries} onChangeText={setRSeries} keyboardType="numbers-and-punctuation"
            hint="The measured value of the divider resistor on this board. Its tolerance biases every resistance reading." />
          <Row gap={S.sm} style={{ alignItems: 'flex-start' }}>
            <Field style={{ flex: 1 }} label="S-H A" value={shA} onChangeText={setShA} autoCapitalize="none" keyboardType="numbers-and-punctuation" />
            <Field style={{ flex: 1 }} label="B" value={shB} onChangeText={setShB} autoCapitalize="none" keyboardType="numbers-and-punctuation" />
            <Field style={{ flex: 1 }} label="C" value={shC} onChangeText={setShC} autoCapitalize="none" keyboardType="numbers-and-punctuation" />
          </Row>
          <T v="caption">
            1/T(K) = A + B·ln(R) + C·ln(R)³. Fit these from resistance/temperature pairs across the range the sensor actually
            works in — a cold-range fit beats a full-range one inside a cooler. Scientific notation is accepted (2.535e-3).
            The sensor re-checks that the coefficients give a falling NTC curve and rejects them if not.
          </T>
          {cfg.history?.length > 0 && (
            <>
              <Divider />
              <T v="label" style={{ marginBottom: S.sm }}>Recent changes</T>
              {cfg.history.map((h) => (
                <View key={h.changed_at} style={{ paddingVertical: 6 }}>
                  <T v="small" style={{ color: h.applied_at ? C.ink2 : C.amber }}>
                    {formatDayMonthTime(h.applied_at || h.changed_at)}{h.applied_at ? '' : ' · not yet applied'}
                  </T>
                  <T v="monoSmall">{Math.round(h.sleep_secs / 60)}m · R{h.r_series} · A {coef(h.sh_a)} B {coef(h.sh_b)} C {coef(h.sh_c)}</T>
                </View>
              ))}
            </>
          )}
        </View>
      )}
    </Sheet>
  );
}
