import React, { useEffect, useState, useCallback } from 'react'
import SensorCard from '../components/SensorCard'
import api from '../services/api'
import socket from '../services/socket'

export default function Dashboard() {
  const [sensors, setSensors] = useState([])
  const [readings, setReadings] = useState({}) // keyed by sensor MAC
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

    socket.on('sensorData', onSensorData)

    return () => {
      socket.off('sensorData', onSensorData)
      hubsJoined.forEach((mac) => socket.emit('leave', mac))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchData])

  if (loading) return <div className="state-loading">Loading sensors...</div>
  if (error)   return <div className="state-error"><h3>Error</h3><p>{error}</p></div>

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">
          {sensors.length} sensor{sensors.length !== 1 ? 's' : ''} — live updates via Socket.IO
        </p>
      </div>

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
              onRename={handleRename}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}
