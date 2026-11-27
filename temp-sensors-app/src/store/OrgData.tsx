// Live state of the current organisation: sensors, their latest readings,
// alerts, rules, sparklines and hubs, kept current from Socket.IO. Overview,
// sensor detail, alert rules and hubs all read from here, so a reading that
// arrives while you are on one screen is already there on the next.
//
// Mirrors frontend/src/pages/Dashboard.jsx + Devices.jsx.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import * as api from '../services/api';
import { useSocketEvent, useHubRooms, getSocket } from '../services/socket';
import { useAuth } from '../context/AuthContext';
import type { Sensor, Reading, Device, HubStatus, ActiveAlert, AlertRule, AlertEvent } from '../types';
import { downsample } from '../utils/sensor';

const DAY_MS = 86400000;

interface OrgData {
  sensors: Sensor[];
  devices: Device[];
  hubStatus: Record<string, HubStatus>;
  readings: Record<string, Reading>;
  alerts: Record<string, ActiveAlert>;
  rules: Record<number, AlertRule>;
  sparks: Record<string, number[]>;
  events: AlertEvent[];
  liveSeen: Record<string, number>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  patchSensor: (id: number, patch: Partial<Sensor>) => void;
  removeSensor: (id: number) => void;
  setRule: (sensorId: number, rule: AlertRule | null) => void;
  setReading: (mac: string, patch: Partial<Reading>) => void;
  patchDevice: (id: number, patch: Partial<Device>) => void;
  removeDevice: (id: number) => void;
  acknowledge: (excursionId: number) => Promise<void>;
  clearLiveSeen: (mac: string) => void;
}

const Ctx = createContext<OrgData | null>(null);

