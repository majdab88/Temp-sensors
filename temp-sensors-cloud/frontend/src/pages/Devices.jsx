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
                  <div className="device-name">{device.name || 'Unnamed Hub'}</div>
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
