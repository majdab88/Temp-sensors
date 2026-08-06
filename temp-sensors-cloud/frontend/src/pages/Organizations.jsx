import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import api from '../services/api'

function formatDate(isoStr) {
  if (!isoStr) return ''
  return new Date(isoStr).toLocaleString()
}

const PERM_LEVELS = [
  { value: 'viewer', label: 'Viewer', desc: 'Read-only access' },
  { value: 'editor', label: 'Editor', desc: 'Manage devices & sensors' },
  { value: 'admin', label: 'Admin', desc: 'Full org control' },
]

export default function Organizations() {
  const { user, startImpersonating } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const isSuperadmin = user?.role === 'superadmin'

  const [orgs, setOrgs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Expanded org (show members + devices)
  const [expandedOrg, setExpandedOrg] = useState(null)
  const [members, setMembers] = useState([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [devices, setDevices] = useState([])
  const [devicesLoading, setDevicesLoading] = useState(false)

  // Add member form
  const [showAddMember, setShowAddMember] = useState(false)
  const [memberForm, setMemberForm] = useState({
    email: '', password: '', permission_level: 'viewer',
  })
  const [addingMember, setAddingMember] = useState(false)
  const [memberError, setMemberError] = useState(null)

  // Device rename
  const [editingDeviceId, setEditingDeviceId] = useState(null)
  const [editingDeviceName, setEditingDeviceName] = useState('')

  // Permission level saving
  const [permSaving, setPermSaving] = useState(null) // userId

  const canManageMembers = isSuperadmin || user?.role === 'owner' || user?.permissionLevel === 'admin'

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
    setDevicesLoading(true)
    setShowAddMember(false)
    setEditingDeviceId(null)

    const [membersRes, devicesRes] = await Promise.allSettled([
      api.get(`/organizations/${orgId}/members`),
      api.get(`/organizations/${orgId}/devices`),
    ])
    setMembers(membersRes.status === 'fulfilled' ? membersRes.value.data : [])
    setMembersLoading(false)
    setDevices(devicesRes.status === 'fulfilled' ? devicesRes.value.data : [])
    setDevicesLoading(false)
  }

  async function handleAddMember(e, orgId) {
    e.preventDefault()
    setMemberError(null)
    setAddingMember(true)
    try {
      await api.post(`/organizations/${orgId}/members`, {
        email: memberForm.email,
        password: memberForm.password || undefined,
        permission_level: memberForm.permission_level,
      })
      setMemberForm({ email: '', password: '', permission_level: 'viewer' })
      setShowAddMember(false)
      const res = await api.get(`/organizations/${orgId}/members`)
      setMembers(res.data)
    } catch (err) {
      setMemberError(err.response?.data?.error || 'Failed to add member')
    } finally {
      setAddingMember(false)
    }
  }

  async function handleRemoveMember(orgId, userId, displayName) {
    const ok = await toast.confirm({
      title: 'Remove member?',
      message: `"${displayName}" will lose access to this organization.`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    try {
      await api.delete(`/organizations/${orgId}/members/${userId}`)
      setMembers((prev) => prev.filter((m) => m.id !== userId))
      toast.success('Member removed')
    } catch {
      toast.error('Failed to remove member')
    }
  }

  async function handleChangePermissionLevel(orgId, userId, newLevel) {
    setPermSaving(userId)
    try {
      await api.put(`/organizations/${orgId}/members/${userId}/permissions`, {
        permission_level: newLevel,
      })
      setMembers((prev) => prev.map((m) =>
        m.id === userId ? { ...m, permission_level: newLevel } : m
      ))
      toast.success('Permission updated')
    } catch {
      toast.error('Failed to update permission level')
    } finally {
      setPermSaving(null)
    }
  }

  async function handleRenameDevice(deviceId) {
    const trimmed = editingDeviceName.trim()
    if (!trimmed) return
    try {
      const res = await api.put(`/devices/${deviceId}`, { name: trimmed })
      setDevices((prev) => prev.map(d => d.id === deviceId ? { ...d, name: res.data.name } : d))
      setEditingDeviceId(null)
    } catch {
      toast.error('Failed to rename device')
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
                  <div className="device-mac">Owner: {org.owner_email || org.owner_username}</div>
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

              {/* Expanded panel: Members + Devices/Sensors */}
              {expandedOrg === org.id && (
                <div className="card" style={{ margin: '0 0 12px 0', padding: 16, borderTop: 'none', borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>

                  {/* --- Members Section --- */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Members</h4>
                    {canManageMembers && (
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
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                          <input
                            type="email"
                            value={memberForm.email}
                            onChange={(e) => setMemberForm({ ...memberForm, email: e.target.value })}
                            placeholder="member@example.com"
                            required
                            style={{ flex: 1, minWidth: 160 }}
                          />
                          <input
                            type="password"
                            value={memberForm.password}
                            onChange={(e) => setMemberForm({ ...memberForm, password: e.target.value })}
                            placeholder="Password (new users only)"
                            style={{ flex: 1, minWidth: 120 }}
                          />
                        </div>

                        {/* Permission level selector */}
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-2)', marginBottom: 6 }}>Permission Level</div>
                          <div className="perm-level-group">
                            {PERM_LEVELS.map(({ value, label, desc }) => (
                              <button
                                key={value}
                                type="button"
                                className={`perm-level-btn ${memberForm.permission_level === value ? 'active' : ''}`}
                                onClick={() => setMemberForm({ ...memberForm, permission_level: value })}
                                title={desc}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button type="submit" className="btn btn-primary btn-sm" disabled={addingMember}>
                            {addingMember ? 'Adding...' : 'Add Member'}
                          </button>
                          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                            Existing users are added directly (no password needed).
                          </span>
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
                        <div key={m.id} className="member-row">
                          <div className="member-info">
                            <div>
                              <span style={{ fontWeight: 500 }}>{m.email || m.username}</span>
                              <span className={`role-badge ${m.org_role}`}>{m.org_role}</span>
                            </div>

                            {/* Permission level for non-owners */}
                            {m.org_role !== 'owner' && (
                              <div className="perm-level-group" style={{ marginTop: 4 }}>
                                {canManageMembers ? (
                                  PERM_LEVELS.map(({ value, label }) => (
                                    <button
                                      key={value}
                                      className={`perm-level-btn ${m.permission_level === value ? 'active' : ''}`}
                                      onClick={() => handleChangePermissionLevel(org.id, m.id, value)}
                                      disabled={permSaving === m.id}
                                    >
                                      {permSaving === m.id ? '...' : label}
                                    </button>
                                  ))
                                ) : (
                                  <span className={`perm-level-badge ${m.permission_level}`}>
                                    {m.permission_level}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>

                          {m.org_role !== 'owner' && canManageMembers && (
                            <button
                              className="btn btn-danger btn-sm"
                              onClick={() => handleRemoveMember(org.id, m.id, m.email || m.username)}
                              style={{ fontSize: 11, padding: '2px 8px', flexShrink: 0 }}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* --- Devices & Sensors Section --- */}
                  <div style={{ marginTop: 20, borderTop: '1px solid var(--border, #e2e8f0)', paddingTop: 16 }}>
                    <h4 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600 }}>Devices</h4>

                    {devicesLoading ? (
                      <div style={{ color: 'var(--text-3)', fontSize: 13 }}>Loading devices...</div>
                    ) : devices.length === 0 ? (
                      <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No devices registered</div>
                    ) : (
                      <div>
                        {devices.map((device) => (
                          <div key={device.id} style={{ marginBottom: 12 }}>
                            {/* Device row */}
                            <div style={{
                              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              padding: '8px 0', borderBottom: '1px solid var(--border, #e2e8f0)',
                            }}>
                              <div style={{ flex: 1 }}>
                                {editingDeviceId === device.id ? (
                                  <form
                                    onSubmit={(e) => { e.preventDefault(); handleRenameDevice(device.id) }}
                                    style={{ display: 'flex', gap: 6, alignItems: 'center' }}
                                  >
                                    <input
                                      type="text"
                                      value={editingDeviceName}
                                      onChange={(e) => setEditingDeviceName(e.target.value)}
                                      autoFocus
                                      style={{ fontSize: 13, padding: '2px 6px', width: 180 }}
                                      onKeyDown={(e) => { if (e.key === 'Escape') setEditingDeviceId(null) }}
                                    />
                                    <button type="submit" className="btn btn-primary btn-sm" style={{ fontSize: 11, padding: '2px 8px' }}>Save</button>
                                    <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => setEditingDeviceId(null)}>Cancel</button>
                                  </form>
                                ) : (
                                  <div>
                                    <span style={{ fontWeight: 500 }}>{device.name || 'Unnamed Hub'}</span>
                                    <button
                                      className="btn btn-ghost btn-sm"
                                      onClick={() => { setEditingDeviceId(device.id); setEditingDeviceName(device.name || '') }}
                                      style={{ fontSize: 11, padding: '1px 6px', marginLeft: 6, opacity: 0.6 }}
                                      title="Rename device"
                                    >
                                      &#9998;
                                    </button>
                                    <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-3)' }}>{device.mac}</span>
                                  </div>
                                )}
                                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                                  Registered: {formatDate(device.registered_at)}
                                </div>
                              </div>
                            </div>

                            {/* Sensors under this device */}
                            {device.sensors && device.sensors.length > 0 ? (
                              <div style={{ paddingLeft: 20, marginTop: 4 }}>
                                {device.sensors.map((sensor) => (
                                  <div key={sensor.id} style={{
                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                    padding: '4px 0', borderBottom: '1px solid var(--border, #e2e8f0)',
                                    fontSize: 12,
                                  }}>
                                    <div>
                                      <span style={{ fontWeight: 500 }}>{sensor.name || sensor.mac}</span>
                                      {sensor.name && (
                                        <span style={{ marginLeft: 8, color: 'var(--text-3)' }}>{sensor.mac}</span>
                                      )}
                                      <span style={{
                                        marginLeft: 8, fontSize: 10, padding: '1px 5px',
                                        borderRadius: 4,
                                        background: sensor.active ? '#dcfce7' : '#fef2f2',
                                        color: sensor.active ? '#166534' : '#991b1b',
                                      }}>
                                        {sensor.active ? 'active' : 'inactive'}
                                      </span>
                                    </div>
                                    <div style={{ color: 'var(--text-3)', fontSize: 11 }}>
                                      Paired: {formatDate(sensor.paired_at)}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div style={{ paddingLeft: 20, marginTop: 4, fontSize: 11, color: 'var(--text-3)' }}>
                                No sensors paired
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
