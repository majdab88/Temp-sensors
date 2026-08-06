import React, { useEffect, useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import api from '../services/api'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler)

const TEMP_COLOR = '#e63a11' // vermilion — matches the alarm-panel design system
const HUM_COLOR  = '#2563eb'

function formatLabel(isoStr) {
  const d = new Date(isoStr)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Full timestamp with seconds for the table so drift is immediately visible
function formatTimestamp(isoStr) {
  if (!isoStr) return '—'
  return new Date(isoStr).toLocaleString(undefined, {
    year:   'numeric',
    month:  'short',
    day:    'numeric',
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

// Mean Kinetic Temperature (Arrhenius-weighted) — the pharma/cold-chain summary
// statistic that penalises time spent warm more than a plain average does.
// ΔH = 83.144 kJ/mol (standard), R = 8.314 J/mol·K → ΔH/R = 10000 K.
function meanKineticTemp(temps) {
  const dHoverR = 83144 / 8.314
  const sum = temps.reduce((acc, t) => acc + Math.exp(-dHoverR / (t + 273.15)), 0)
  return dHoverR / -Math.log(sum / temps.length) - 273.15
}

function computeStats(temps, high, low) {
  if (temps.length === 0) return null
  const min = Math.min(...temps)
  const max = Math.max(...temps)
  const avg = temps.reduce((a, b) => a + b, 0) / temps.length
  const mkt = meanKineticTemp(temps)
  let inRange = null
  if (high != null || low != null) {
    const ok = temps.filter((t) => (high == null || t <= high) && (low == null || t >= low)).length
    inRange = (ok / temps.length) * 100
  }
  return { min, max, avg, mkt, inRange }
}

// Draw shaded danger zones + dashed lines at the configured limits, behind the data.
const thresholdPlugin = {
  id: 'thresholds',
  beforeDatasetsDraw(chart, _args, opts) {
    const y = chart.scales.yTemp
    if (!y) return
    const { high, low } = opts || {}
    const { ctx, chartArea } = chart
    const line = (val, stroke, fill, fillFromTop) => {
      const py = y.getPixelForValue(val)
      if (py < chartArea.top || py > chartArea.bottom) return
      ctx.save()
      ctx.fillStyle = fill
      if (fillFromTop) ctx.fillRect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, py - chartArea.top)
      else             ctx.fillRect(chartArea.left, py, chartArea.right - chartArea.left, chartArea.bottom - py)
      ctx.strokeStyle = stroke
      ctx.setLineDash([5, 4])
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(chartArea.left, py)
      ctx.lineTo(chartArea.right, py)
      ctx.stroke()
      ctx.restore()
    }
    if (high != null) line(high, 'rgba(230,58,17,0.65)', 'rgba(230,58,17,0.06)', true)
    if (low  != null) line(low,  'rgba(37,99,235,0.65)', 'rgba(37,99,235,0.06)', false)
  },
}

export default function ReadingChart({ sensorId, from, to }) {
  const [readings, setReadings] = useState([])
  const [rule, setRule] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!sensorId) return
    setLoading(true)
    setError(null)

    const params = { limit: 500 }
    if (from) params.from = from
    if (to) params.to = to

    api.get(`/sensors/${sensorId}/readings`, { params })
      .then((res) => {
        // API returns DESC; reverse so chart flows left-to-right (oldest first)
        setReadings([...res.data].reverse())
      })
      .catch(() => setError('Failed to load readings'))
      .finally(() => setLoading(false))

    // Rule (limits) for threshold bands + in-range stat — optional
    api.get(`/alerts/rules/${sensorId}`)
      .then((res) => setRule(res.data || null))
      .catch(() => setRule(null))
  }, [sensorId, from, to])

  if (loading) return <div className="state-loading">Loading chart data...</div>
  if (error)   return <div className="state-error"><h3>{error}</h3></div>
  if (readings.length === 0) return <div className="state-empty"><h3>No readings</h3><p>No data for the selected time range</p></div>

  // Thin points when there are many readings to keep the chart readable
  const pointRadius = readings.length > 80 ? 0 : 3

  const high = rule?.enabled ? rule.high_limit : null
  const low  = rule?.enabled ? rule.low_limit  : null

  const temps = readings.map((r) => r.temp).filter((t) => t != null)
  const stats = computeStats(temps, high, low)

  // Enforce a minimum 25 °C window on the temperature axis, centered on the
  // data, with bounds snapped to multiples of 5. Without this, Chart.js
  // auto-fits the axis to the data range and normal daily drift fills the
  // whole chart height, reading as a dramatic swing. Real excursions beyond
  // the window still expand the axis as usual. Threshold lines are also kept
  // in view so the danger zones are always visible.
  const MIN_TEMP_SPAN = 25
  let yTempMin, yTempMax
  if (temps.length > 0) {
    const extra = [high, low].filter((v) => v != null)
    const lo = Math.min(...temps, ...extra)
    const hi = Math.max(...temps, ...extra)
    const span = Math.max(hi - lo + 4, MIN_TEMP_SPAN)
    const mid = (hi + lo) / 2
    yTempMin = Math.floor((mid - span / 2) / 5) * 5
    yTempMax = Math.ceil((mid + span / 2) / 5) * 5
  }

  const labels = readings.map((r) => formatLabel(r.recorded_at))

  const data = {
    labels,
    datasets: [
      {
        label: 'Temperature (°C)',
        data: readings.map((r) => r.temp),
        borderColor: TEMP_COLOR,
        backgroundColor: 'rgba(230, 58, 17, 0.08)',
        yAxisID: 'yTemp',
        tension: 0.3,
        pointRadius,
        borderWidth: 2,
        fill: true,
        spanGaps: true,
      },
      {
        label: 'Humidity (%)',
        data: readings.map((r) => r.hum),
        borderColor: HUM_COLOR,
        backgroundColor: 'rgba(37, 99, 235, 0.08)',
        yAxisID: 'yHum',
        tension: 0.3,
        pointRadius,
        borderWidth: 2,
        fill: true,
        spanGaps: true,
      },
    ],
  }

  const options = {
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top' },
      title: { display: false },
      thresholds: { high, low },
    },
    scales: {
      x: {
        ticks: {
          maxTicksLimit: 10,
          maxRotation: 30,
          font: { size: 11 },
          color: '#94a3b8',
        },
        grid: { color: '#f1f5f9' },
      },
      yTemp: {
        type: 'linear',
        display: true,
        position: 'left',
        min: yTempMin,
        max: yTempMax,
        title: { display: true, text: '°C', color: TEMP_COLOR, font: { size: 12 } },
        ticks: { color: TEMP_COLOR, font: { size: 11 } },
        grid: { color: '#f1f5f9' },
      },
      yHum: {
        type: 'linear',
        display: true,
        position: 'right',
        title: { display: true, text: '%', color: HUM_COLOR, font: { size: 12 } },
        ticks: { color: HUM_COLOR, font: { size: 11 } },
        grid: { drawOnChartArea: false },
        min: 0,
        max: 100,
      },
    },
  }

  // Table shows newest first
  const tableRows = [...readings].reverse()

  return (
    <>
      {stats && (
        <div className="chart-stats">
          <div className="chart-stat">
            <span className="chart-stat-label">Min</span>
            <span className="chart-stat-val">{stats.min.toFixed(1)}°</span>
          </div>
          <div className="chart-stat">
            <span className="chart-stat-label">Max</span>
            <span className="chart-stat-val">{stats.max.toFixed(1)}°</span>
          </div>
          <div className="chart-stat">
            <span className="chart-stat-label">Avg</span>
            <span className="chart-stat-val">{stats.avg.toFixed(1)}°</span>
          </div>
          <div className="chart-stat" title="Mean Kinetic Temperature — Arrhenius-weighted average used in cold-chain compliance">
            <span className="chart-stat-label">MKT</span>
            <span className="chart-stat-val">{stats.mkt.toFixed(1)}°</span>
          </div>
          {stats.inRange != null && (
            <div className={`chart-stat${stats.inRange < 100 ? ' warn' : ' ok'}`}>
              <span className="chart-stat-label">In range</span>
              <span className="chart-stat-val">{stats.inRange.toFixed(1)}%</span>
            </div>
          )}
        </div>
      )}

      <Line data={data} options={options} plugins={[thresholdPlugin]} />

      <div style={{ marginTop: 32 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-2)', marginBottom: 10 }}>
          Readings ({readings.length})
        </h3>
        <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Time (stored)</th>
                <th style={{ color: TEMP_COLOR }}>Temp (°C)</th>
                <th style={{ color: HUM_COLOR }}>Humidity (%)</th>
                <th>RSSI</th>
                <th>Battery</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r, i) => (
                <tr key={r.id}>
                  <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{readings.length - i}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                    {formatTimestamp(r.recorded_at)}
                  </td>
                  <td style={{ fontWeight: 600, color: TEMP_COLOR }}>
                    {r.temp != null ? r.temp.toFixed(2) : '—'}
                  </td>
                  <td style={{ fontWeight: 600, color: HUM_COLOR }}>
                    {r.hum != null ? r.hum.toFixed(1) : '—'}
                  </td>
                  <td style={{ color: 'var(--text-3)' }}>
                    {r.rssi != null ? `${r.rssi} dBm` : '—'}
                  </td>
                  <td style={{ color: 'var(--text-3)' }}>
                    {r.battery != null && r.battery !== 255 ? `${r.battery}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
