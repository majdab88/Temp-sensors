import React, { useEffect, useState, useCallback } from 'react'
import api from '../services/api'

const ACTION_LABELS = {
  'auth.login': 'Login',
  'user.create': 'User Created',
  'user.update': 'User Updated',
  'user.delete': 'User Deleted',
  'member.add': 'Member Added',
  'member.remove': 'Member Removed',
  'member.permissions_update': 'Permissions Updated',
  'device.register': 'Device Registered',
  'device.rename': 'Device Renamed',
  'device.assign': 'Device Assigned',
  'sensor.rename': 'Sensor Renamed',
  'sensor.delete': 'Sensor Deleted',
  'pairing.approve': 'Pairing Approved',
  'pairing.reject': 'Pairing Rejected',
  'org.rename': 'Org Renamed',
  'account.update': 'Profile Updated',
  'account.password_change': 'Password Changed',
}

const ACTION_COLORS = {
  'auth.login': '#3b82f6',
  'member.add': '#22c55e',
  'member.remove': '#ef4444',
  'member.permissions_update': '#eab308',
  'device.register': '#22c55e',
  'sensor.delete': '#ef4444',
  'pairing.approve': '#22c55e',
  'pairing.reject': '#ef4444',
  'user.delete': '#ef4444',
}

function formatDate(isoStr) {
  if (!isoStr) return ''
  return new Date(isoStr).toLocaleString()
}

export default function AuditLog() {
  const [entries, setEntries] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState('')
  const PAGE_SIZE = 30

  const fetchLog = useCallback(() => {
    setLoading(true)
    const params = { limit: PAGE_SIZE, offset: page * PAGE_SIZE }
    if (filter) params.action = filter
    api.get('/audit-log', { params })
      .then((res) => {
        setEntries(res.data.rows)
        setTotal(res.data.total)
      })
      .catch(() => setError('Failed to load audit log'))
      .finally(() => setLoading(false))
  }, [page, filter])

  useEffect(() => { fetchLog() }, [fetchLog])

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const uniqueActions = Object.keys(ACTION_LABELS)

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Audit Log</h1>
        <p className="page-subtitle">Track all user actions and system events</p>
      </div>

      {/* Filter */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="form-group" style={{ margin: 0, minWidth: 180 }}>
          <select
            value={filter}
            onChange={(e) => { setFilter(e.target.value); setPage(0) }}
            style={{ width: '100%', padding: '7px 10px', fontSize: 13 }}
          >
            <option value="">All actions</option>
            {uniqueActions.map((a) => (
              <option key={a} value={a}>{ACTION_LABELS[a] || a}</option>
            ))}
          </select>
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {total} total {total === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="state-loading">Loading audit log...</div>
      ) : entries.length === 0 ? (
        <div className="state-empty">
          <h3>No entries</h3>
          <p>No audit log entries found{filter ? ' for this filter' : ''}</p>
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>User</th>
                    <th>Target</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{formatDate(e.created_at)}</td>
                      <td>
                        <span className="audit-action-badge" style={{
                          borderLeft: `3px solid ${ACTION_COLORS[e.action] || 'var(--text-3)'}`,
                        }}>
                          {ACTION_LABELS[e.action] || e.action}
                        </span>
                      </td>
                      <td style={{ fontSize: 13 }}>{e.username || '—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-2)' }}>
                        {e.target_type && <span>{e.target_type} #{e.target_id}</span>}
                      </td>
                      <td style={{ fontSize: 11, color: 'var(--text-3)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {e.details ? JSON.stringify(e.details) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
              <button
                className="btn btn-ghost btn-sm"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </button>
              <span style={{ fontSize: 13, color: 'var(--text-2)', padding: '5px 8px' }}>
                Page {page + 1} of {totalPages}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                disabled={page >= totalPages - 1}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