export function OrgDataProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [hubStatus, setHubStatus] = useState<Record<string, HubStatus>>({});
  const [readings, setReadings] = useState<Record<string, Reading>>({});
  const [alerts, setAlerts] = useState<Record<string, ActiveAlert>>({});
  const [rules, setRules] = useState<Record<number, AlertRule>>({});
  const [sparks, setSparks] = useState<Record<string, number[]>>({});
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [liveSeen, setLiveSeen] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastReadingAt = useRef<Record<string, number>>({});

  const refresh = useCallback(async () => {
    try {
      const [sRes, dRes] = await Promise.all([api.getSensors(), api.getDevices()]);
      const list = sRes.data;
      setSensors(list);
      setDevices(dRes.data);
      setError(null);

      // Each block below is independent and optional: a failure leaves that
      // part empty rather than failing the whole screen.
      const [active, latest, ruleRes, sparkRes, ev] = await Promise.all([
        api.getActiveAlerts().then((r) => r.data).catch(() => [] as ActiveAlert[]),
        Promise.allSettled(list.map((s) => api.getLatestReading(s.id))),
        Promise.allSettled(list.map((s) => api.getAlertRule(s.id))),
        Promise.allSettled(list.map((s) => api.getReadings(s.id, { from: new Date(Date.now() - DAY_MS).toISOString() }))),
        api.getAlertEvents(8).then((r) => r.data).catch(() => [] as AlertEvent[]),
      ]);

      const a: Record<string, ActiveAlert> = {};
      active.forEach((x) => { a[x.sensor_mac] = x; });
      setAlerts(a);

      const rd: Record<string, Reading> = {};
      latest.forEach((r, i) => { if (r.status === 'fulfilled') rd[list[i].mac] = r.value.data; });
      setReadings(rd);

      const ru: Record<number, AlertRule> = {};
      ruleRes.forEach((r, i) => { if (r.status === 'fulfilled' && r.value.data) ru[list[i].id] = r.value.data; });
      setRules(ru);

      const sp: Record<string, number[]> = {};
      sparkRes.forEach((r, i) => {
        if (r.status !== 'fulfilled' || !Array.isArray(r.value.data)) return;
        const series = r.value.data
          .filter((x) => x.temp != null)
          .sort((x, y) => new Date(x.recorded_at).getTime() - new Date(y.recorded_at).getTime())
          .map((x) => x.temp as number);
        sp[list[i].mac] = downsample(series);
      });
      setSparks(sp);
      setEvents(ev);
    } catch (err) {
      setError(api.errText(err, 'Failed to load sensors'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useHubRooms(devices.map((d) => d.mac));

  // A refresh after a reconnect catches whatever happened while the phone slept.
  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    let first = true;
    const onConnect = () => { if (first) { first = false; return; } refresh(); };
    if (s.connected) first = false;
    s.on('connect', onConnect);
    return () => { s.off('connect', onConnect); };
  }, [refresh]);

  useSocketEvent<any>('sensorData', (d) => {
    const mac = d.sensor_mac;
    // A node reporting far faster than its own interval is live, whatever the
    // hub did or did not manage to tell us. The shortest configurable interval
    // is 5 minutes, so any gap under 150 s can only be a live session.
    const ts = new Date(d.ts).getTime();
    const prev = lastReadingAt.current[mac];
    lastReadingAt.current[mac] = ts;
    if (prev && ts - prev > 0 && ts - prev < 150000) setLiveSeen((m) => ({ ...m, [mac]: Date.now() }));

    setReadings((p) => ({
      ...p,
      [mac]: {
        temp: d.temp, hum: d.hum, battery: d.battery, bat_mv: d.bat_mv, bat_load_mv: d.bat_load_mv,
        rssi: d.rssi, recorded_at: new Date(d.ts).toISOString(),
      },
    }));
    // The probe-error chip comes from the sensor record, so a failure appearing
    // mid-session has to be copied there; the firmware version likewise.
    setSensors((p) => p.map((s) => s.mac === mac && (s.probe_error !== d.probe_error || (d.fw && s.fw_version !== d.fw))
      ? { ...s, probe_error: d.probe_error, ...(d.fw ? { fw_version: d.fw, fw_reported_at: new Date().toISOString() } : {}) }
      : s));
    if (d.temp != null) setSparks((p) => ({ ...p, [mac]: [...(p[mac] || []).slice(-60), d.temp] }));
  });

  useSocketEvent<any>('liveState', (d) => {
    setSensors((p) => p.map((s) => s.mac === d.sensor_mac
      ? { ...s,
          live_until: d.state === 'started' ? d.live_until : null,
          live_interval_s: d.state === 'started' ? d.interval_s : null,
          live_requested_at: null }
      : s));
  });

  useSocketEvent<Omit<ActiveAlert, 'kind'> & { kind: 'high' | 'low' | 'recovered' }>('alert', (a) => {
    setAlerts((p) => {
      const next = { ...p };
      if (a.kind === 'recovered') delete next[a.sensor_mac];
      else next[a.sensor_mac] = a as ActiveAlert;
      return next;
    });
    setEvents((p) => [
      { id: `live-${a.ts}`, sensor_name: a.sensor_name, sensor_mac: a.sensor_mac, kind: a.kind as AlertEvent['kind'], value: a.value, ts: Math.floor(a.ts / 1000) },
      ...p,
    ].slice(0, 8));
  });

  useSocketEvent<HubStatus>('hubStatus', (d) => {
    setHubStatus((p) => ({ ...p, [d.hub_mac]: { ...p[d.hub_mac], ...d } }));
  });

  const patchSensor = useCallback((id: number, patch: Partial<Sensor>) =>
    setSensors((p) => p.map((s) => (s.id === id ? { ...s, ...patch } : s))), []);
  const removeSensor = useCallback((id: number) => setSensors((p) => p.filter((s) => s.id !== id)), []);
  const setRule = useCallback((sensorId: number, rule: AlertRule | null) => setRules((p) => {
    const next = { ...p };
    if (rule) next[sensorId] = rule; else delete next[sensorId];
    return next;
  }), []);
  const setReading = useCallback((mac: string, patch: Partial<Reading>) =>
    setReadings((p) => (p[mac] ? { ...p, [mac]: { ...p[mac], ...patch } } : p)), []);
  const patchDevice = useCallback((id: number, patch: Partial<Device>) =>
    setDevices((p) => p.map((d) => (d.id === id ? { ...d, ...patch } : d))), []);
  const removeDevice = useCallback((id: number) => {
    setDevices((p) => {
      const gone = p.find((d) => d.id === id);
      if (gone) setSensors((s) => s.filter((x) => x.hub_mac !== gone.mac));
      return p.filter((d) => d.id !== id);
    });
  }, []);

  const clearLiveSeen = useCallback((mac: string) => setLiveSeen((p) => {
    const next = { ...p };
    delete next[mac];
    return next;
  }), []);

  // Acknowledge the excursion behind an active alarm (compliance sign-off).
  const acknowledge = useCallback(async (excursionId: number) => {
    await api.ackExcursion(excursionId);
    const who = user?.email || user?.username || 'you';
    setAlerts((p) => {
      const next = { ...p };
      for (const mac in next) if (next[mac].excursion_id === excursionId) next[mac] = { ...next[mac], acked: true, ack_by: who };
      return next;
    });
  }, [user]);

  return (
    <Ctx.Provider value={{
      sensors, devices, hubStatus, readings, alerts, rules, sparks, events, liveSeen, loading, error,
      refresh, patchSensor, removeSensor, setRule, setReading, patchDevice, removeDevice, acknowledge, clearLiveSeen,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export function useOrgData(): OrgData {
  const c = useContext(Ctx);
  if (!c) throw new Error('useOrgData must be used within OrgDataProvider');
  return c;
}
