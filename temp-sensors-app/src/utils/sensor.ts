import { Reading, Sensor, AlertRule } from '../types';

export function fmt(val: number | string | null | undefined, decimals = 1): string | null {
  if (val == null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n.toFixed(decimals) : null;
}

/** Humidity is -999 on NTC nodes and on a probe fault: not a value to show. */
export function validHum(h: number | null | undefined): h is number {
  return h != null && h > -100;
}

export type Connection = 'online' | 'stale' | 'offline' | 'unknown';

/** online < 15 min, stale 15–60 min, offline older. */
export function connection(recordedAt: string | null | undefined): Connection {
  if (!recordedAt) return 'unknown';
  const age = Date.now() - new Date(recordedAt).getTime();
  if (age < 15 * 60 * 1000) return 'online';
  if (age < 60 * 60 * 1000) return 'stale';
  return 'offline';
}

export type ChipTone = 'alarm' | 'amber' | 'muted' | 'ok' | 'ice';

/** ALARM wins, then a broken probe, then connection status. */
export function statusChip(sensor: Sensor, reading: Reading | null, alarm: boolean): { label: string; tone: ChipTone } {
  if (alarm) return { label: 'Alarm', tone: 'alarm' };
  // A failed probe is a node that is online and reporting, with no temperature
  // in it. Without its own chip it reads as OK with a blank reading.
  if (sensor.probe_error === true) return { label: 'Probe error', tone: 'muted' };
  const c = connection(reading?.recorded_at);
  if (c === 'offline') return { label: 'Offline', tone: 'muted' };
  if (c === 'stale') return { label: 'Stale', tone: 'amber' };
  if (c === 'unknown') return { label: 'No data', tone: 'muted' };
  return { label: 'OK', tone: 'ok' };
}

export function limitText(rule: AlertRule | null | undefined): string | null {
  if (!rule?.enabled) return null;
  const parts: string[] = [];
  if (rule.high_limit != null) parts.push(`max ${rule.high_limit}°`);
  if (rule.low_limit != null) parts.push(`min ${rule.low_limit}°`);
  return parts.length ? parts.join(' · ') : null;
}

export function sensorLabel(s: { name?: string | null; mac: string }): string {
  return s.name || s.mac;
}

/** "TempSens-A1B2C3" from a sensor MAC, as the hub names it while pairing. */
export function pairingName(mac: string | undefined): string {
  return 'TempSens-' + (mac || '').replace(/:/g, '').slice(-6);
}

// Coarse battery level from the pack %. 255 / null = unknown. The backend's
// low-battery alert fires below 22 % too.
export type BatteryLevel = 'full' | 'half' | 'low';
export function batteryLevel(pct: number | null | undefined): BatteryLevel | null {
  if (pct == null || pct === 255) return null;
  return pct < 22 ? 'low' : pct < 40 ? 'half' : 'full';
}

export const volts = (mv: number | null | undefined) => (mv ? `${(mv / 1000).toFixed(2)} V` : null);

export const BATTERY_TYPE_LABEL: Record<string, string> = { lithium: 'Lithium', alkaline: 'Alkaline' };
export const BATTERY_TYPE_SHORT: Record<string, string> = { lithium: 'Li', alkaline: 'Alk' };

/** Downsample a series to at most n points (stride pick), keeping the last. */
export function downsample<T>(arr: T[], n = 48): T[] {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

// Mean Kinetic Temperature (Arrhenius-weighted) — the cold-chain summary
// statistic that penalises time spent warm more than a plain average does.
// ΔH = 83.144 kJ/mol, R = 8.314 J/mol·K → ΔH/R ≈ 10000 K.
export function meanKineticTemp(temps: number[]): number {
  const dHoverR = 83144 / 8.314;
  const sum = temps.reduce((acc, t) => acc + Math.exp(-dHoverR / (t + 273.15)), 0);
  return dHoverR / -Math.log(sum / temps.length) - 273.15;
}

export interface Stats { min: number; max: number; avg: number; mkt: number; inRange: number | null }

export function computeStats(temps: number[], high: number | null, low: number | null): Stats | null {
  if (temps.length === 0) return null;
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
  let inRange: number | null = null;
  if (high != null || low != null) {
    const ok = temps.filter((t) => (high == null || t <= high) && (low == null || t >= low)).length;
    inRange = (ok / temps.length) * 100;
  }
  return { min, max, avg, mkt: meanKineticTemp(temps), inRange };
}
