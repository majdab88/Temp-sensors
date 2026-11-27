import { useEffect, useState } from 'react';
import type { Sensor, Reading } from '../types';

// Live-mode state of one sensor, as the web SensorCard derives it.
//
// live_until is set only once the hub reports the request reaching the node;
// live_requested_at covers the gap before that, which lasts until the sensor
// next wakes. Two independent signals mean "live": live_until, or the node
// reporting faster than its own interval (liveSeenAt). The node sleeps between
// live readings, so the grace is three intervals, not one — at one interval a
// single late reading dropped the chip mid-session.
export interface LiveState {
  isLive: boolean;
  livePending: boolean;
  liveLeft: number;           // seconds of session left, 0 if unknown
  nextWakeIn: string | null;  // "~4m", "any moment"
}

export function useLiveState(sensor: Sensor, reading: Reading | null, liveSeenAt = 0): LiveState {
  const [now, setNow] = useState(() => Date.now());

  const sleepSecs = Number(sensor.cfg_sleep_secs) || 900;
  const liveUntil = sensor.live_until ? new Date(sensor.live_until).getTime() : 0;
  const liveGrace = Math.max(90000, (Number(sensor.live_interval_s) || 30) * 3000);
  const seenLive = liveSeenAt > 0 && now - liveSeenAt < liveGrace;
  const isLive = liveUntil > now || seenLive;
  const liveReqAt = sensor.live_requested_at ? new Date(sensor.live_requested_at).getTime() : 0;
  // A reading after the request without a session starting is the wake the
  // request was waiting for: it came and went.
  const readingAt = reading?.recorded_at ? new Date(reading.recorded_at).getTime() : 0;
  const missedWake = liveReqAt > 0 && readingAt > liveReqAt + 5000;
  const livePending = !isLive && liveReqAt > 0 && !missedWake && now - liveReqAt < (sleepSecs + 120) * 1000;
  const liveLeft = isLive && liveUntil ? Math.max(0, Math.round((liveUntil - now) / 1000)) : 0;

  // The sleep interval is fixed, so the wake a request waits for is
  // predictable from the last reading. A number turns "waking" into a wait
  // you can decide to sit through.
  let nextWakeIn: string | null = null;
  if (livePending && readingAt) {
    const secs = Math.round((readingAt + sleepSecs * 1000 - now) / 1000);
    nextWakeIn = secs <= 30 ? 'any moment' : secs < 90 ? `~${secs}s` : `~${Math.round(secs / 60)}m`;
  }

  useEffect(() => {
    if (!isLive && !livePending) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isLive, livePending]);

  return { isLive, livePending, liveLeft, nextWakeIn };
}
