import { useEffect, useState } from 'react'
import api from '../services/api'

/**
 * Per-sensor remote configuration — superadmin only.
 *
 * Changes are queued, not applied: a sleeping node can only be reached in the
 * brief window after it transmits, so a change takes up to one reporting
 * interval to land. The UI has to make that obvious or it looks broken.
 */
// Coefficients are tiny numbers whose full float expansion is unreadable and
// wraps the layout. Four significant figures is more than the hardware
// resolves, and keeps a row on one line.
function coef(v) {
  if (v == null) return '—'
  const n = Number(v)
  return Math.abs(n) < 0.01 ? n.toExponential(3) : n.toFixed(4)
}

function whenLabel(iso) {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

export default function SensorConfigModal({ sensor, onClose }) {
  const [cfg, setCfg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [sleepMins, setSleepMins] = useState('')
  const [shA, setShA] = useState('')
  const [shB, setShB] = useState('')
  const [shC, setShC] = useState('')
  const [rSeries, setRSeries] = useState('')

  useEffect(() => {
    api.get(`/sensor-config/${sensor.id}`)
      .then((res) => {
        setCfg(res.data)
        setSleepMins(String(Math.round((res.data.cfg_sleep_secs ?? 900) / 60)))
        setShA(String(res.data.cfg_sh_a ?? 2.535e-3))
        setShB(String(res.data.cfg_sh_b ?? 3.01e-5))
        setShC(String(res.data.cfg_sh_c ?? 7.23e-7))
        setRSeries(String(res.data.cfg_r_series ?? 10000))
      })
      .catch(() => setError('Failed to load configuration'))
  }, [sensor.id])

  async function handleSave(e) {
    e.preventDefault()
    setError(''); setNotice('')

    const payload = {
      sleep_secs: Math.round(Number(sleepMins) * 60),
      sh_a:       Number(shA),
      sh_b:       Number(shB),
      sh_c:       Number(shC),
      r_series:   Number(rSeries),
    }

    const changesCalibration =
      payload.sh_a !== cfg.cfg_sh_a || payload.sh_b !== cfg.cfg_sh_b ||
      payload.sh_c !== cfg.cfg_sh_c || payload.r_series !== cfg.cfg_r_series

    if (changesCalibration && !window.confirm(
      'Changing calibration shifts every future reading from this sensor.\n\n' +
      'Past readings are not altered, so the history will show a step at this ' +
      'point. The change is recorded and marked on the chart.\n\nContinue?'
    )) return

    setBusy(true)
    try {
      const res = await api.put(`/sensor-config/${sensor.id}`, payload)
      if (res.data.unchanged) {
        setNotice('No change — these are the settings already queued for this sensor.')
      } else {
        const mins = Math.round((res.data.applies_within_secs || 900) / 60)
        setNotice(`Queued — applies within about ${mins} min, when the sensor next reports.`)
      }
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
                A change is waiting for this sensor to wake — it is still running
                its previous settings. Applies on the next reading.
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

              <div className="form-group">
                <label>Series resistor (Ω)</label>
                <input
                  type="text" inputMode="decimal"
                  value={rSeries} onChange={(e) => setRSeries(e.target.value)} required
                />
                <span className="form-hint">
                  The measured value of the divider resistor on this board. Its
                  tolerance biases every resistance reading, so measuring it is the
                  cheapest accuracy win available.
                </span>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Steinhart-Hart A</label>
                  <input type="text" inputMode="decimal" value={shA}
                         onChange={(e) => setShA(e.target.value)} required />
                </div>
                <div className="form-group">
                  <label>B</label>
                  <input type="text" inputMode="decimal" value={shB}
                         onChange={(e) => setShB(e.target.value)} required />
                </div>
                <div className="form-group">
                  <label>C</label>
                  <input type="text" inputMode="decimal" value={shC}
                         onChange={(e) => setShC(e.target.value)} required />
                </div>
              </div>

              <p className="form-hint">
                1/T(K) = A + B·ln(R) + C·ln(R)³. Fit these from measured
                resistance/temperature pairs across the range the sensor actually
                works in — a full-range fit is less accurate inside a cooler than a
                cold-range one. Scientific notation is accepted (e.g. 2.535e-3).
                The sensor re-checks that the coefficients produce a falling NTC
                curve and rejects them outright if they do not.
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
                <h3 style={{ fontSize: 14, margin: '18px 0 6px' }}>
                  Recent changes
                </h3>
                <div className="cfg-history">
                  {cfg.history.map((h) => (
                    <div className="cfg-history-row" key={h.changed_at}>
                      <div className="cfg-history-when">
                        {whenLabel(h.applied_at || h.changed_at)}
                        {h.applied_at ? '' : ' · not yet applied'}
                      </div>
                      <div className="cfg-history-vals">
                        {Math.round(h.sleep_secs / 60)}m · R{h.r_series} ·{' '}
                        A {coef(h.sh_a)} B {coef(h.sh_b)} C {coef(h.sh_c)}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
