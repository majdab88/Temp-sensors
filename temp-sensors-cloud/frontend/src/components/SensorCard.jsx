import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'

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
  if (!recordedAt) return 'No data'
  const ageMs = Date.now() - new Date(recordedAt).getTime()
  const mins = Math.floor(ageMs / 60_000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} h ago`
  return `${Math.floor(hrs / 24)} d ago`
}

function fmt(val, decimals = 1) {
  if (val == null) return null
  return Number(val).toFixed(decimals)
}

export default function SensorCard({ sensor, reading, onRename }) {
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const status = getStatus(reading?.recorded_at)
  const statusLabel = { online: 'Online', stale: 'Stale', offline: 'Offline', unknown: 'No data' }[status]

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

  return (
    <div
      className="sensor-card"
      onClick={editing ? undefined : () => navigate(`/history?sensor=${sensor.id}`)}
      title={editing ? undefined : 'Click to view history'}
    >
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
              <button className="sensor-rename-btn" onClick={startEdit} title="Rename sensor">✎</button>
            </div>
          )}
          {!editing && <div className="sensor-mac">{sensor.mac}</div>}
        </div>
        <div className={`status-dot ${status}`} title={statusLabel} />
      </div>

      <div className="sensor-readings">
        <div className="reading-item">
          <div className="reading-label">Temp</div>
          {reading?.temp != null
            ? <div className="reading-value temp">{fmt(reading.temp)}<span className="reading-unit">°C</span></div>
            : <div className="reading-value na">--</div>
          }
        </div>
        <div className="reading-item">
          <div className="reading-label">Humidity</div>
          {reading?.hum != null
            ? <div className="reading-value hum">{fmt(reading.hum)}<span className="reading-unit">%</span></div>
            : <div className="reading-value na">--</div>
          }
        </div>
      </div>

      <div className="sensor-meta">
        <span className="sensor-meta-item">{formatAge(reading?.recorded_at)}</span>
        {reading?.rssi != null && (
          <span className="sensor-meta-item">RSSI {reading.rssi} dBm</span>
        )}
        {reading?.battery != null && reading.battery !== 255 && (
          <span className="sensor-meta-item">Bat {reading.battery}%</span>
        )}
        {sensor.hub_name && (
          <span className="sensor-meta-item">Hub: {sensor.hub_name}</span>
        )}
      </div>
    </div>
  )
}
