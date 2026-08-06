import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import AlertRuleModal from './AlertRuleModal'
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

export default function SensorCard({ sensor, reading, alert, rule, spark, onRename, onDelete, canEdit = true }) {
  const navigate = useNavigate()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showAlert, setShowAlert] = useState(false)

  const status = getStatus(reading?.recorded_at)

  // Chip: ALARM wins; otherwise connection status
  const chip = alert
    ? { label: 'ALARM', cls: 'alarm' }
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

  function openAlert(e) {
    e.stopPropagation()
    setShowAlert(true)
  }

  return (
    <div
      className={`sensor-card${alert ? ' breached' : ''}`}
      onClick={editing ? undefined : () => navigate(`/history?sensor=${sensor.id}`)}
      title={editing ? undefined : 'Click to view history'}
    >
      <div className="card-eyebrow-row">
        <span className="card-eyebrow">{sensor.hub_name || sensor.hub_mac || 'Sensor'}</span>
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
        <BatteryIcon level={reading?.battery} />
      </div>

      {showAlert && (
        <AlertRuleModal sensor={sensor} onClose={() => setShowAlert(false)} />
      )}
    </div>
  )
}
