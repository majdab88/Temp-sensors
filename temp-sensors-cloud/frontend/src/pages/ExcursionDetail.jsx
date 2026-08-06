import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../services/api'
import { downloadFile } from '../services/download'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'

function fmtDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtDuration(sec) {
  if (sec == null) return '—'
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

// Compact SVG chart of the breach window: temperature line, dashed limit line,
// shaded breach region (started_at → ended_at), and a marked peak point.
function BreachChart({ excursion, readings }) {
  const W = 760, H = 280
  const padL = 44, padR = 16, padT = 16, padB = 28
  const pts = readings.filter((r) => r.temp != null)
  if (pts.length < 2) return <div className="state-empty" style={{ margin: 0 }}><p>Not enough readings to chart this window.</p></div>

  const times = pts.map((r) => new Date(r.recorded_at).getTime())
  const temps = pts.map((r) => r.temp)
  const t0 = times[0], t1 = times[times.length - 1]
  const limit = excursion.limit_value
  const lo = Math.min(...temps, limit ?? Infinity)
  const hi = Math.max(...temps, limit ?? -Infinity)
  const span = Math.max(hi - lo, 4)
  const yMin = lo - span * 0.15
  const yMax = hi + span * 0.15

  const x = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * (W - padL - padR)
  const y = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * (H - padT - padB)

  const line = pts.map((r, i) => `${x(times[i]).toFixed(1)},${y(r.temp).toFixed(1)}`).join(' ')

  const bStart = x(Math.max(t0, new Date(excursion.started_at).getTime()))
  const bEnd = x(excursion.ended_at ? Math.min(t1, new Date(excursion.ended_at).getTime()) : t1)

  const peakV = excursion.kind === 'high' ? Math.max(...temps) : Math.min(...temps)
  const peakI = temps.indexOf(peakV)

  const yTicks = [yMin, (yMin + yMax) / 2, yMax]

  return (
    <svg className="breach-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Excursion temperature chart">
      {/* breach region shading */}
      <rect x={bStart} y={padT} width={Math.max(0, bEnd - bStart)} height={H - padT - padB} className="breach-band" />
      {/* y grid + labels */}
      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} className="breach-grid" />
          <text x={padL - 6} y={y(v) + 3} className="breach-ylabel" textAnchor="end">{v.toFixed(1)}°</text>
        </g>
      ))}
      {/* limit line */}
      {limit != null && (
        <g>
          <line x1={padL} y1={y(limit)} x2={W - padR} y2={y(limit)} className="breach-limit" />
          <text x={W - padR} y={y(limit) - 4} className="breach-limit-label" textAnchor="end">limit {limit}°</text>
        </g>
      )}
      {/* temperature line */}
      <polyline points={line} className="breach-line" fill="none" />
      {/* peak marker */}
      <circle cx={x(times[peakI])} cy={y(peakV)} r="4" className="breach-peak" />
      <text x={x(times[peakI])} y={y(peakV) - 8} className="breach-peak-label" textAnchor="middle">peak {peakV.toFixed(1)}°</text>
      {/* x labels */}
      <text x={padL} y={H - 8} className="breach-xlabel" textAnchor="start">{fmtDateTime(pts[0].recorded_at)}</text>
      <text x={W - padR} y={H - 8} className="breach-xlabel" textAnchor="end">{fmtDateTime(pts[pts.length - 1].recorded_at)}</text>
    </svg>
  )
}

export default function ExcursionDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const toast = useToast()
  const canEdit = user?.permissionLevel !== 'viewer'

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [acking, setAcking] = useState(false)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    setLoading(true)
    api.get(`/excursions/${id}`)
      .then((res) => { setData(res.data); setError(null) })
      .catch(() => setError('Excursion not found'))
      .finally(() => setLoading(false))
  }, [id])

  async function acknowledge() {
    setAcking(true)
    try {
      const res = await api.post(`/excursions/${id}/ack`)
      setData((d) => ({ ...d, excursion: { ...d.excursion, ack_at: res.data.ack_at, ack_by: res.data.ack_by } }))
      toast.success('Excursion acknowledged')
    } catch { toast.error('Failed to acknowledge — try again') }
    finally { setAcking(false) }
  }

  async function exportReadings() {
    const ex = data.excursion
    const PAD_MS = 30 * 60 * 1000
    const from = new Date(new Date(ex.started_at).getTime() - PAD_MS).toISOString()
    const to = new Date((ex.ended_at ? new Date(ex.ended_at).getTime() : Date.now()) + PAD_MS).toISOString()
    setDownloading(true)
    try {
      await downloadFile(`/sensors/${ex.sensor_id}/readings/export.csv`, { from, to }, `excursion-${id}-readings.csv`)
    } catch { toast.error('Export failed — try again') }
    finally { setDownloading(false) }
  }

  if (loading) return <div className="state-loading">Loading excursion…</div>
  if (error) return <div className="state-error"><h3>{error}</h3><button className="btn btn-ghost" onClick={() => navigate('/reports')}>Back to Reports</button></div>

  const ex = data.excursion
  const ongoing = !ex.ended_at

  return (
    <div>
      <button className="link-btn no-print" onClick={() => navigate('/reports')} style={{ marginBottom: 8, paddingLeft: 0 }}>← Reports</button>

      <div className="page-header">
        <h1 className="page-title">{ex.sensor_name || ex.sensor_mac}</h1>
        <p className="page-subtitle">
          {ex.kind === 'high' ? 'Over-temperature' : 'Under-temperature'} excursion · {ex.hub_name || ex.hub_mac}
        </p>
      </div>

      <div className="report-stats">
        <div className={`report-stat${ongoing ? ' alarm' : ''}`}>
          <div className="report-stat-num">{ex.peak_value != null ? `${Number(ex.peak_value).toFixed(1)}°` : '—'}</div>
          <div className="report-stat-label">Peak</div>
        </div>
        <div className="report-stat">
          <div className="report-stat-num">{ex.limit_value != null ? `${Number(ex.limit_value).toFixed(1)}°` : '—'}</div>
          <div className="report-stat-label">Limit</div>
        </div>
        <div className="report-stat">
          <div className="report-stat-num">{ongoing ? '—' : fmtDuration(ex.duration_s)}</div>
          <div className="report-stat-label">{ongoing ? 'Ongoing' : 'Duration'}</div>
        </div>
      </div>

      <div className="ex-detail-meta">
        <div><span className="ex-meta-k">Started</span> {fmtDateTime(ex.started_at)}</div>
        <div><span className="ex-meta-k">Ended</span> {ex.ended_at ? fmtDateTime(ex.ended_at) : <span className="ex-ongoing">ongoing</span>}</div>
        <div>
          <span className="ex-meta-k">Status</span>{' '}
          {ex.ack_at
            ? <span className="ex-acked">✓ {ex.ack_by || 'acknowledged'} · {fmtDateTime(ex.ack_at)}</span>
            : <span className="ex-unacked">Unacknowledged</span>}
        </div>
      </div>

      <div className="ex-detail-actions no-print">
        {canEdit && !ex.ack_at && (
          <button className="btn btn-primary" onClick={acknowledge} disabled={acking}>
            {acking ? 'Acknowledging…' : 'Acknowledge'}
          </button>
        )}
        <button className="btn btn-ghost" onClick={exportReadings} disabled={downloading}>
          {downloading ? 'Exporting…' : 'Export readings CSV'}
        </button>
        <button className="btn btn-ghost" onClick={() => window.print()}>Print / PDF</button>
      </div>

      <div className="ex-detail-chart">
        <BreachChart excursion={ex} readings={data.readings} />
      </div>
    </div>
  )
}
