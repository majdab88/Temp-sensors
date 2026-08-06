import React, { useEffect, useState, useCallback } from 'react'
import api from '../services/api'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'

/**
 * Alert rules — one place to see and edit every sensor's temperature rule.
 * Maps directly onto the per-sensor rules API:
 *   FIRING = sensor currently breached (/alerts/active)
 *   ARMED  = rule exists and enabled
 *   PAUSED = rule exists, disabled
 */
export default function AlertRules() {
  const { user } = useAuth()
  const toast = useToast()
  const canEdit = user?.permissionLevel !== 'viewer'
  const [sensors, setSensors] = useState([])
  const [rules, setRules] = useState({})     // sensorId -> rule
  const [firing, setFiring] = useState({})   // sensor_mac -> active alert
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Side form state
  const [formSensorId, setFormSensorId] = useState('')
  const [editingExisting, setEditingExisting] = useState(false)
  const [high, setHigh] = useState('')
  const [low, setLow] = useState('')
  const [hyst, setHyst] = useState('1')
  const [channels, setChannels] = useState(['dashboard', 'push'])
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState(null)
  const [formOk, setFormOk] = useState(null)

  // Device health alert settings (org-wide)
  const [health, setHealth] = useState(null)
  const [healthSaving, setHealthSaving] = useState(false)
  const [healthMsg, setHealthMsg] = useState(null)

  const fetchAll = useCallback(async () => {
    try {
      api.get('/health/settings').then((r) => setHealth(r.data)).catch(() => {})

      const sensorsRes = await api.get('/sensors')
      const list = sensorsRes.data
      setSensors(list)

      const ruleResults = await Promise.allSettled(
        list.map((s) => api.get(`/alerts/rules/${s.id}`)),
      )
      const map = {}
      ruleResults.forEach((r, idx) => {
        if (r.status === 'fulfilled' && r.value.data) map[list[idx].id] = r.value.data
      })
      setRules(map)

      try {
        const activeRes = await api.get('/alerts/active')
        const f = {}
        activeRes.data.forEach((a) => { f[a.sensor_mac] = a })
        setFiring(f)
      } catch { /* ignore */ }
    } catch {
      setError('Failed to load alert rules')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  function resetForm() {
    setFormSensorId('')
    setEditingExisting(false)
    setHigh(''); setLow(''); setHyst('1')
    setChannels(['dashboard', 'push'])
    setFormError(null); setFormOk(null)
  }

  function editRule(sensor) {
    const rule = rules[sensor.id]
    setFormSensorId(String(sensor.id))
    setEditingExisting(!!rule)
    setHigh(rule?.high_limit != null ? String(rule.high_limit) : '')
    setLow(rule?.low_limit != null ? String(rule.low_limit) : '')
    setHyst(rule?.hysteresis != null ? String(rule.hysteresis) : '1')
    setChannels(rule?.channels?.length ? rule.channels : ['dashboard', 'push'])
    setFormError(null); setFormOk(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function toggleChannel(ch) {
    setChannels((prev) => (prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]))
  }

  function parseNum(s) {
    if (s === '' || s == null) return null
    const n = Number(s)
    return Number.isFinite(n) ? n : NaN
  }

  async function saveRule() {
    setFormError(null); setFormOk(null)
    if (!formSensorId) return setFormError('Choose a sensor')
    const highVal = parseNum(high)
    const lowVal = parseNum(low)
    const hystVal = hyst === '' ? 1 : parseNum(hyst)
    if ([highVal, lowVal, hystVal].some(Number.isNaN)) return setFormError('Enter valid numbers')
    if (highVal == null && lowVal == null) return setFormError('Set a max and/or min temperature')
    if (highVal != null && lowVal != null && lowVal >= highVal) return setFormError('Min must be below max')
    if (channels.length === 0) return setFormError('Choose at least one channel')

    setSaving(true)
    try {
      await api.put(`/alerts/rules/${formSensorId}`, {
        high_limit: highVal,
        low_limit: lowVal,
        hysteresis: hystVal,
        channels,
        enabled: true,
      })
      setFormOk('Rule saved')
      resetForm()
      fetchAll()
    } catch (err) {
      setFormError(err.response?.data?.error || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function togglePause(sensor) {
    const rule = rules[sensor.id]
    if (!rule) return
    try {
      await api.put(`/alerts/rules/${sensor.id}`, {
        high_limit: rule.high_limit,
        low_limit: rule.low_limit,
        hysteresis: rule.hysteresis,
        channels: rule.channels,
        cooldown_s: rule.cooldown_s,
        enabled: !rule.enabled,
      })
      fetchAll()
    } catch {
      toast.error('Failed to update rule')
    }
  }

  async function removeRule(sensor) {
    const ok = await toast.confirm({
      title: 'Remove alert rule?',
      message: `"${sensor.name || sensor.mac}" will no longer trigger temperature alerts.`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    try {
      await api.delete(`/alerts/rules/${sensor.id}`)
      if (String(sensor.id) === formSensorId) resetForm()
      fetchAll()
      toast.success('Alert rule removed')
    } catch {
      toast.error('Failed to remove rule')
    }
  }

  function setH(patch) { setHealth((h) => ({ ...h, ...patch })); setHealthMsg(null) }

  async function saveHealth() {
    if (!health) return
    setHealthSaving(true)
    setHealthMsg(null)
    try {
      const { data } = await api.put('/health/settings', {
        sensor_offline_enabled: !!health.sensor_offline_enabled,
        sensor_offline_minutes: parseInt(health.sensor_offline_minutes, 10),
        hub_offline_enabled: !!health.hub_offline_enabled,
        hub_offline_minutes: parseInt(health.hub_offline_minutes, 10),
        low_battery_enabled: !!health.low_battery_enabled,
      })
      setHealth(data)
      setHealthMsg({ ok: true, text: 'Saved' })
    } catch (err) {
      setHealthMsg({ ok: false, text: err.response?.data?.error || 'Failed to save' })
    } finally {
      setHealthSaving(false)
    }
  }

  if (loading) return <div className="state-loading">Loading alert rules...</div>
  if (error) return <div className="state-error"><h3>Error</h3><p>{error}</p></div>

  const withRules = sensors.filter((s) => rules[s.id])
  const firingCount = withRules.filter((s) => firing[s.mac]).length

  function conditionText(rule) {
    const parts = []
    if (rule.high_limit != null) parts.push(`above ${rule.high_limit} °C`)
    if (rule.low_limit != null) parts.push(`below ${rule.low_limit} °C`)
    return parts.join(' or ')
  }

  function statusFor(sensor) {
    const rule = rules[sensor.id]
    if (!rule) return null
    if (firing[sensor.mac] && rule.enabled) return { label: 'FIRING', cls: 'firing' }
    if (rule.enabled) return { label: 'ARMED', cls: '' }
    return { label: 'PAUSED', cls: 'offline' }
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Alert rules</h1>
        <p className="page-subtitle">
          {withRules.length} rule{withRules.length !== 1 ? 's' : ''} · {firingCount} firing
        </p>
      </div>

      {/* ── Device health alerts (org-wide) ── */}
      {health && (
        <section className="health-panel">
          <div className="health-panel-head">
            <span className="rail-title" style={{ marginBottom: 0 }}>Device health alerts</span>
            {canEdit && (
              <div className="health-panel-actions">
                {healthMsg && (
                  <span className="health-msg" style={{ color: healthMsg.ok ? 'var(--green)' : 'var(--accent)' }}>
                    {healthMsg.text}
                  </span>
                )}
                <button className="btn btn-primary btn-sm" onClick={saveHealth} disabled={healthSaving}>
                  {healthSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            )}
          </div>

          <div className="health-rows">
            <div className="health-row">
              <label className="modal-toggle" style={{ marginBottom: 0 }}>
                <input type="checkbox" disabled={!canEdit}
                  checked={!!health.sensor_offline_enabled}
                  onChange={(e) => setH({ sensor_offline_enabled: e.target.checked })} />
                <span>Sensor offline</span>
              </label>
              <span className="health-inline">no reading for</span>
              <input type="number" className="health-num" min={5} max={1440} disabled={!canEdit || !health.sensor_offline_enabled}
                value={health.sensor_offline_minutes}
                onChange={(e) => setH({ sensor_offline_minutes: e.target.value })} />
              <span className="health-inline">min</span>
            </div>

            <div className="health-row">
              <label className="modal-toggle" style={{ marginBottom: 0 }}>
                <input type="checkbox" disabled={!canEdit}
                  checked={!!health.hub_offline_enabled}
                  onChange={(e) => setH({ hub_offline_enabled: e.target.checked })} />
                <span>Hub offline</span>
              </label>
              <span className="health-inline">grace</span>
              <input type="number" className="health-num" min={1} max={1440} disabled={!canEdit || !health.hub_offline_enabled}
                value={health.hub_offline_minutes}
                onChange={(e) => setH({ hub_offline_minutes: e.target.value })} />
              <span className="health-inline">min</span>
            </div>

            <div className="health-row">
              <label className="modal-toggle" style={{ marginBottom: 0 }}>
                <input type="checkbox" disabled={!canEdit}
                  checked={!!health.low_battery_enabled}
                  onChange={(e) => setH({ low_battery_enabled: e.target.checked })} />
                <span>Low battery</span>
              </label>
              <span className="health-inline">notify when a pack runs low</span>
            </div>
          </div>
        </section>
      )}

      <div className="rules-layout">
        {/* ── Rules table ── */}
        <div style={{ overflowX: 'auto' }}>
          {sensors.length === 0 ? (
            <div className="state-empty">
              <h3>No sensors</h3>
              <p>Pair a sensor first, then set its temperature limits here</p>
            </div>
          ) : (
            <table className="rules-table">
              <thead>
                <tr>
                  <th>Sensor</th>
                  <th>Condition</th>
                  <th>Notify</th>
                  <th>Status</th>
                  {canEdit && <th></th>}
                </tr>
              </thead>
              <tbody>
                {sensors.map((sensor) => {
                  const rule = rules[sensor.id]
                  const status = statusFor(sensor)
                  return (
                    <tr key={sensor.id} className={status?.cls === 'firing' ? 'firing' : ''}>
                      <td>
                        <div className="rule-name">{sensor.name || sensor.mac}</div>
                        <div className="rule-sub">{sensor.hub_name || sensor.hub_mac}</div>
                      </td>
                      <td className="rule-cond">{rule ? conditionText(rule) : <span style={{ color: 'var(--text-3)' }}>No rule</span>}</td>
                      <td>{rule ? rule.channels.map((c) => c === 'push' ? 'Push' : c === 'whatsapp' ? 'WhatsApp' : 'Dashboard').join(' + ') : '—'}</td>
                      <td>
                        {status ? (
                          <span className={`chip ${status.cls}`}>{status.label}</span>
                        ) : '—'}
                      </td>
                      {canEdit && (
                        <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                          {rule ? (
                            <>
                              <button className="link-btn" onClick={() => togglePause(sensor)}>
                                {rule.enabled ? 'Pause' : 'Arm'}
                              </button>
                              <button className="link-btn" onClick={() => editRule(sensor)}>Edit</button>
                              <button className="link-btn" onClick={() => removeRule(sensor)}>Remove</button>
                            </>
                          ) : (
                            <button className="link-btn" onClick={() => editRule(sensor)}>Add rule</button>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── New / edit rule form ── */}
        {canEdit && (
          <aside className="rules-form">
            <div className="rules-form-title">{editingExisting ? 'Edit rule' : 'New rule'}</div>

            {formError && <div className="alert alert-error">{formError}</div>}
            {formOk && <div className="alert" style={{ background: '#eaf7ee', border: '1px solid #bfe3cb', color: '#166534' }}>{formOk}</div>}

            <div className="form-group">
              <label>Sensor</label>
              <select
                value={formSensorId}
                onChange={(e) => { setFormSensorId(e.target.value); setEditingExisting(!!rules[e.target.value]) }}
              >
                <option value="">Choose a sensor…</option>
                {sensors.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.mac}{rules[s.id] ? ' (has rule)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Max temp (°C)</label>
                <input type="number" step="0.1" inputMode="decimal" placeholder="e.g. 8"
                  value={high} onChange={(e) => setHigh(e.target.value)} />
              </div>
              <div className="form-group">
                <label>Min temp (°C)</label>
                <input type="number" step="0.1" inputMode="decimal" placeholder="e.g. 2"
                  value={low} onChange={(e) => setLow(e.target.value)} />
              </div>
            </div>

            <div className="form-group">
              <label>Recovery margin (°C)</label>
              <input type="number" step="0.1" inputMode="decimal"
                value={hyst} onChange={(e) => setHyst(e.target.value)} />
              <div className="form-hint">Temp must return this far inside the limit before the alert clears.</div>
            </div>

            <div className="form-group">
              <label>Notify via</label>
              <label className="modal-toggle">
                <input type="checkbox" checked={channels.includes('dashboard')} onChange={() => toggleChannel('dashboard')} />
                <span>Dashboard</span>
              </label>
              <label className="modal-toggle" style={{ marginBottom: 0 }}>
                <input type="checkbox" checked={channels.includes('push')} onChange={() => toggleChannel('push')} />
                <span>Push notification</span>
              </label>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" onClick={saveRule} disabled={saving}>
                {saving ? 'Saving…' : 'Save rule'}
              </button>
              <button className="btn btn-ghost" onClick={resetForm} disabled={saving}>Cancel</button>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
