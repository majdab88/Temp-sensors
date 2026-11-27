// Hand-drawn SVG charts (react-native-svg), so they look the same on Android,
// iOS and the web build and follow the Frost palette exactly.
import React, { useState } from 'react';
import { View, LayoutChangeEvent, GestureResponderEvent, Text, StyleSheet } from 'react-native';
import Svg, { Polyline, Line, Rect, Circle, Text as SvgText, Path } from 'react-native-svg';
import { C, F, R } from '../theme';
import { formatDayMonthTime, formatDateTimeShort } from '../utils/time';
import { validHum } from '../utils/sensor';

function useWidth(initial = 300): [number, (e: LayoutChangeEvent) => void] {
  const [w, setW] = useState(initial);
  return [w, (e) => setW(Math.max(100, Math.round(e.nativeEvent.layout.width)))];
}

/** 24 h sparkline. The y-scale spans at least 4 °C so sensor noise stays flat. */
export function Sparkline({ points, alarm, height = 30 }: { points: number[] | null | undefined; alarm?: boolean; height?: number }) {
  const [w, onLayout] = useWidth(140);
  if (!points || points.length < 2) return <View style={{ height }} onLayout={onLayout} />;
  const min = Math.min(...points), max = Math.max(...points);
  const span = Math.max(max - min, 4);
  const lo = (max + min) / 2 - span / 2;
  const step = w / (points.length - 1);
  const pad = 2;
  const pts = points.map((v, i) => `${(i * step).toFixed(1)},${(height - pad - ((v - lo) / span) * (height - pad * 2)).toFixed(1)}`).join(' ');
  return (
    <View style={{ height }} onLayout={onLayout}>
      <Svg width={w} height={height}>
        <Polyline points={pts} fill="none" stroke={alarm ? C.alarm : C.ice} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
      </Svg>
    </View>
  );
}

export interface ChartPoint { t: number; temp: number | null; hum: number | null }

/**
 * History chart: temperature (ice), humidity (dashed gray, own 0–100 % scale)
 * when the sensor has it, threshold bands from the enabled rule, and a
 * press-and-drag readout. The temperature axis spans at least 25 °C, snapped
 * to multiples of 5, so ordinary drift does not read as a dramatic swing —
 * the same rule as the web chart.
 */
