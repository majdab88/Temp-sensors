import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import SensorCard from '../components/SensorCard'
import api from '../services/api'
import socket from '../services/socket'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { smartTime } from '../utils/time'

const DAY_MS = 24 * 60 * 60 * 1000

/** Downsample a series to at most n points (simple stride pick). */
function downsample(arr, n = 48) {
  if (arr.length <= n) return arr
  const step = arr.length / n
  const out = []
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)])
  out.push(arr[arr.length - 1])
  return out
}

function eventText(e) {
  const name = e.sensor_name || e.sensor_mac
  const v = e.value != null ? `${Number(e.value).toFixed(1)} °C` : ''
  if (e.kind === 'high') return `${name} crossed its max limit — ${v}`
  if (e.kind === 'low') return `${name} crossed its min limit — ${v}`
  return `${name} back in range — ${v}`
}

export default function Dashboard() {
  const { user } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const canEdit = user?.permissionLevel !== 'viewer'
  const [sensors, setSensors] = useState([])
  const [readings, setReadings] = useState({}) // keyed by sensor MAC
  const [alerts, setAlerts] = useState({})     // active breaches, keyed by sensor MAC
  const [rules, setRules] = useState({})       // alert rules, keyed by sensor id
  const [sparks, setSparks] = useState({})     // 24h temp series, keyed by sensor MAC
  const [liveSeen, setLiveSeen] = useState({}) // mac -> when it was last seen reporting at burst rate
  const lastReadingAt = useRef({})            // mac -> previous reading time, to measure the gap
  const [events, setEvents] = useState([])     // recent alert transitions
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [hubsJoined, setHubsJoined] = useState([])

  const handleRename = useCallback((id, newName) => {
    setSensors((prev) => prev.map((s) => (s.id === id ? { ...s, name: newName } : s)))
  }, [])

  const handleDelete = useCallback((id) => {
    setSensors((prev) => prev.filter((s) => s.id !== id))
  }, [])

  const [acking, setAcking] = useState(null) // excursion id in flight

  // Acknowledge the excursion behind an active alarm (compliance sign-off).
  const acknowledge = useCallback(async (excursionId) => {
    if (!excursionId) return
    setAcking(excursionId)
    try {
      await api.post(`/excursions/${excursionId}/ack`)
      const who = user?.email || user?.username || 'you'
      setAlerts((prev) => {
        const next = { ...prev }
        for (const mac in next) {
          if (next[mac].excursion_id === excursionId) {
            next[mac] = { ...next[mac], acked: true, ack_by: who }
          }
        }
        return next
      })
      toast.success('Excursion acknowledged')
    } catch {
      toast.error('Failed to acknowledge — try again')
    }
    finally { setAcking(null) }
  }, [user, toast])

  // Fetch sensors + devices, then latest readings / rules / sparklines / events
  const fetchData = useCallback(async () => {
    try {
      const [sensorsRes, devicesRes] = await Promise.all([
        api.get('/sensors'),
        api.get('/devices'),
      ])

      const sensorList = sensorsRes.data
      setSensors(sensorList)

      // Seed already-active breaches so they show on load
      try {
        const activeRes = await api.get('/alerts/active')
        const seeded = {}
        activeRes.data.forEach((a) => { seeded[a.sensor_mac] = a })
        setAlerts(seeded)
      } catch { /* ignore */ }

      // Join socket rooms for each hub
      const hubMacs = devicesRes.data.map((d) => d.mac)
      hubMacs.forEach((mac) => socket.emit('join', mac))
      setHubsJoined(hubMacs)

      // Latest reading per sensor
      const latestResults = await Promise.allSettled(
        sensorList.map((s) => api.get(`/sensors/${s.id}/readings/latest`)),
      )
      const initialReadings = {}
      latestResults.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          initialReadings[sensorList[idx].mac] = result.value.data
        }
      })
      setReadings(initialReadings)

      // Alert rule per sensor (for the "max X°" note on cards)
      const ruleResults = await Promise.allSettled(
        sensorList.map((s) => api.get(`/alerts/rules/${s.id}`)),
      )
      const ruleMap = {}
      ruleResults.forEach((result, idx) => {
        if (result.status === 'fulfilled' && result.value.data) {
          ruleMap[sensorList[idx].id] = result.value.data
        }
      })
      setRules(ruleMap)

      // 24h sparkline per sensor
      const from = new Date(Date.now() - DAY_MS).toISOString()
      const sparkResults = await Promise.allSettled(
        sensorList.map((s) => api.get(`/sensors/${s.id}/readings`, { params: { from } })),
      )
      const sparkMap = {}
      sparkResults.forEach((result, idx) => {
        if (result.status === 'fulfilled' && Array.isArray(result.value.data)) {
          const series = result.value.data
            .filter((r) => r.temp != null)
            .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at))
            .map((r) => r.temp)
          sparkMap[sensorList[idx].mac] = downsample(series)
        }
      })
      setSparks(sparkMap)

      // Recent alert transitions for the rail
      try {
        const eventsRes = await api.get('/alerts/events', { params: { limit: 8 } })
        setEvents(eventsRes.data)
      } catch { /* ignore */ }
    } catch {
      setError('Failed to load sensors')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!socket.connected) socket.connect()
    fetchData()

    // Live updates from socket
    function onSensorData(data) {
      // A node reporting far faster than its own interval is live, whatever the
      // hub did or did not manage to tell us about it. The confirmation is one
      // message that can be missed; the readings are the thing itself.
      const ts   = new Date(data.ts).getTime()
      const prev = lastReadingAt.current[data.sensor_mac]
      lastReadingAt.current[data.sensor_mac] = ts
      if (prev && ts - prev > 0 && ts - prev < 90000) {
        setLiveSeen((m) => ({ ...m, [data.sensor_mac]: Date.now() }))
      }

      setReadings((prev) => ({
        ...prev,
        [data.sensor_mac]: {
          temp: data.temp,
          hum: data.hum,
          battery: data.battery,
          rssi: data.rssi,
          recorded_at: new Date(data.ts).toISOString(),
        },
      }))
      // The probe-error chip is driven from the sensor record, not the reading,
      // so a failure appearing mid-session has to be reflected there too --
      // otherwise it only shows up after a page refresh.
      setSensors((prev) => prev.map((s) =>
        s.mac === data.sensor_mac && s.probe_error !== data.probe_error
          ? { ...s, probe_error: data.probe_error }
          : s
      ))
      if (data.temp != null) {
        setSparks((prev) => {
          const cur = prev[data.sensor_mac] || []
          return { ...prev, [data.sensor_mac]: [...cur.slice(-60), data.temp] }
        })
      }
    }

    // Live mode starting or ending is a hub-reported transition like any other.
    // Without this the card keeps claiming the sensor is still waking until
    // something else triggers a refetch.
    function onLiveState(d) {
      setSensors((prev) => prev.map((s) =>
        s.mac === d.sensor_mac
          ? { ...s,
              live_until:        d.state === 'started' ? d.live_until : null,
              live_interval_s:   d.state === 'started' ? d.interval_s : null,
              live_requested_at: null }
          : s
      ))
    }

    // Alert transitions — keep a map of active breaches; 'recovered' clears one.
    function onAlert(a) {
      setAlerts((prev) => {
        const next = { ...prev }
        if (a.kind === 'recovered') delete next[a.sensor_mac]
        else next[a.sensor_mac] = a
        return next
      })
      setEvents((prev) => [
        { id: `live-${a.ts}`, sensor_name: a.sensor_name, sensor_mac: a.sensor_mac, kind: a.kind, value: a.value, ts: Math.floor(a.ts / 1000) },
        ...prev,
      ].slice(0, 8))
    }

    // Re-join rooms on reconnect so cached hub status is replayed
    function onConnect() {
      hubsJoined.forEach((mac) => socket.emit('join', mac))
    }

    socket.on('sensorData', onSensorData)
    socket.on('alert', onAlert)
    socket.on('liveState', onLiveState)
    socket.on('connect', onConnect)

    return () => {
      socket.off('sensorData', onSensorData)
      socket.off('alert', onAlert)
      socket.off('liveState', onLiveState)
      socket.off('connect', onConnect)
      hubsJoined.forEach((mac) => socket.emit('leave', mac))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchData])

  if (loading) return (
    <div>
      <div className="ok-strip skeleton-strip"><span className="ok-dot" />Loading sensors…</div>
      <div className="sensor-grid">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton-card" />)}
      </div>
    </div>
  )
  if (error)   return <div className="state-error"><h3>Error</h3><p>{error}</p></div>

  const activeAlerts = Object.values(alerts)

  // Hero = worst active breach, measured against the CURRENT reading
  let hero = null
  if (activeAlerts.length > 0) {
    const scored = activeAlerts.map((a) => {
      const cur = readings[a.sensor_mac]?.temp ?? a.value
      const delta = a.kind === 'high'
        ? cur - (a.high_limit ?? cur)
        : (a.low_limit ?? cur) - cur
      return { ...a, cur, delta: Math.max(0, delta) }
    }).sort((x, y) => y.delta - x.delta)
    const top = scored[0]
    const mins = Math.max(1, Math.floor((Date.now() - top.ts) / 60000))
    hero = { top, rest: scored.slice(1), mins }
  }

  const onlineCount = sensors.filter((s) => {
    const r = readings[s.mac]
    return r?.recorded_at && Date.now() - new Date(r.recorded_at).getTime() < 15 * 60 * 1000
  }).length

  function viewSensor(mac) {
    const s = sensors.find((x) => x.mac === mac)
    if (s) navigate(`/history?sensor=${s.id}`)
  }

  return (
    <div>
      {/* ── Alarm hero / all-clear strip ── */}
      {hero ? (
        <section className="alarm-hero">
          <div className="alarm-hero-eyebrow">
            <span className="alarm-hero-dot" />
            Active alarm · {hero.mins} min
          </div>
          <h2>
            {hero.top.sensor_name || hero.top.sensor_mac} is {hero.top.delta.toFixed(1)}° {hero.top.kind === 'high' ? 'above' : 'below'} its limit.
          </h2>
          <div className="alarm-hero-actions">
            <button className="btn btn-onred" onClick={() => viewSensor(hero.top.sensor_mac)}>View sensor</button>
            {canEdit && hero.top.excursion_id && (
              hero.top.acked ? (
                <span className="alarm-hero-acked">✓ Acknowledged{hero.top.ack_by ? ` · ${hero.top.ack_by}` : ''}</span>
              ) : (
                <button
                  className="btn btn-onred-ghost"
                  disabled={acking === hero.top.excursion_id}
                  onClick={() => acknowledge(hero.top.excursion_id)}
                >
                  {acking === hero.top.excursion_id ? 'Acknowledging…' : 'Acknowledge'}
                </button>
              )
            )}
            <button className="btn btn-onred-ghost" onClick={() => navigate('/alerts')}>Alert rules</button>
            {hero.rest.length > 0 && (
              <span className="alarm-hero-more">
                + {hero.rest.length} more: {hero.rest.map((a) => a.sensor_name || a.sensor_mac).join(', ')}
              </span>
            )}
          </div>
        </section>
      ) : (
        <div className="ok-strip">
          <span className="ok-dot" />
          All sensors within limits · {onlineCount}/{sensors.length} online
        </div>
      )}

      <div className="dash-grid">
        {/* ── Main column: sensor grid ── */}
        <div>
          <div className="grid-head">
            <h2>Sensors</h2>
            <span className="grid-head-meta">
              {sensors.length} paired · {onlineCount} online · live
            </span>
            {canEdit && (
              <button className="btn btn-ghost btn-sm" onClick={() => navigate('/devices')}>
                + Pair sensor
              </button>
            )}
          </div>

          {sensors.length === 0 ? (
            <div className="state-empty">
              <h3>No sensors yet</h3>
              <p>Pair a sensor to your hub to see it here</p>
            </div>
          ) : (
            <div className="sensor-grid">
              {sensors.map((sensor) => (
                <SensorCard
                  key={sensor.id}
                  sensor={sensor}
                  reading={readings[sensor.mac] || null}
                  alert={alerts[sensor.mac] || null}
                  rule={rules[sensor.id] || null}
                  spark={sparks[sensor.mac] || null}
                  liveSeenAt={liveSeen[sensor.mac] || 0}
                  onRename={handleRename}
                  onDelete={handleDelete}
                  canEdit={canEdit}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Right rail ── */}
        <aside className="dash-rail">
          <div>
            <div className={`rail-title${activeAlerts.length ? ' alarm' : ''}`}>Active alarms</div>
            {activeAlerts.length === 0 ? (
              <div className="rail-empty">None — all clear.</div>
            ) : (
              activeAlerts.map((a) => (
                <div className="rail-alarm" key={a.sensor_mac}>
                  <div className="rail-alarm-title">
                    {(a.sensor_name || a.sensor_mac)} {a.kind === 'high' ? 'above' : 'below'} limit
                  </div>
                  <div className="rail-alarm-detail">
                    {/* The breaching value, not the live one. Showing the current
                        reading against the breach's limit produced nonsense as soon
                        as a sensor recovered -- "4.7 °C vs max 30 °C" -- because the
                        two numbers came from different moments. */}
                    {Number(a.value).toFixed(1)} °C
                    {a.kind === 'high' && a.high_limit != null && ` vs max ${a.high_limit} °C`}
                    {a.kind === 'low' && a.low_limit != null && ` vs min ${a.low_limit} °C`}
                    {readings[a.sensor_mac]?.temp != null &&
                      Math.abs(Number(readings[a.sensor_mac].temp) - Number(a.value)) >= 0.1 && (
                        <span className="rail-alarm-now">
                          {' '}· now {Number(readings[a.sensor_mac].temp).toFixed(1)} °C
                        </span>
                      )}
                  </div>
                  <div className="rail-alarm-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => viewSensor(a.sensor_mac)}>Details</button>
                    {canEdit && a.excursion_id && (
                      a.acked ? (
                        <span className="rail-acked">✓ Acked{a.ack_by ? ` · ${a.ack_by}` : ''}</span>
                      ) : (
                        <button
                          className="btn btn-sm"
                          disabled={acking === a.excursion_id}
                          onClick={() => acknowledge(a.excursion_id)}
                        >
                          {acking === a.excursion_id ? '…' : 'Acknowledge'}
                        </button>
                      )
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div>
            <div className="rail-title">Recent alerts</div>
            {events.length === 0 ? (
              <div className="rail-empty">No alert activity yet.</div>
            ) : (
              events.map((e) => (
                <div className="rail-event" key={e.id}>
                  <span className="rail-event-time">
                    {smartTime(new Date(e.ts * 1000))}
                  </span>
                  <span className="rail-event-text">{eventText(e)}</span>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
