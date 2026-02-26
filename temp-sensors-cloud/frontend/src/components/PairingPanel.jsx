import React from 'react'

function formatTime(isoStr) {
  if (!isoStr) return ''
  return new Date(isoStr).toLocaleString()
}

export default function PairingPanel({ requests, onApprove, onReject, processing }) {
  if (requests.length === 0) {
    return (
      <div className="state-empty">
        <h3>No requests</h3>
        <p>No pairing requests in this category</p>
      </div>
    )
  }

  return (
    <div className="pairing-list">
      {requests.map((req) => (
        <div key={req.id} className="pairing-card">
          <div className="pairing-card-info">
            <div className="pairing-mac">TempSens-{req.slave_mac.replace(/:/g, '').slice(-6)}</div>
            <div className="pairing-mac-full">{req.slave_mac}</div>
            <div className="pairing-hub">Hub: {req.hub_name || req.hub_mac}</div>
            <div className="pairing-time">{formatTime(req.requested_at)}</div>
          </div>

          {req.status === 'pending' ? (
            <div className="pairing-actions">
              <button
                className="btn btn-success btn-sm"
                onClick={() => onApprove(req.id)}
                disabled={processing === req.id}
              >
                Approve
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => onReject(req.id)}
                disabled={processing === req.id}
              >
                Reject
              </button>
            </div>
          ) : (
            <div>
              <span className={`pairing-status-badge badge-${req.status}`}>
                {req.status}
              </span>
              {req.resolved_at && (
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                  {formatTime(req.resolved_at)}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
