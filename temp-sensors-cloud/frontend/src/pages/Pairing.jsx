import React, { useEffect, useState, useCallback } from 'react'
import PairingPanel from '../components/PairingPanel'
import api from '../services/api'
import socket from '../services/socket'

const TABS = ['pending', 'approved', 'rejected']

export default function Pairing() {
  const [tab, setTab] = useState('pending')
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [processing, setProcessing] = useState(null) // id of request being acted on

  const fetchRequests = useCallback((status) => {
    setLoading(true)
    setError(null)
    api.get('/pairing/requests', { params: { status } })
      .then((res) => setRequests(res.data))
      .catch(() => setError('Failed to load pairing requests'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchRequests(tab)
  }, [tab, fetchRequests])

  // Real-time: new pairing request via socket → refresh if we're on "pending" tab
  useEffect(() => {
    function onPairingRequest() {
      if (tab === 'pending') fetchRequests('pending')
    }
    socket.on('pairingRequest', onPairingRequest)
    return () => { socket.off('pairingRequest', onPairingRequest) }
  }, [tab, fetchRequests])

  async function handleApprove(id) {
    setProcessing(id)
    try {
      await api.post(`/pairing/requests/${id}/approve`)
      setRequests((prev) => prev.filter((r) => r.id !== id))
    } catch {
      alert('Failed to approve. Please try again.')
    } finally {
      setProcessing(null)
    }
  }

  async function handleReject(id) {
    setProcessing(id)
    try {
      await api.post(`/pairing/requests/${id}/reject`)
      setRequests((prev) => prev.filter((r) => r.id !== id))
    } catch {
      alert('Failed to reject. Please try again.')
    } finally {
      setProcessing(null)
    }
  }

  const pendingCount = tab === 'pending' ? requests.length : null

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Pairing Requests</h1>
        <p className="page-subtitle">Approve or reject new sensor pairing requests</p>
      </div>

      <div className="pairing-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={`btn btn-ghost${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
            style={{ textTransform: 'capitalize' }}
          >
            {t}
            {t === 'pending' && pendingCount > 0 && (
              <span className="nav-badge" style={{ marginLeft: 6 }}>{pendingCount}</span>
            )}
          </button>
        ))}
      </div>

      {loading && <div className="state-loading">Loading...</div>}
      {error   && <div className="state-error"><h3>{error}</h3></div>}
      {!loading && !error && (
        <PairingPanel
          requests={requests}
          onApprove={handleApprove}
          onReject={handleReject}
          processing={processing}
        />
      )}
    </div>
  )
}
