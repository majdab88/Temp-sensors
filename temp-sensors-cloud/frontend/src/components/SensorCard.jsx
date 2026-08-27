import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import AlertRuleModal from './AlertRuleModal'
import SensorConfigModal from './SensorConfigModal'
import { useAuth } from '../context/AuthContext'
import BatteryIcon from './BatteryIcon'
import { useToast } from '../context/ToastContext'

/**
 * Determine online status from the last reading timestamp.
 *   online  — reading within last 15 min
 *   stale   — reading 15–60 min ago
 *   offline — reading older than 60 min, or no reading
 */
function getStatus(recordedAt) {
  if (!recordedAt) return 'unknown'
  const ageMs = Date.now() - new Date(recordedAt).getTime()
  if (ageMs < 15 * 60 * 1000) return 'online'
  if (ageMs < 60 * 60 * 1000) return 'stale'
  return 'offline'
}

function formatAge(recordedAt) {
  if (!recordedAt) return 'no data'
  const ageMs = Date.now() - new Date(recordedAt).getTime()
  const mins = Math.floor(ageMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} h ago`
  return `${Math.floor(hrs / 24)} d ago`
}

function fmt(val, decimals = 1) {
  if (val == null) return null
  return Number(val).toFixed(decimals)
}

/** Inline temperature sparkline. `points` is a chronological array of temps.
 *  The y-scale has a minimum span of 4 °C so sensor noise (±0.3°) renders as a
 *  near-flat line instead of filling the full height. */
function Sparkline({ points, alarm }) {
  if (!points || points.length < 2) return <div className="card-spark" />
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = Math.max(max - min, 4)
  const lo = (max + min) / 2 - span / 2
  const step = 100 / (points.length - 1)
  const path = points
    .map((v, i) => `${(i * step).toFixed(2)},${(27 - ((v - lo) / span) * 24 + 1.5).toFixed(2)}`)
    .join(' ')
  return (
    <svg className="card-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points={path}
        fill="none"
        stroke={alarm ? 'var(--accent)' : '#a2a3a0'}
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default function SensorCard({ sensor, reading, alert, rule, spark, liveSeenAt = 0, onRename, onDelete, canEdit = true }) {
  const navigate = useNavigate()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showAlert, setShowAlert] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [liveNote, setLiveNote] = useState('')
  const [nowTs, setNowTs] = useState(() => Date.now())
  // Shows the chip on click instead of waiting for the next poll. Cleared
  // once the server's own state says something.
  const [liveLocal, setLiveLocal] = useState(null)
  // Calibration and reporting cadence affect the integrity of the temperature
  // record, so this is superadmin-only rather than an org-level permission.
  const { user: cfgUser } = useAuth()
  const canConfigure = cfgUser?.role === 'superadmin'

  const status = getStatus(reading?.recorded_at)

  // A failed probe is a node that is online and reporting, just with no
  // temperature in it. Without its own chip it reads as OK with a blank
  // reading, which is the one interpretation that is definitely wrong.
  const probeError = sensor.probe_error === true

  // Chip: ALARM wins, then a broken probe; otherwise connection status
  const chip = alert
    ? { label: 'ALARM', cls: 'alarm' }
    : probeError ? { label: 'PROBE ERROR', cls: 'offline' }
    : status === 'offline' ? { label: 'OFFLINE', cls: 'offline' }
    : status === 'stale'   ? { label: 'STALE',   cls: 'stale' }
    : status === 'unknown' ? { label: 'NO DATA', cls: '' }
    : { label: 'OK', cls: '' }

  // Limit note from the sensor's alert rule
  const limitParts = []
  if (rule?.enabled) {
    if (rule.high_limit != null) limitParts.push(`max ${rule.high_limit}°`)
    if (rule.low_limit != null) limitParts.push(`min ${rule.low_limit}°`)
  }

  function startEdit(e) {
    e.stopPropagation()
    setDraft(sensor.name || '')
    setEditing(true)
  }

  function cancelEdit(e) {
    e.stopPropagation()
    setEditing(false)
  }

  async function saveEdit(e) {
    e.stopPropagation()
    const name = draft.trim()
    if (!name) { setEditing(false); return }
    setSaving(true)
    try {
      await api.put(`/sensors/${sensor.id}`, { name })
      onRename(sensor.id, name)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') saveEdit(e)
    if (e.key === 'Escape') cancelEdit(e)
  }

  async function handleDelete(e) {
    e.stopPropagation()
    const ok = await toast.confirm({
      title: 'Remove sensor?',
      message: `"${sensor.name || sensor.mac}" and all its readings will be permanently deleted.`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    setDeleting(true)
    try {
      await api.delete(`/sensors/${sensor.id}`)
      onDelete(sensor.id)
      toast.success('Sensor removed')
    } catch {
      toast.error('Failed to remove sensor')
    } finally {
      setDeleting(false)
    }
  }

  // A sleeping node cannot be woken on demand, so this extends a wake it was
  // going to have anyway. The wait is up to one reporting interval.
  async function requestLive(e) {
    e.stopPropagation()
    setLiveNote('requesting…')
    try {
      const res = await api.post(`/sensors/${sensor.id}/live`, {})
      setLiveLocal({ requestedAt: Date.now() })
      const mins = Math.round((res.data.starts_within_secs || 900) / 60)
      setLiveNote(`queued — starts on the sensor's next wake (up to ~${mins} min, `
                + `or press its button to start now)`)
    } catch {
      setLiveNote('request failed')
    }
    setTimeout(() => setLiveNote(''), 12000)
  }

  async function stopLive(e) {
    e.stopPropagation()
    setLiveNote('stopping…')
    try {
      await api.delete(`/sensors/${sensor.id}/live`)
      setLiveLocal({ cleared: true })
      setLiveNote('stopped')
    } catch {
      setLiveNote('stop failed')
    }
    setTimeout(() => setLiveNote(''), 8000)
  }

  function openAlert(e) {
    e.stopPropagation()
    setShowAlert(true)
  }

  // live_until is set only once the hub reports the request reaching the node.
  // live_requested_at covers the gap before that, which lasts until the sensor
  // next wakes -- bounded here so a request to a node that never answers stops
  // claiming to be pending forever.
  const sleepSecs   = Number(sensor.cfg_sleep_secs) || 900
  const liveUntil   = !liveLocal?.cleared && sensor.live_until
                        ? new Date(sensor.live_until).getTime() : 0
  // Two independent signals. live_until is what the hub confirmed; liveSeenAt
  // is the node reporting faster than its own interval, which is the behaviour
  // itself rather than a report of it. Either one is enough.
  const seenLive    = !liveLocal?.cleared && liveSeenAt > 0 && nowTs - liveSeenAt < 45000
  const isLive      = liveUntil > nowTs || seenLive
  const liveReqAt   = liveLocal?.cleared ? 0
                      : sensor.live_requested_at ? new Date(sensor.live_requested_at).getTime()
                      : liveLocal?.requestedAt || 0
  const livePending = !isLive && liveReqAt > 0 &&
                      nowTs - liveReqAt < (sleepSecs + 120) * 1000
  const liveLeft    = isLive ? Math.max(0, Math.round((liveUntil - nowTs) / 1000)) : 0

  // The sleep interval is fixed, so the wake a queued request is waiting for is
  // predictable from the last reading. "Waking" on its own reads as indefinite;
  // a number turns the same wait into something you can decide to sit through.
  const nextWakeIn = (() => {
    // From the reading itself, not from the sensor row: lastUpdate arrives as a
    // bigint, which node-postgres hands over as a string, and adding seconds to
    // a string concatenates instead of adding.
    const lastAt = reading?.recorded_at ? new Date(reading.recorded_at).getTime() : 0
    if (!livePending || !lastAt) return null
    const due = lastAt + sleepSecs * 1000
    const secs = Math.round((due - nowTs) / 1000)
    if (secs <= 30) return 'any moment'
    if (secs < 90)  return `~${secs}s`
    return `~${Math.round(secs / 60)}m`
  })()

  useEffect(() => {
    if (!isLive && !livePending) return
    const t = setInterval(() => setNowTs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [isLive, livePending])

  return (
    <div
      className={`sensor-card${alert ? ' breached' : ''}`}
      onClick={editing ? undefined : () => navigate(`/history?sensor=${sensor.id}`)}
      title={editing ? undefined : 'Click to view history'}
    >
      <div className="card-eyebrow-row">
        <span className="card-eyebrow">{sensor.hub_name || sensor.hub_mac || 'Sensor'}</span>
        {isLive && (
          <span className="chip live">
            <span className="dot">●</span> live{liveLeft > 0 ? ` ${liveLeft}s` : ''}
          </span>
        )}
        {livePending && (
          <span className="chip waking" title="Waiting for the sensor's next wake — press its button to start now">
            ◌ waking{nextWakeIn ? ` ${nextWakeIn}` : ''}
          </span>
        )}
        <span className={`chip ${chip.cls}`}>{chip.label}</span>
      </div>

      <div className="sensor-card-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <div className="sensor-rename-form" onClick={(e) => e.stopPropagation()}>
              <input
                className="sensor-rename-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                maxLength={64}
                autoFocus
              />
              <button className="btn btn-sm btn-primary" onClick={saveEdit} disabled={saving}>✓</button>
              <button className="btn btn-sm btn-ghost" onClick={cancelEdit} disabled={saving}>✕</button>
            </div>
          ) : (
            <div className="sensor-name-row">
              <div className="sensor-name">{sensor.name || sensor.mac}</div>
              {canEdit && <button className="sensor-rename-btn" onClick={startEdit} title="Rename sensor">✎</button>}
              {canEdit && <button className="sensor-alert-btn" onClick={openAlert} title="Temperature alerts">🔔</button>}
              {canEdit && (
                isLive || livePending ? (
                  <button
                    className="sensor-alert-btn live-on"
                    onClick={stopLive}
                    title={isLive ? 'Stop reporting and let the sensor sleep'
                                  : 'Cancel the pending live request'}
                  >⏹</button>
                ) : (
                  <button
                    className="sensor-alert-btn"
                    onClick={requestLive}
                    title="Ask this sensor to report repeatedly on its next wake"
                  >⏱</button>
                )
              )}
              {canConfigure && (
                <button
                  className="sensor-rename-btn"
                  onClick={(e) => { e.stopPropagation(); setShowConfig(true) }}
                  title="Interval and calibration"
                >⚙</button>
              )}
              {canEdit && <button className="sensor-delete-btn" onClick={handleDelete} disabled={deleting} title="Remove sensor">✕</button>}
            </div>
          )}
          {!editing && <div className="sensor-mac">{sensor.mac}</div>}
        </div>
      </div>

      <div className="card-reading">
        {reading?.temp != null ? (
          <>
            <span className={`card-temp${alert ? ' alarm' : ''}`}>{fmt(reading.temp)}</span>
            <span className="card-temp-unit">°C</span>
          </>
        ) : (
          <span className="card-temp na">--</span>
        )}
        {reading?.hum != null && (
          <span className="card-limit">RH {fmt(reading.hum, 0)} %</span>
        )}
        {limitParts.length > 0 && (
          <span className="card-limit">{limitParts.join(' · ')}</span>
        )}
      </div>

      <Sparkline points={spark} alarm={!!alert} />

      <div className="sensor-meta">
        <span className="sensor-meta-item">{formatAge(reading?.recorded_at)}</span>
        {reading?.rssi != null && (
          <span className="sensor-meta-item">{reading.rssi} dBm</span>
        )}
        {/* Absent on nodes still running pre-1.0 firmware, which do not report it. */}
        {sensor.fw_version && (
          <span className="sensor-meta-item" title="Sensor firmware version">
            v{sensor.fw_version}
          </span>
        )}
        <BatteryIcon level={reading?.battery} />
      </div>

      {liveNote && <div className="device-meta">{liveNote}</div>}

      {showConfig && (
        <SensorConfigModal sensor={sensor} onClose={() => setShowConfig(false)} />
      )}

      {showAlert && (
        <AlertRuleModal sensor={sensor} onClose={() => setShowAlert(false)} />
      )}
    </div>
  )
}
