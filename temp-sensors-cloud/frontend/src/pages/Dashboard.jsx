import React, { useEffect, useState, useCallback } from 'react'
import SensorCard from '../components/SensorCard'
import api from '../services/api'
import socket from '../services/socket'
import { useAuth } from '../context/AuthContext'

export default function Dashboard() {
  const { user } = useAuth()
  const canEdit = user?.permissionLevel !== 'viewer'
  const [sensors, setSensors] = useState([])
  const [readings, setReadings] = useState({}) // keyed by sensor MAC
  const [alerts, setAlerts] = useState({})     // active breaches, keyed by sensor MAC
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [hubsJoined, setHubsJoined] = useState([])

  const handleRename = useCallback((id, newName) => {
    setSensors((prev) => prev.map((s) => (s.id === id ? { ...s, name: newName } : s)))
  }, [])

  const handleDelete = useCallback((id) => {
    setSensors((prev) => prev.filter((s) => s.id !== id))
  }, [])

  // Fetch sensors + devices, then fetch latest readings per sensor
  const fetchData = useCallback(async () => {
    try {
      const [sensorsRes, devicesRes] = await Promise.all([
        api.get('/sensors'),
        api.get('/devices'),
      ])

      const sensorList = sensorsRes.data
      setSensors(sensorList)

      // Seed already-active breaches so they show on load, not just on the next
      // live transition. Best-effort — a failure here shouldn't block the grid.
      try {
        const activeRes = await api.get('/alerts/active')
        const seeded = {}
        activeRes.data.forEach((a) => { seeded[a.sensor_mac] = a })
        setAlerts(seeded)
      } catch { /* ignore */ }

      // Join socket rooms for each hub
      const hubMacs = devicesRes.data.map((d) => d.mac)
      hubMacs.forEach((mac) => socket.emit('join', mac))
      setHubsJoined(hubMacs)

      // Fetch latest reading for each sensor (fire all in parallel)
      const latestResults = await Promise.allSettled(
        sensorList.map((s) => api.get(`/sensors/${s.id}/readings/latest`)),
      )

      const initialReadings = {}
      latestResults.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          initialReadings[sensorList[idx].mac] = result.value.data
        }
      })
      setReadings(initialReadings)
    } catch {
      setError('Failed to load sensors')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!socket.connected) socket.connect()
    fetchData()

    // Live updates from socket
    function onSensorData(data) {
      setReadings((prev) => ({
        ...prev,
        [data.sensor_mac]: {
          temp: data.temp,
          hum: data.hum,
          battery: data.battery,
          rssi: data.rssi,
          recorded_at: new Date(data.ts).toISOString(),
        },
      }))
    }

    // Alert transitions — keep a map of active breaches; a 'recovered' event clears one.
    function onAlert(a) {
      setAlerts((prev) => {
        const next = { ...prev }
        if (a.kind === 'recovered') delete next[a.sensor_mac]
        else next[a.sensor_mac] = a
        return next
      })
    }

    // Re-join rooms on reconnect so cached hub status is replayed
    function onConnect() {
      hubsJoined.forEach((mac) => socket.emit('join', mac))
    }

    socket.on('sensorData', onSensorData)
    socket.on('alert', onAlert)
    socket.on('connect', onConnect)

    return () => {
      socket.off('sensorData', onSensorData)
      socket.off('alert', onAlert)
      socket.off('connect', onConnect)
      hubsJoined.forEach((mac) => socket.emit('leave', mac))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchData])

  if (loading) return <div className="state-loading">Loading sensors...</div>
  if (error)   return <div className="state-error"><h3>Error</h3><p>{error}</p></div>

  const activeAlerts = Object.values(alerts)

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">
          {sensors.length} sensor{sensors.length !== 1 ? 's' : ''} — live updates via Socket.IO
        </p>
      </div>

      {activeAlerts.length > 0 && (
        <div className="alert-banner">
          {activeAlerts.map((a) => (
            <div key={a.sensor_mac} className="alert-banner-item">
              <span className="alert-banner-icon">⚠️</span>
              <span>{a.message}</span>
            </div>
          ))}
        </div>
      )}

      {sensors.length === 0 ? (
        <div className="state-empty">
          <h3>No sensors yet</h3>
          <p>Pair a sensor to your hub to see it here</p>
        </div>
      ) : (
        <div className="sensor-grid">
          {sensors.map((sensor) => (
            <SensorCard
              key={sensor.id}
              sensor={sensor}
              reading={readings[sensor.mac] || null}
              alert={alerts[sensor.mac] || null}
              onRename={handleRename}
              onDelete={handleDelete}
              canEdit={canEdit}
            />
          ))}
        </div>
      )}
    </div>
  )
}
