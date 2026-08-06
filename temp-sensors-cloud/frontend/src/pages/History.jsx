import React, { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import ReadingChart from '../components/ReadingChart'
import api from '../services/api'

const RANGES = [
  { label: '24 h', hours: 24 },
  { label: '7 d',  hours: 24 * 7 },
  { label: '30 d', hours: 24 * 30 },
]

export default function History() {
  const [searchParams, setSearchParams] = useSearchParams()
  const sensorId = searchParams.get('sensor') ? parseInt(searchParams.get('sensor'), 10) : null
  const rangeHours = parseInt(searchParams.get('range') || '24', 10)

  const [sensors, setSensors] = useState([])
  const [loadingSensors, setLoadingSensors] = useState(true)

  useEffect(() => {
    api.get('/sensors')
      .then((res) => setSensors(res.data))
      .catch(console.error)
      .finally(() => setLoadingSensors(false))
  }, [])

  const customFrom = searchParams.get('from') || ''
  const customTo   = searchParams.get('to')   || ''
  const isCustom   = !!(customFrom && customTo)

  function selectSensor(id) {
    const params = { sensor: id }
    if (isCustom) { params.from = customFrom; params.to = customTo }
    else params.range = rangeHours
    setSearchParams(params)
  }

  function selectRange(hours) {
    const params = { range: hours }
    if (sensorId) params.sensor = sensorId
    setSearchParams(params) // drops any custom from/to
  }

  function setCustom(key, value) {
    const params = { from: customFrom, to: customTo, [key]: value }
    if (sensorId) params.sensor = sensorId
    // Only commit once both ends are set; otherwise stash the partial value
    setSearchParams(params)
  }

  // Compute from/to: an explicit custom range wins over the preset buttons.
  let from, to
  if (isCustom) {
    from = new Date(`${customFrom}T00:00:00`).toISOString()
    to   = new Date(`${customTo}T23:59:59`).toISOString()
  } else {
    to   = new Date().toISOString()
    from = new Date(Date.now() - rangeHours * 60 * 60 * 1000).toISOString()
  }

  const selectedSensor = sensors.find((s) => s.id === sensorId)
  const rangeText = isCustom
    ? `${customFrom} → ${customTo}`
    : (RANGES.find((r) => r.hours === rangeHours)?.label || `${rangeHours} h`)

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">History</h1>
        <p className="page-subtitle">Temperature and humidity over time</p>
      </div>

      {/* Print-only report header (shown on the PDF/printout) */}
      {sensorId && selectedSensor && (
        <div className="print-only print-report-head">
          <h2>Temperature History Report</h2>
          <div>{selectedSensor.name || selectedSensor.mac} · {selectedSensor.mac}{selectedSensor.hub_name ? ` · Hub: ${selectedSensor.hub_name}` : ''}</div>
          <div>Range: {rangeText} · Generated {new Date().toLocaleString()}</div>
        </div>
      )}

      <div className="history-controls no-print">
        <div className="form-group">
          <label htmlFor="sensor-select">Sensor</label>
          <select
            id="sensor-select"
            value={sensorId || ''}
            onChange={(e) => selectSensor(e.target.value)}
            disabled={loadingSensors}
          >
            <option value="">-- Select a sensor --</option>
            {sensors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.mac}
                {s.hub_name ? ` (${s.hub_name})` : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="range-btns">
          {RANGES.map((r) => (
            <button
              key={r.hours}
              className={`btn btn-ghost${!isCustom && rangeHours === r.hours ? ' active' : ''}`}
              onClick={() => selectRange(r.hours)}
            >
              {r.label}
            </button>
          ))}
        </div>

        <div className="custom-range">
          <span className="custom-range-label">Custom</span>
          <input
            type="date"
            value={customFrom}
            max={customTo || undefined}
            onChange={(e) => setCustom('from', e.target.value)}
          />
          <span className="custom-range-sep">→</span>
          <input
            type="date"
            value={customTo}
            min={customFrom || undefined}
            onChange={(e) => setCustom('to', e.target.value)}
          />
        </div>

        <button
          className="btn btn-ghost history-pdf-btn"
          disabled={!sensorId}
          onClick={() => window.print()}
          title="Save this chart + readings as a PDF"
        >
          PDF report
        </button>
      </div>

      <div className="chart-wrap">
        {!sensorId ? (
          <div className="state-empty">
            <h3>Select a sensor</h3>
            <p>Choose a sensor above to view its history</p>
          </div>
        ) : (
          <>
            {selectedSensor && (
              <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-2)' }}>
                <strong>{selectedSensor.name || selectedSensor.mac}</strong>
                {' — '}{selectedSensor.mac}
                {selectedSensor.hub_name ? ` — Hub: ${selectedSensor.hub_name}` : ''}
              </div>
            )}
            <ReadingChart sensorId={sensorId} from={from} to={to} />
          </>
        )}
      </div>
    </div>
  )
}
