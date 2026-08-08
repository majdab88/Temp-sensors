import React, { useEffect, useState, useRef, useCallback } from 'react'
import api from '../services/api'
import socket from '../services/socket'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'

function formatDate(isoStr) {
  if (!isoStr) return ''
  return new Date(isoStr).toLocaleString()
}

const PAIRING_DURATION = 120 // seconds

export default function Devices() {
  const { user } = useAuth()
  const toast = useToast()
  const canEdit = user?.permissionLevel !== 'viewer'
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [hubStatus, setHubStatus] = useState({})

  // Device rename
  const [editingId, setEditingId] = useState(null)
  const [editingName, setEditingName] = useState('')

  // Pairing mode
  const [pairingHub, setPairingHub] = useState(null) // MAC of hub in pairing mode
  const [pairingCountdown, setPairingCountdown] = useState(0)
  const [pairingRequests, setPairingRequests] = useState([])
  const [pairingEnabling, setPairingEnabling] = useState(false)
  const [processingRequest, setProcessingRequest] = useState(null)
  const countdownRef = useRef(null)
  const deviceMacsRef = useRef([])

  useEffect(() => {
    if (!socket.connected) socket.connect()

    api.get('/devices')
      .then((res) => {
        setDevices(res.data)
        const macs = res.data.map((d) => d.mac)
        deviceMacsRef.current = macs
        macs.forEach((mac) => socket.emit('join', mac))
      })
      .catch(() => setError('Failed to load devices'))
      .finally(() => setLoading(false))

    function onHubStatus(data) {
      setHubStatus((prev) => ({
        ...prev,
        [data.hub_mac]: { online: data.online, ip: data.ip, ts: data.ts },
      }))
    }

    // Re-join rooms on reconnect so hub status is replayed from cache
    function onConnect() {
      deviceMacsRef.current.forEach((mac) => socket.emit('join', mac))
    }

    socket.on('hubStatus', onHubStatus)
    socket.on('connect', onConnect)
    return () => {
      socket.off('hubStatus', onHubStatus)
      socket.off('connect', onConnect)
    }
  }, [])

  // Listen for pairing mode status from hub (authoritative)
  useEffect(() => {
    function onPairingModeStatus(data) {
      if (!data.pairing_mode && data.hub_mac === pairingHub) {
        stopPairingMode()
      }
    }
    socket.on('pairingModeStatus', onPairingModeStatus)
    return () => { socket.off('pairingModeStatus', onPairingModeStatus) }
  }, [pairingHub])

  // Listen for incoming pairing requests
  useEffect(() => {
    function onPairingRequest(data) {
      if (data.hub_mac === pairingHub) {
        setPairingRequests((prev) => {
          if (prev.some((r) => r.id === data.id)) return prev
          return [...prev, data]
        })
      }
    }
    socket.on('pairingRequest', onPairingRequest)
    return () => { socket.off('pairingRequest', onPairingRequest) }
  }, [pairingHub])

  // Countdown timer
  useEffect(() => {
    if (pairingHub && pairingCountdown > 0) {
      countdownRef.current = setInterval(() => {
        setPairingCountdown((prev) => {
          if (prev <= 1) {
            stopPairingMode()
            return 0
          }
          return prev - 1
        })
      }, 1000)
      return () => clearInterval(countdownRef.current)
    }
  }, [pairingHub, pairingCountdown > 0])

  const stopPairingMode = useCallback(() => {
    setPairingHub(null)
    setPairingCountdown(0)
    setPairingRequests([])
    if (countdownRef.current) clearInterval(countdownRef.current)
  }, [])

  async function handleEnablePairing(mac) {
    setPairingEnabling(true)
    try {
      await api.post('/pairing/enable', { hub_mac: mac, enable: true })
      setPairingHub(mac)
      setPairingCountdown(PAIRING_DURATION)
      setPairingRequests([])
    } catch {
      toast.error('Failed to enable pairing mode. Is the hub online?')
    } finally {
      setPairingEnabling(false)
    }
  }

  async function handleDisablePairing() {
    if (!pairingHub) return
    try {
      await api.post('/pairing/enable', { hub_mac: pairingHub, enable: false })
    } catch { /* best-effort */ }
    stopPairingMode()
  }

  async function handleApprove(id) {
    setProcessingRequest(id)
    try {
      await api.post(`/pairing/requests/${id}/approve`)
      setPairingRequests((prev) => prev.filter((r) => r.id !== id))
      handleDisablePairing()
      toast.success('Sensor paired')
    } catch {
      toast.error('Failed to approve pairing request')
    } finally {
      setProcessingRequest(null)
    }
  }

  async function handleReject(id) {
    setProcessingRequest(id)
    try {
      await api.post(`/pairing/requests/${id}/reject`)
      setPairingRequests((prev) => prev.filter((r) => r.id !== id))
    } catch {
      toast.error('Failed to reject pairing request')
    } finally {
      setProcessingRequest(null)
    }
  }

  async function handleRename(deviceId) {
    const trimmed = editingName.trim()
    if (!trimmed) return
    try {
      const res = await api.put(`/devices/${deviceId}`, { name: trimmed })
      setDevices((prev) => prev.map(d => d.id === deviceId ? { ...d, name: res.data.name } : d))
      setEditingId(null)
    } catch {
      toast.error('Failed to rename device')
    }
  }

  async function handleDelete(device) {
    if (!window.confirm(
      `Remove "${device.name || 'this hub'}"? This deletes the hub and all its sensors and readings. This cannot be undone.`
    )) return
    try {
      await api.delete(`/devices/${device.id}`)
      setDevices((prev) => prev.filter(d => d.id !== device.id))
      if (pairingHub === device.mac) stopPairingMode()
      toast.success('Hub removed')
    } catch {
      toast.error('Failed to remove hub')
    }
  }

  function formatCountdown(sec) {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  if (loading) return <div className="state-loading">Loading devices...</div>
  if (error)   return <div className="state-error"><h3>Error</h3><p>{error}</p></div>

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Devices</h1>
        <p className="page-subtitle">Registered hub devices</p>
      </div>

      {devices.length === 0 ? (
        <div className="state-empty">
          <h3>No devices registered</h3>
          <p>Use the mobile app to register a hub via BLE provisioning</p>
        </div>
      ) : (
        <div className="devices-list">
          {devices.map((device) => {
            const status = hubStatus[device.mac]
            const isOnline = status?.online === true
            const isOffline = status?.online === false
            const isPairingThis = pairingHub === device.mac
            return (
              <div key={device.id}>
                <div className="device-card">
                  <div className="device-card-info">
                    {editingId === device.id && canEdit ? (
                      <form
                        onSubmit={(e) => { e.preventDefault(); handleRename(device.id) }}
                        style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}
                      >
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          autoFocus
                          style={{ fontSize: 14, padding: '3px 8px', width: 200 }}
                          onKeyDown={(e) => { if (e.key === 'Escape') setEditingId(null) }}
                        />
                        <button type="submit" className="btn btn-primary btn-sm" style={{ fontSize: 12, padding: '3px 10px' }}>Save</button>
                        <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => setEditingId(null)}>Cancel</button>
                      </form>
                    ) : (
                      <div className="device-name">
                        {device.name || 'Unnamed Hub'}
                        {canEdit && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => { setEditingId(device.id); setEditingName(device.name || '') }}
                            style={{ fontSize: 12, padding: '1px 6px', marginLeft: 6, opacity: 0.6 }}
                            title="Rename device"
                          >
                            &#9998;
                          </button>
                        )}
                      </div>
                    )}
                    <div className="device-mac">{device.mac}</div>
                    <div className="device-meta">Registered: {formatDate(device.registered_at)}</div>
                    {status?.ip && (
                      <div className="device-meta">IP: {status.ip}</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {canEdit && !isPairingThis && (
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={!isOnline || pairingEnabling || (pairingHub && !isPairingThis)}
                        onClick={() => handleEnablePairing(device.mac)}
                        title={!isOnline ? 'Hub must be online to add sensors' : ''}
                        style={{ fontSize: 12, padding: '4px 12px', whiteSpace: 'nowrap' }}
                      >
                        {pairingEnabling ? '...' : '+ Add Sensor'}
                      </button>
                    )}
                    {canEdit && !isPairingThis && (
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => handleDelete(device)}
                        style={{ fontSize: 12, padding: '4px 12px', whiteSpace: 'nowrap' }}
                        title="Remove this hub and all its sensors"
                      >
                        Remove
                      </button>
                    )}
                    <div className={`device-status ${isOnline ? 'online' : isOffline ? 'offline' : ''}`}>
                      {isOnline && (
                        <>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
                          Online
                        </>
                      )}
                      {isOffline && (
                        <>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--text-3)', display: 'inline-block' }} />
                          Offline
                        </>
                      )}
                      {!isOnline && !isOffline && (
                        <>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#cbd5e1', display: 'inline-block' }} />
                          Unknown
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Pairing mode panel */}
                {isPairingThis && (
                  <div className="card" style={{ margin: '0 0 12px 0', padding: 16, borderTop: 'none', borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{
                          display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
                          background: '#3b82f6', animation: 'pulse 1.5s infinite',
                        }} />
                        <span style={{ fontWeight: 600, fontSize: 14 }}>
                          Pairing mode active
                        </span>
                        <span style={{ fontSize: 13, color: 'var(--text-2)', fontVariantNumeric: 'tabular-nums' }}>
                          {formatCountdown(pairingCountdown)} remaining
                        </span>
                      </div>
                      <button className="btn btn-ghost btn-sm" onClick={handleDisablePairing} style={{ fontSize: 12 }}>
                        Cancel
                      </button>
                    </div>

                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>
                      Power on or factory-reset the sensor now. It will broadcast a pairing request.
                    </div>

                    {pairingRequests.length === 0 ? (
                      <div style={{ fontSize: 13, color: 'var(--text-3)', fontStyle: 'italic' }}>
                        Waiting for sensor pairing requests...
                      </div>
                    ) : (
                      <div>
                        {pairingRequests.map((req) => {
                          const sensorName = 'TempSens-' + (req.sensor_mac || '').replace(/:/g, '').slice(-6)
                          return (
                            <div key={req.id} style={{
                              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              padding: '8px 12px', marginBottom: 6,
                              background: 'var(--bg-2, #f8fafc)', borderRadius: 8, border: '1px solid var(--border, #e2e8f0)',
                            }}>
                              <div>
                                <span style={{ fontWeight: 500, fontSize: 13 }}>{sensorName}</span>
                                <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-3)' }}>{req.sensor_mac}</span>
                              </div>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button
                                  className="btn btn-primary btn-sm"
                                  style={{ fontSize: 11, padding: '3px 10px' }}
                                  disabled={processingRequest === req.id}
                                  onClick={() => handleApprove(req.id)}
                                >
                                  {processingRequest === req.id ? '...' : 'Approve'}
                                </button>
                                <button
                                  className="btn btn-danger btn-sm"
                                  style={{ fontSize: 11, padding: '3px 10px' }}
                                  disabled={processingRequest === req.id}
                                  onClick={() => handleReject(req.id)}
                                >
                                  Reject
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  )
}
