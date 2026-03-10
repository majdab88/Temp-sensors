import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import api from '../services/api'

function formatDate(isoStr) {
  if (!isoStr) return ''
  return new Date(isoStr).toLocaleString()
}

export default function Organizations() {
  const { user, startImpersonating } = useAuth()
  const navigate = useNavigate()
  const isSuperadmin = user?.role === 'superadmin'

  const [orgs, setOrgs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Expanded org (show members)
  const [expandedOrg, setExpandedOrg] = useState(null)
  const [members, setMembers] = useState([])
  const [membersLoading, setMembersLoading] = useState(false)

  // Add member form
  const [showAddMember, setShowAddMember] = useState(false)
  const [memberForm, setMemberForm] = useState({ username: '', password: '' })
  const [addingMember, setAddingMember] = useState(false)
  const [memberError, setMemberError] = useState(null)

  const fetchOrgs = useCallback(() => {
    setLoading(true)
    api.get('/organizations')
      .then((res) => setOrgs(res.data))
      .catch(() => setError('Failed to load organizations'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { fetchOrgs() }, [fetchOrgs])

  async function toggleExpand(orgId) {
    if (expandedOrg === orgId) {
      setExpandedOrg(null)
      return
    }
    setExpandedOrg(orgId)
    setMembersLoading(true)
    setShowAddMember(false)
    try {
      const res = await api.get(`/organizations/${orgId}/members`)
      setMembers(res.data)
    } catch {
      setMembers([])
    } finally {
      setMembersLoading(false)
    }
  }

  async function handleAddMember(e, orgId) {
    e.preventDefault()
    setMemberError(null)
    setAddingMember(true)
    try {
      await api.post(`/organizations/${orgId}/members`, {
        username: memberForm.username,
        password: memberForm.password,
      })
      setMemberForm({ username: '', password: '' })
      setShowAddMember(false)
      // Refresh members
      const res = await api.get(`/organizations/${orgId}/members`)
      setMembers(res.data)
    } catch (err) {
      setMemberError(err.response?.data?.error || 'Failed to add member')
    } finally {
      setAddingMember(false)
    }
  }

  async function handleRemoveMember(orgId, userId, username) {
    if (!window.confirm(`Remove "${username}" from this organization?`)) return
    try {
      await api.delete(`/organizations/${orgId}/members/${userId}`)
      setMembers((prev) => prev.filter((m) => m.id !== userId))
    } catch {
      alert('Failed to remove member')
    }
  }

  function handleViewAsOrg(orgId, orgName) {
    startImpersonating(orgId, orgName)
    navigate('/')
  }

  if (loading) return <div className="state-loading">Loading organizations...</div>
  if (error) return <div className="state-error"><h3>Error</h3><p>{error}</p></div>

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Organizations</h1>
        <p className="page-subtitle">
          {isSuperadmin
            ? 'All systems — click to manage members or view as that org'
            : 'Your organizations'
          }
        </p>
      </div>

      {orgs.length === 0 ? (
        <div className="state-empty">
          <h3>No organizations</h3>
          <p>{isSuperadmin ? 'Create an owner user to auto-create an organization' : 'You are not part of any organization yet'}</p>
        </div>
      ) : (
        <div className="devices-list">
          {orgs.map((org) => (
            <div key={org.id}>
              <div
                className="device-card"
                style={{ cursor: 'pointer' }}
                onClick={() => toggleExpand(org.id)}
              >
                <div className="device-card-info">
                  <div className="device-name">{org.name}</div>
                  <div className="device-mac">Owner: {org.owner_username}</div>
                  <div className="device-meta">
                    {org.device_count} hub{org.device_count !== 1 ? 's' : ''} &middot; {org.member_count} member{org.member_count !== 1 ? 's' : ''}
                  </div>
                  <div className="device-meta">Created: {formatDate(org.created_at)}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {isSuperadmin && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={(e) => { e.stopPropagation(); handleViewAsOrg(org.id, org.name) }}
                    >
                      View As
                    </button>
                  )}
                  <span style={{ fontSize: 18, color: 'var(--text-3)' }}>
                    {expandedOrg === org.id ? '\u25B2' : '\u25BC'}
                  </span>
                </div>
              </div>

              {/* Expanded: Members panel */}
              {expandedOrg === org.id && (
                <div className="card" style={{ margin: '0 0 12px 0', padding: 16, borderTop: 'none', borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Members</h4>
                    {(isSuperadmin || user?.role === 'owner') && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setShowAddMember(!showAddMember)}
                      >
                        {showAddMember ? 'Cancel' : '+ Invite Member'}
                      </button>
                    )}
                  </div>

                  {showAddMember && (
                    <div style={{ marginBottom: 14, padding: 12, background: 'var(--bg-2, #f8fafc)', borderRadius: 8 }}>
                      {memberError && <div className="alert alert-error" style={{ marginBottom: 8 }}>{memberError}</div>}
                      <form onSubmit={(e) => handleAddMember(e, org.id)}>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <input
                            type="text"
                            value={memberForm.username}
                            onChange={(e) => setMemberForm({ ...memberForm, username: e.target.value })}
                            placeholder="Username"
                            required
                            minLength={2}
                            style={{ flex: 1, minWidth: 120 }}
                          />
                          <input
                            type="password"
                            value={memberForm.password}
                            onChange={(e) => setMemberForm({ ...memberForm, password: e.target.value })}
                            placeholder="Password (min 6)"
                            required
                            minLength={6}
                            style={{ flex: 1, minWidth: 120 }}
                          />
                          <button type="submit" className="btn btn-primary btn-sm" disabled={addingMember}>
                            {addingMember ? 'Adding...' : 'Add'}
                          </button>
                        </div>
                      </form>
                    </div>
                  )}

                  {membersLoading ? (
                    <div style={{ color: 'var(--text-3)', fontSize: 13 }}>Loading members...</div>
                  ) : members.length === 0 ? (
                    <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No members yet</div>
                  ) : (
                    <div>
                      {members.map((m) => (
                        <div key={m.id} style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '8px 0', borderBottom: '1px solid var(--border, #e2e8f0)',
                        }}>
                          <div>
                            <span style={{ fontWeight: 500 }}>{m.username}</span>
                            <span style={{
                              marginLeft: 8, fontSize: 11, padding: '2px 6px',
                              borderRadius: 4, background: m.org_role === 'owner' ? '#dbeafe' : '#f1f5f9',
                              color: m.org_role === 'owner' ? '#1e40af' : '#64748b',
                              textTransform: 'capitalize',
                            }}>
                              {m.org_role}
                            </span>
                          </div>
                          {m.org_role !== 'owner' && (isSuperadmin || user?.role === 'owner') && (
                            <button
                              className="btn btn-danger btn-sm"
                              onClick={() => handleRemoveMember(org.id, m.id, m.username)}
                              style={{ fontSize: 11, padding: '2px 8px' }}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