export function TempChart({ points, high, low, height = 240 }: {
  points: ChartPoint[]; high: number | null; low: number | null; height?: number;
}) {
  const [w, onLayout] = useWidth();
  const [cursor, setCursor] = useState<number | null>(null);
  const temps = points.map((p) => p.temp).filter((t): t is number => t != null);
  const hasHum = points.some((p) => validHum(p.hum));
  if (points.length < 2 || temps.length < 2) {
    return <View onLayout={onLayout} style={[styles.empty, { height }]}><Text style={styles.axis}>Not enough readings to chart</Text></View>;
  }

  const padL = 34, padR = hasHum ? 30 : 10, padT = 10, padB = 24;
  const extra = [high, low].filter((v): v is number => v != null);
  const lo0 = Math.min(...temps, ...extra), hi0 = Math.max(...temps, ...extra);
  const span = Math.max(hi0 - lo0 + 4, 25);
  const mid = (hi0 + lo0) / 2;
  const yMin = Math.floor((mid - span / 2) / 5) * 5;
  const yMax = Math.ceil((mid + span / 2) / 5) * 5;
  const t0 = points[0].t, t1 = points[points.length - 1].t;
  const plotW = w - padL - padR, plotH = height - padT - padB;
  const x = (t: number) => padL + ((t - t0) / (t1 - t0 || 1)) * plotW;
  const y = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const yh = (v: number) => padT + (1 - v / 100) * plotH;

  // Break the line at missing values rather than bridging a gap.
  const segs = (get: (p: ChartPoint) => number | null, map: (v: number) => number) => {
    const out: string[] = [];
    let cur: string[] = [];
    for (const p of points) {
      const v = get(p);
      if (v == null) { if (cur.length > 1) out.push(cur.join(' ')); cur = []; continue; }
      cur.push(`${x(p.t).toFixed(1)},${map(v).toFixed(1)}`);
    }
    if (cur.length > 1) out.push(cur.join(' '));
    return out;
  };
  const tempLines = segs((p) => p.temp, y);
  const humLines = hasHum ? segs((p) => (validHum(p.hum) ? p.hum : null), yh) : [];

  const ticks: number[] = [];
  const stepY = (yMax - yMin) / 5 > 5 ? 10 : 5;
  for (let v = yMin; v <= yMax; v += stepY) ticks.push(v);

  const pick = (e: GestureResponderEvent) => {
    const px = e.nativeEvent.locationX;
    const t = t0 + ((px - padL) / plotW) * (t1 - t0);
    let best = 0, bd = Infinity;
    points.forEach((p, i) => { const d = Math.abs(p.t - t); if (d < bd) { bd = d; best = i; } });
    setCursor(best);
  };
  const cp = cursor != null ? points[cursor] : null;

  return (
    <View onLayout={onLayout}>
      <View
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={pick}
        onResponderMove={pick}
        onResponderRelease={() => setTimeout(() => setCursor(null), 1800)}
        onResponderTerminationRequest={() => true}
      >
        <Svg width={w} height={height}>
          {high != null && y(high) > padT && (
            <>
              <Rect x={padL} y={padT} width={plotW} height={Math.max(0, y(high) - padT)} fill={C.alarmSoft} />
              <Line x1={padL} x2={w - padR} y1={y(high)} y2={y(high)} stroke={C.alarm} strokeDasharray="5,4" strokeWidth={1.2} />
            </>
          )}
          {low != null && y(low) < padT + plotH && (
            <>
              <Rect x={padL} y={y(low)} width={plotW} height={Math.max(0, padT + plotH - y(low))} fill={C.iceSoft} />
              <Line x1={padL} x2={w - padR} y1={y(low)} y2={y(low)} stroke={C.iceDeep} strokeDasharray="5,4" strokeWidth={1.2} />
            </>
          )}
          {ticks.map((v) => (
            <React.Fragment key={v}>
              <Line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke={C.line} strokeWidth={1} />
              <SvgText x={padL - 6} y={y(v) + 4} fontSize={10} fill={C.ink3} textAnchor="end" fontFamily={F.mono}>{`${v}°`}</SvgText>
            </React.Fragment>
          ))}
          {hasHum && [0, 50, 100].map((v) => (
            <SvgText key={v} x={w - padR + 4} y={yh(v) + 4} fontSize={10} fill={C.ink3} fontFamily={F.mono}>{`${v}%`}</SvgText>
          ))}
          {humLines.map((pts, i) => <Polyline key={`h${i}`} points={pts} fill="none" stroke={C.ink3} strokeWidth={1.4} strokeDasharray="3,3" />)}
          {tempLines.map((pts, i) => <Polyline key={`t${i}`} points={pts} fill="none" stroke={C.ice} strokeWidth={2} strokeLinejoin="round" />)}
          <SvgText x={padL} y={height - 6} fontSize={10} fill={C.ink3} fontFamily={F.mono}>{formatDayMonthTime(t0)}</SvgText>
          <SvgText x={w - padR} y={height - 6} fontSize={10} fill={C.ink3} textAnchor="end" fontFamily={F.mono}>{formatDayMonthTime(t1)}</SvgText>
          {cp && (
            <>
              <Line x1={x(cp.t)} x2={x(cp.t)} y1={padT} y2={padT + plotH} stroke={C.ink2} strokeWidth={1} />
              {cp.temp != null && <Circle cx={x(cp.t)} cy={y(cp.temp)} r={4} fill={C.surface} stroke={C.ice} strokeWidth={2} />}
            </>
          )}
        </Svg>
      </View>
      {cp && (
        <View style={styles.readout} pointerEvents="none">
          <Text style={styles.readoutVal}>{cp.temp != null ? `${cp.temp.toFixed(2)} °C` : '—'}{validHum(cp.hum) ? `  ·  ${cp.hum.toFixed(0)} %` : ''}</Text>
          <Text style={styles.readoutTime}>{formatDateTimeShort(cp.t)}</Text>
        </View>
      )}
    </View>
  );
}

