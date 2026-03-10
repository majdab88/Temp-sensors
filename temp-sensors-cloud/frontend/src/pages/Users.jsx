import React, { useEffect, useState } from 'react'
import api from '../services/api'

function formatDate(isoStr) {
  if (!isoStr) return ''
  return new Date(isoStr).toLocaleString()
}

export default function Users() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Create user form
  const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState({ username: '', password: '', orgName: '' })
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState(null)

  function fetchUsers() {
    setLoading(true)
    api.get('/users')
      .then((res) => setUsers(res.data))
      .catch(() => setError('Failed to load users'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchUsers() }, [])

  async function handleCreate(e) {
    e.preventDefault()
    setFormError(null)
    setCreating(true)
    try {
      await api.post('/users', {
        username: formData.username,
        password: formData.password,
        role: 'owner',
        orgName: formData.orgName || undefined,
      })
      setFormData({ username: '', password: '', orgName: '' })
      setShowForm(false)
      fetchUsers()
    } catch (err) {
      setFormError(err.response?.data?.error || 'Failed to create user')
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(userId, username) {
    if (!window.confirm(`Delete user "${username}"? Their devices will become unassigned.`)) return
    try {
      await api.delete(`/users/${userId}`)
      setUsers((prev) => prev.filter((u) => u.id !== userId))
    } catch {
      alert('Failed to delete user')
    }
  }

  if (loading) return <div className="state-loading">Loading users...</div>
  if (error) return <div className="state-error"><h3>Error</h3><p>{error}</p></div>

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">User Management</h1>
        <p className="page-subtitle">Register and manage system owners</p>
      </div>

      <button
        className="btn btn-primary"
        style={{ marginBottom: 16 }}
        onClick={() => setShowForm(!showForm)}
      >
        {showForm ? 'Cancel' : '+ New Owner'}
      </button>

      {showForm && (
        <div className="card" style={{ marginBottom: 20, padding: 20 }}>
          <h3 style={{ marginBottom: 12, fontSize: 15, fontWeight: 600 }}>Create New Owner</h3>
          {formError && <div className="alert alert-error" style={{ marginBottom: 12 }}>{formError}</div>}
          <form onSubmit={handleCreate}>
            <div className="form-group">
              <label>Username</label>
              <input
                type="text"
                value={formData.username}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                placeholder="e.g. john"
                required
                minLength={2}
              />
            </div>
            <div className="form-group" style={{ marginTop: 10 }}>
              <label>Password</label>
              <input
                type="password"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                placeholder="Min 6 characters"
                required
                minLength={6}
              />
            </div>
            <div className="form-group" style={{ marginTop: 10 }}>
              <label>Organization Name <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>(optional)</span></label>
              <input
                type="text"
                value={formData.orgName}
                onChange={(e) => setFormData({ ...formData, orgName: e.target.value })}
                placeholder="e.g. John's Greenhouse"
              />
            </div>
            <button type="submit" className="btn btn-primary" style={{ marginTop: 14 }} disabled={creating}>
              {creating ? 'Creating...' : 'Create Owner'}
            </button>
          </form>
        </div>
      )}

      {users.length === 0 ? (
        <div className="state-empty">
          <h3>No users yet</h3>
          <p>Create your first system owner above</p>
        </div>
      ) : (
        <div className="devices-list">
          {users.map((user) => (
            <div key={user.id} className="device-card">
              <div className="device-card-info">
                <div className="device-name">{user.username}</div>
                <div className="device-mac" style={{ textTransform: 'capitalize' }}>{user.role}</div>
                <div className="device-meta">Joined: {formatDate(user.created_at)}</div>
                {user.organizations && user.organizations.length > 0 && (
                  <div className="device-meta">
                    Orgs: {user.organizations.map((o) => o.org_name).join(', ')}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span
                  className={`pairing-status-badge badge-${user.role === 'superadmin' ? 'approved' : 'pending'}`}
                  style={{ textTransform: 'capitalize' }}
                >
                  {user.role}
                </span>
                {user.role !== 'superadmin' && (
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => handleDelete(user.id, user.username)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
