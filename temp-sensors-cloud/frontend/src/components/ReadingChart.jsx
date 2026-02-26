import React, { useEffect, useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import api from '../services/api'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler)

function formatLabel(isoStr) {
  const d = new Date(isoStr)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function ReadingChart({ sensorId, from, to }) {
  const [readings, setReadings] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!sensorId) return
    setLoading(true)
    setError(null)

    const params = { limit: 500 }
    if (from) params.from = from
    if (to) params.to = to

    api.get(`/sensors/${sensorId}/readings`, { params })
      .then((res) => {
        // API returns DESC; reverse so chart flows left-to-right (oldest first)
        setReadings([...res.data].reverse())
      })
      .catch(() => setError('Failed to load readings'))
      .finally(() => setLoading(false))
  }, [sensorId, from, to])

  if (loading) return <div className="state-loading">Loading chart data...</div>
  if (error)   return <div className="state-error"><h3>{error}</h3></div>
  if (readings.length === 0) return <div className="state-empty"><h3>No readings</h3><p>No data for the selected time range</p></div>

  // Thin points when there are many readings to keep the chart readable
  const pointRadius = readings.length > 80 ? 0 : 3

  const labels = readings.map((r) => formatLabel(r.recorded_at))

  const data = {
    labels,
    datasets: [
      {
        label: 'Temperature (°C)',
        data: readings.map((r) => r.temp),
        borderColor: '#ef4444',
        backgroundColor: 'rgba(239, 68, 68, 0.08)',
        yAxisID: 'yTemp',
        tension: 0.3,
        pointRadius,
        borderWidth: 2,
        fill: true,
        spanGaps: true,
      },
      {
        label: 'Humidity (%)',
        data: readings.map((r) => r.hum),
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.08)',
        yAxisID: 'yHum',
        tension: 0.3,
        pointRadius,
        borderWidth: 2,
        fill: true,
        spanGaps: true,
      },
    ],
  }

  const options = {
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top' },
      title: { display: false },
    },
    scales: {
      x: {
        ticks: {
          maxTicksLimit: 10,
          maxRotation: 30,
          font: { size: 11 },
          color: '#94a3b8',
        },
        grid: { color: '#f1f5f9' },
      },
      yTemp: {
        type: 'linear',
        display: true,
        position: 'left',
        title: { display: true, text: '°C', color: '#ef4444', font: { size: 12 } },
        ticks: { color: '#ef4444', font: { size: 11 } },
        grid: { color: '#f1f5f9' },
      },
      yHum: {
        type: 'linear',
        display: true,
        position: 'right',
        title: { display: true, text: '%', color: '#3b82f6', font: { size: 12 } },
        ticks: { color: '#3b82f6', font: { size: 11 } },
        grid: { drawOnChartArea: false },
        min: 0,
        max: 100,
      },
    },
  }

  return <Line data={data} options={options} />
}
