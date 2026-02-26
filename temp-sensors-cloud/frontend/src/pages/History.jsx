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

  function selectSensor(id) {
    setSearchParams({ sensor: id, range: rangeHours })
  }

  function selectRange(hours) {
    const params = { range: hours }
    if (sensorId) params.sensor = sensorId
    setSearchParams(params)
  }

  // Compute from/to for the selected range
  const to   = new Date().toISOString()
  const from = new Date(Date.now() - rangeHours * 60 * 60 * 1000).toISOString()

  const selectedSensor = sensors.find((s) => s.id === sensorId)

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">History</h1>
        <p className="page-subtitle">Temperature and humidity over time</p>
      </div>

      <div className="history-controls">
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
                {s.name || `TempSens-${s.mac.replace(/:/g, '').slice(-6)}`}
                {s.hub_name ? ` (${s.hub_name})` : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="range-btns">
          {RANGES.map((r) => (
            <button
              key={r.hours}
              className={`btn btn-ghost${rangeHours === r.hours ? ' active' : ''}`}
              onClick={() => selectRange(r.hours)}
            >
              {r.label}
            </button>
          ))}
        </div>
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
                <strong>{selectedSensor.name || `TempSens-${selectedSensor.mac.replace(/:/g, '').slice(-6)}`}</strong>
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
