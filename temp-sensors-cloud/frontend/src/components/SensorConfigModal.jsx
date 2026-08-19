import { useEffect, useState } from 'react'
import api from '../services/api'

/**
 * Per-sensor remote configuration — superadmin only.
 *
 * Changes are queued, not applied: a sleeping node can only be reached in the
 * brief window after it transmits, so a change takes up to one reporting
 * interval to land. The UI has to make that obvious or it looks broken.
 */
export default function SensorConfigModal({ sensor, onClose }) {
  const [cfg, setCfg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [sleepMins, setSleepMins] = useState('')
  const [offset, setOffset] = useState('')
  const [gain, setGain] = useState('')

  useEffect(() => {
    api.get(`/sensor-config/${sensor.id}`)
      .then((res) => {
        setCfg(res.data)
        setSleepMins(String(Math.round((res.data.cfg_sleep_secs ?? 900) / 60)))
        setOffset(String(res.data.cfg_temp_offset ?? 0))
        setGain(String(res.data.cfg_temp_gain ?? 1))
      })
      .catch(() => setError('Failed to load configuration'))
  }, [sensor.id])

  async function handleSave(e) {
    e.preventDefault()
    setError(''); setNotice('')

    const payload = {
      sleep_secs:  Math.round(Number(sleepMins) * 60),
      temp_offset: Number(offset),
      temp_gain:   Number(gain),
    }

    const changesCalibration =
      payload.temp_offset !== (cfg.cfg_temp_offset ?? 0) ||
      payload.temp_gain !== (cfg.cfg_temp_gain ?? 1)

    if (changesCalibration && !window.confirm(
      'Changing calibration shifts every future reading from this sensor.\n\n' +
      'Past readings are not altered, so the history will show a step at this ' +
      'point. The change is recorded and marked on the chart.\n\nContinue?'
    )) return

    setBusy(true)
    try {
      const res = await api.put(`/sensor-config/${sensor.id}`, payload)
      const mins = Math.round((res.data.applies_within_secs || 900) / 60)
      setNotice(`Queued as v${res.data.cfg_ver} — applies within about ${mins} min, ` +
                `when the sensor next reports.`)
      const fresh = await api.get(`/sensor-config/${sensor.id}`)
      setCfg(fresh.data)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to queue configuration')
    } finally {
      setBusy(false)
    }
  }

  const pending = cfg?.pending

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Sensor configuration</h2>
          <div className="modal-sub">{sensor.name || sensor.mac}</div>
        </div>

        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-ok">{notice}</div>}

        {!cfg ? (
          <p className="form-hint">Loading…</p>
        ) : (
          <>
            {pending && (
              <div className="alert">
                Change v{cfg.cfg_desired_ver} is waiting for this sensor to wake.
                It is still running v{cfg.applied_cfg_ver || 0}.
              </div>
            )}

            <form onSubmit={handleSave}>
              <div className="form-group">
                <label>Reporting interval (minutes)</label>
                <input
                  type="number" min="5" max="60" step="1"
                  value={sleepMins} onChange={(e) => setSleepMins(e.target.value)} required
                />
                <span className="form-hint">
                  5–60 minutes. The one-hour ceiling is deliberate: a change can only
                  reach a sensor while it is awake, so a longer interval would put
                  every future correction that far away.
                </span>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Temperature offset (°C)</label>
                  <input
                    type="number" min="-10" max="10" step="0.01"
                    value={offset} onChange={(e) => setOffset(e.target.value)} required
                  />
                  <span className="form-hint">Added after conversion. ±10 °C.</span>
                </div>
                <div className="form-group">
                  <label>Temperature gain</label>
                  <input
                    type="number" min="0.9" max="1.1" step="0.0001"
                    value={gain} onChange={(e) => setGain(e.target.value)} required
                  />
                  <span className="form-hint">Multiplier, applied first. 0.9–1.1.</span>
                </div>
              </div>

              <p className="form-hint">
                Corrected = gain × raw + offset. Gain corrects a slope error;
                offset alone cannot.
              </p>

              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
                <button className="btn btn-primary" disabled={busy}>
                  {busy ? 'Queueing…' : 'Queue change'}
                </button>
              </div>
            </form>

            {cfg.history?.length > 0 && (
              <>
                <h3 style={{ fontSize: 14, margin: '20px 0 8px' }}>Recent changes</h3>
                {cfg.history.map((h) => (
                  <div className="device-meta" key={h.cfg_ver}>
                    v{h.cfg_ver} · {Math.round(h.sleep_secs / 60)} min ·
                    gain {h.temp_gain} · offset {h.temp_offset > 0 ? '+' : ''}{h.temp_offset} ·{' '}
                    {h.applied_at
                      ? `applied ${new Date(h.applied_at).toLocaleString()}`
                      : 'not yet applied'}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
