import React, { useEffect, useState } from 'react'
import api from '../services/api'
import socket from '../services/socket'

function formatDate(isoStr) {
  if (!isoStr) return ''
  return new Date(isoStr).toLocaleString()
}

export default function Devices() {
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Track online/offline status per hub MAC via hubStatus socket events
  const [hubStatus, setHubStatus] = useState({}) // MAC -> { online, ip, ts }

  // Device rename
  const [editingId, setEditingId] = useState(null)
  const [editingName, setEditingName] = useState('')

  useEffect(() => {
    api.get('/devices')
      .then((res) => {
        setDevices(res.data)
        // Join a socket room for each hub to receive hubStatus events
        res.data.forEach((d) => socket.emit('join', d.mac))
      })
      .catch(() => setError('Failed to load devices'))
      .finally(() => setLoading(false))

    function onHubStatus(data) {
      setHubStatus((prev) => ({
        ...prev,
        [data.hub_mac]: { online: data.online, ip: data.ip, ts: data.ts },
      }))
    }

    socket.on('hubStatus', onHubStatus)
    return () => {
      socket.off('hubStatus', onHubStatus)
    }
  }, [])

  async function handleRename(deviceId) {
    const trimmed = editingName.trim()
    if (!trimmed) return
    try {
      const res = await api.put(`/devices/${deviceId}`, { name: trimmed })
      setDevices((prev) => prev.map(d => d.id === deviceId ? { ...d, name: res.data.name } : d))
      setEditingId(null)
    } catch {
      alert('Failed to rename device')
    }
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
            return (
              <div key={device.id} className="device-card">
                <div className="device-card-info">
                  {editingId === device.id ? (
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
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => { setEditingId(device.id); setEditingName(device.name || '') }}
                        style={{ fontSize: 12, padding: '1px 6px', marginLeft: 6, opacity: 0.6 }}
                        title="Rename device"
                      >
                        &#9998;
                      </button>
                    </div>
                  )}
                  <div className="device-mac">{device.mac}</div>
                  <div className="device-meta">Registered: {formatDate(device.registered_at)}</div>
                  {status?.ip && (
                    <div className="device-meta">IP: {status.ip}</div>
                  )}
                </div>
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
            )
          })}
        </div>
      )}
    </div>
  )
}
