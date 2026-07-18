import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import api from '../services/api'

/**
 * Per-sensor temperature alert editor.
 * Fetches the current rule (if any), lets the user set max/min limits,
 * a recovery margin, and an enabled toggle, then PUTs the rule.
 *
 * onClose(changed) — changed=true if a rule was saved or removed.
 */
export default function AlertRuleModal({ sensor, onClose }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState(null)
  const [exists, setExists]   = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [high, setHigh]       = useState('')
  const [low, setLow]         = useState('')
  const [hyst, setHyst]       = useState('1')
  const [channels, setChannels] = useState(['dashboard'])

  useEffect(() => {
    let active = true
    api.get(`/alerts/rules/${sensor.id}`)
      .then(({ data }) => {
        if (!active || !data) return
        setExists(true)
        setEnabled(data.enabled)
        setHigh(data.high_limit != null ? String(data.high_limit) : '')
        setLow(data.low_limit != null ? String(data.low_limit) : '')
        setHyst(data.hysteresis != null ? String(data.hysteresis) : '1')
        setChannels(data.channels?.length ? data.channels : ['dashboard'])
      })
      .catch(() => { if (active) setError('Failed to load alert settings') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [sensor.id])

  function parseNum(s) {
    if (s === '' || s == null) return null
    const n = Number(s)
    return Number.isFinite(n) ? n : NaN
  }

  async function handleSave() {
    setError(null)
    const highVal = parseNum(high)
    const lowVal  = parseNum(low)
    const hystVal = hyst === '' ? 1 : parseNum(hyst)

    if ([highVal, lowVal, hystVal].some(Number.isNaN)) return setError('Enter valid numbers')
    if (highVal == null && lowVal == null) return setError('Set a max and/or a min temperature')
    if (highVal != null && lowVal != null && lowVal >= highVal) return setError('Min must be below max')
    if (hystVal < 0) return setError('Recovery margin can’t be negative')

    setSaving(true)
    try {
      await api.put(`/alerts/rules/${sensor.id}`, {
        high_limit: highVal,
        low_limit: lowVal,
        hysteresis: hystVal,
        channels,
        enabled,
      })
      onClose(true)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save')
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!window.confirm('Remove the alert rule for this sensor?')) return
    setSaving(true)
    try {
      await api.delete(`/alerts/rules/${sensor.id}`)
      onClose(true)
    } catch {
      setError('Failed to remove')
      setSaving(false)
    }
  }

  // Rendered into document.body via a portal so the fixed overlay covers the
  // viewport — otherwise the hovered card's `transform` becomes its containing
  // block and traps the modal inside the card.
  return createPortal(
    <div className="modal-overlay" onClick={(e) => { e.stopPropagation(); onClose(false) }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Temperature alerts</h3>
          <div className="modal-sub">{sensor.name || sensor.mac}</div>
        </div>

        {loading ? (
          <div className="state-loading" style={{ padding: '24px 0' }}>Loading…</div>
        ) : (
          <>
            {error && <div className="alert alert-error">{error}</div>}

            <label className="modal-toggle">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span>Alerts enabled</span>
            </label>

            <div className="form-row">
              <div className="form-group">
                <label>Max temp (°C)</label>
                <input type="number" step="0.1" inputMode="decimal" placeholder="e.g. 8"
                  value={high} onChange={(e) => setHigh(e.target.value)} />
                <div className="form-hint">Alert when above this</div>
              </div>
              <div className="form-group">
                <label>Min temp (°C)</label>
                <input type="number" step="0.1" inputMode="decimal" placeholder="e.g. 2"
                  value={low} onChange={(e) => setLow(e.target.value)} />
                <div className="form-hint">Alert when below this</div>
              </div>
            </div>

            <div className="form-group">
              <label>Recovery margin (°C)</label>
              <input type="number" step="0.1" inputMode="decimal"
                value={hyst} onChange={(e) => setHyst(e.target.value)} />
              <div className="form-hint">Temp must return this far inside the limit before the alert clears — prevents flapping.</div>
            </div>

            <div className="modal-actions">
              {exists && (
                <button className="btn btn-danger btn-sm" onClick={handleDelete} disabled={saving}>Remove</button>
              )}
              <div style={{ flex: 1 }} />
              <button className="btn btn-ghost" onClick={() => onClose(false)} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
