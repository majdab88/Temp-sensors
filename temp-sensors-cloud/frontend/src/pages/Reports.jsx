import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import { downloadFile } from '../services/download'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'

const RANGES = [
  { label: '7 d',  days: 7 },
  { label: '30 d', days: 30 },
  { label: '90 d', days: 90 },
  { label: 'All',  days: null },
]

function fmtDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

function fmtDuration(sec) {
  if (sec == null) return '—'
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

export default function Reports() {
  const { user } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const canEdit = user?.permissionLevel !== 'viewer'

  const [sensors, setSensors] = useState([])
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [sensorId, setSensorId] = useState('')
  const [status, setStatus] = useState('all')   // all | active | unacked
  const [days, setDays] = useState(30)
  const [acking, setAcking] = useState(null)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    api.get('/sensors').then((r) => setSensors(r.data)).catch(() => {})
  }, [])

  const filterParams = useCallback(() => {
    const params = {}
    if (sensorId) params.sensor_id = sensorId
    if (status === 'active') params.active = 'true'
    if (status === 'unacked') params.unacked = 'true'
    if (days) params.from = new Date(Date.now() - days * 86400000).toISOString()
    return params
  }, [sensorId, status, days])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/excursions', { params: { ...filterParams(), limit: 500 } })
      setRows(res.data)
      setError(null)
    } catch {
      setError('Failed to load excursion log')
    } finally {
      setLoading(false)
    }
  }, [filterParams])

  useEffect(() => { load() }, [load])

  async function acknowledge(id) {
    setAcking(id)
    try {
      const res = await api.post(`/excursions/${id}/ack`)
      setRows((prev) => prev.map((r) =>
        r.id === id ? { ...r, ack_at: res.data.ack_at, ack_by: res.data.ack_by } : r))
      toast.success('Excursion acknowledged')
    } catch {
      toast.error('Failed to acknowledge — try again')
    }
    finally { setAcking(null) }
  }

  async function exportCsv() {
    setDownloading(true)
    try {
      await downloadFile('/excursions/export.csv', filterParams(), 'excursions.csv')
    } catch {
      toast.error('Export failed — try again')
    }
    finally { setDownloading(false) }
  }

  const activeCount  = rows.filter((r) => !r.ended_at).length
  const unackedCount = rows.filter((r) => !r.ack_at).length

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Reports</h1>
        <p className="page-subtitle">Excursion log — every limit breach, for compliance and sign-off</p>
      </div>

      {/* Summary stats */}
      <div className="report-stats">
        <div className="report-stat">
          <div className="report-stat-num">{rows.length}</div>
          <div className="report-stat-label">Excursions</div>
        </div>
        <div className={`report-stat${activeCount ? ' alarm' : ''}`}>
          <div className="report-stat-num">{activeCount}</div>
          <div className="report-stat-label">Ongoing</div>
        </div>
        <div className={`report-stat${unackedCount ? ' warn' : ''}`}>
          <div className="report-stat-num">{unackedCount}</div>
          <div className="report-stat-label">Unacknowledged</div>
        </div>
      </div>

      {/* Filter / action bar */}
      <div className="report-controls no-print">
        <div className="form-group">
          <label htmlFor="rep-sensor">Sensor</label>
          <select id="rep-sensor" value={sensorId} onChange={(e) => setSensorId(e.target.value)}>
            <option value="">All sensors</option>
            {sensors.map((s) => (
              <option key={s.id} value={s.id}>{s.name || s.mac}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="rep-status">Status</label>
          <select id="rep-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All</option>
            <option value="active">Ongoing</option>
            <option value="unacked">Unacknowledged</option>
          </select>
        </div>

        <div className="range-btns">
          {RANGES.map((r) => (
            <button
              key={r.label}
              className={`btn btn-ghost${days === r.days ? ' active' : ''}`}
              onClick={() => setDays(r.days)}
            >
              {r.label}
            </button>
          ))}
        </div>

        <div className="report-actions">
          <button className="btn btn-ghost" onClick={exportCsv} disabled={downloading || rows.length === 0}>
            {downloading ? 'Exporting…' : 'Export CSV'}
          </button>
          <button className="btn btn-ghost" onClick={() => window.print()} disabled={rows.length === 0}>
            Print / PDF
          </button>
        </div>
      </div>

      {loading ? (
        <div className="state-loading">Loading excursion log…</div>
      ) : error ? (
        <div className="state-error"><h3>Error</h3><p>{error}</p></div>
      ) : rows.length === 0 ? (
        <div className="state-empty">
          <h3>No excursions</h3>
          <p>No limit breaches recorded for this filter — that's a good thing.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="rules-table report-table">
            <thead>
              <tr>
                <th>Sensor</th>
                <th>Type</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Peak</th>
                <th>Limit</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ongoing = !r.ended_at
                return (
                  <tr key={r.id} className={ongoing ? 'firing' : ''}>
                    <td>
                      <button className="ex-row-link" onClick={() => navigate(`/reports/${r.id}`)} title="View excursion detail">
                        <div className="rule-name">{r.sensor_name || r.sensor_mac}</div>
                        <div className="rule-sub">{r.hub_name || r.hub_mac}</div>
                      </button>
                    </td>
                    <td>
                      <span className={`ex-kind ex-kind-${r.kind}`}>
                        {r.kind === 'high' ? 'Over' : 'Under'}
                      </span>
                    </td>
                    <td className="rule-cond">{fmtDateTime(r.started_at)}</td>
                    <td className="rule-cond">
                      {ongoing ? <span className="ex-ongoing">ongoing</span> : fmtDuration(r.duration_s)}
                    </td>
                    <td className="rule-cond">{r.peak_value != null ? `${Number(r.peak_value).toFixed(1)}°` : '—'}</td>
                    <td className="rule-cond">{r.limit_value != null ? `${Number(r.limit_value).toFixed(1)}°` : '—'}</td>
                    <td>
                      {r.ack_at ? (
                        <span className="ex-acked" title={fmtDateTime(r.ack_at)}>
                          ✓ {r.ack_by || 'acknowledged'}
                        </span>
                      ) : canEdit ? (
                        <button
                          className="link-btn"
                          disabled={acking === r.id}
                          onClick={() => acknowledge(r.id)}
                        >
                          {acking === r.id ? 'Acknowledging…' : 'Acknowledge'}
                        </button>
                      ) : (
                        <span className="ex-unacked">Unacknowledged</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