/** Excursion window: temperature, dashed limit, shaded breach, peak marker. */
export function BreachChart({ readings, startedAt, endedAt, limit, kind, height = 220 }: {
  readings: { recorded_at: string; temp: number | null }[];
  startedAt: string; endedAt: string | null; limit: number | null; kind: 'high' | 'low'; height?: number;
}) {
  const [w, onLayout] = useWidth();
  const pts = readings.filter((r) => r.temp != null) as { recorded_at: string; temp: number }[];
  if (pts.length < 2) {
    return <View onLayout={onLayout} style={[styles.empty, { height: 80 }]}><Text style={styles.axis}>Not enough readings to chart this window</Text></View>;
  }
  const padL = 40, padR = 10, padT = 22, padB = 24;
  const times = pts.map((r) => new Date(r.recorded_at).getTime());
  const temps = pts.map((r) => r.temp);
  const t0 = times[0], t1 = times[times.length - 1];
  const lo = Math.min(...temps, limit ?? Infinity), hi = Math.max(...temps, limit ?? -Infinity);
  const span = Math.max(hi - lo, 4);
  const yMin = lo - span * 0.15, yMax = hi + span * 0.15;
  const x = (t: number) => padL + ((t - t0) / (t1 - t0 || 1)) * (w - padL - padR);
  const y = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin)) * (height - padT - padB);
  const line = pts.map((_, i) => `${x(times[i]).toFixed(1)},${y(temps[i]).toFixed(1)}`).join(' ');
  const bStart = x(Math.max(t0, new Date(startedAt).getTime()));
  const bEnd = x(endedAt ? Math.min(t1, new Date(endedAt).getTime()) : t1);
  const peakV = kind === 'high' ? Math.max(...temps) : Math.min(...temps);
  const peakI = temps.indexOf(peakV);
  const ticks = [yMin, (yMin + yMax) / 2, yMax];
  return (
    <View onLayout={onLayout}>
      <Svg width={w} height={height}>
        <Rect x={bStart} y={padT} width={Math.max(0, bEnd - bStart)} height={height - padT - padB} fill={C.alarmSoft} />
        {ticks.map((v, i) => (
          <React.Fragment key={i}>
            <Line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke={C.line} />
            <SvgText x={padL - 6} y={y(v) + 4} fontSize={10} fill={C.ink3} textAnchor="end" fontFamily={F.mono}>{`${v.toFixed(1)}°`}</SvgText>
          </React.Fragment>
        ))}
        {limit != null && (
          <>
            <Line x1={padL} x2={w - padR} y1={y(limit)} y2={y(limit)} stroke={C.alarm} strokeDasharray="5,4" strokeWidth={1.2} />
            <SvgText x={w - padR} y={y(limit) - 5} fontSize={10} fill={C.alarmDeep} textAnchor="end" fontFamily={F.mono}>{`limit ${limit}°`}</SvgText>
          </>
        )}
        <Polyline points={line} fill="none" stroke={C.ink} strokeWidth={1.8} strokeLinejoin="round" />
        <Circle cx={x(times[peakI])} cy={y(peakV)} r={4.5} fill={C.alarm} />
        {/* Keep the label inside the plot when the peak sits at an edge. */}
        <SvgText
          x={x(times[peakI]) > w - 60 ? x(times[peakI]) - 8 : x(times[peakI]) < padL + 40 ? x(times[peakI]) + 8 : x(times[peakI])}
          y={Math.max(12, y(peakV) - 9)}
          fontSize={10} fill={C.alarmDeep} fontFamily={F.monoMedium}
          textAnchor={x(times[peakI]) > w - 60 ? 'end' : x(times[peakI]) < padL + 40 ? 'start' : 'middle'}
        >{`peak ${peakV.toFixed(1)}°`}</SvgText>
        <SvgText x={padL} y={height - 6} fontSize={10} fill={C.ink3} fontFamily={F.mono}>{formatDayMonthTime(t0)}</SvgText>
        <SvgText x={w - padR} y={height - 6} fontSize={10} fill={C.ink3} textAnchor="end" fontFamily={F.mono}>{formatDayMonthTime(t1)}</SvgText>
      </Svg>
    </View>
  );
}

/** Battery glyph: fill by level, amber when low (red stays for alarms). */
export function BatteryGlyph({ level }: { level: 'full' | 'half' | 'low' }) {
  const color = level === 'low' ? C.amber : level === 'half' ? C.ink2 : C.ok;
  const fillW = level === 'low' ? 4 : level === 'half' ? 8.5 : 15;
  return (
    <Svg width={22} height={12} viewBox="0 0 22 12">
      <Rect x={0.75} y={0.75} width={18} height={10.5} rx={2.5} fill="none" stroke={C.ink3} strokeWidth={1} />
      <Path d="M19.5 3.5h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1z" fill={C.ink3} />
      <Rect x={2.25} y={2.25} width={fillW} height={7.5} rx={1.2} fill={color} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', justifyContent: 'center', backgroundColor: C.inset, borderRadius: R.control },
  axis: { fontFamily: F.regular, fontSize: 12, color: C.ink3 },
  readout: { position: 'absolute', top: 6, left: 40, backgroundColor: C.ink, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  readoutVal: { color: C.onDark, fontFamily: F.monoMedium, fontSize: 13 },
  readoutTime: { color: C.iceSoft, fontFamily: F.mono, fontSize: 11, marginTop: 1 },
});
