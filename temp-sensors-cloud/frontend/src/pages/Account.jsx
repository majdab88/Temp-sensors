import React, { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import api from '../services/api'

function formatDate(isoStr) {
  if (!isoStr) return ''
  return new Date(isoStr).toLocaleString('en-GB')
}

export default function Account() {
  const { user } = useAuth()
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Profile edit
  const [editing, setEditing] = useState(false)
  const [profileForm, setProfileForm] = useState({ username: '', email: '' })
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMsg, setProfileMsg] = useState(null)

  // Password change
  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '', confirm: '' })
  const [pwSaving, setPwSaving] = useState(false)
  const [pwMsg, setPwMsg] = useState(null)

  useEffect(() => {
    api.get('/account')
      .then((res) => {
        setProfile(res.data)
        setProfileForm({ username: res.data.username || '', email: res.data.email || '' })
      })
      .catch(() => setError('Failed to load profile'))
      .finally(() => setLoading(false))
  }, [])

  async function handleProfileSave(e) {
    e.preventDefault()
    setProfileSaving(true)
    setProfileMsg(null)
    try {
      const res = await api.put('/account', {
        username: profileForm.username || undefined,
        email: profileForm.email || undefined,
      })
      setProfile((prev) => ({ ...prev, ...res.data }))
      setEditing(false)
      setProfileMsg({ type: 'ok', text: 'Profile updated' })
    } catch (err) {
      setProfileMsg({ type: 'err', text: err.response?.data?.error || 'Failed to update profile' })
    } finally {
      setProfileSaving(false)
    }
  }

  async function handlePasswordChange(e) {
    e.preventDefault()
    setPwMsg(null)
    if (pwForm.newPassword !== pwForm.confirm) {
      setPwMsg({ type: 'err', text: 'New passwords do not match' })
      return
    }
    if (pwForm.newPassword.length < 6) {
      setPwMsg({ type: 'err', text: 'New password must be at least 6 characters' })
      return
    }
    setPwSaving(true)
    try {
      await api.put('/account/password', {
        currentPassword: pwForm.currentPassword,
        newPassword: pwForm.newPassword,
      })
      setPwForm({ currentPassword: '', newPassword: '', confirm: '' })
      setPwMsg({ type: 'ok', text: 'Password changed successfully' })
    } catch (err) {
      setPwMsg({ type: 'err', text: err.response?.data?.error || 'Failed to change password' })
    } finally {
      setPwSaving(false)
    }
  }

  if (loading) return <div className="state-loading">Loading profile...</div>
  if (error) return <div className="state-error"><h3>Error</h3><p>{error}</p></div>

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">My Account</h1>
        <p className="page-subtitle">Manage your profile and security settings</p>
      </div>

      {/* Profile Section */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Profile</h3>
          {!editing && (
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit</button>
          )}
        </div>

        {profileMsg && (
          <div className={`alert ${profileMsg.type === 'err' ? 'alert-error' : 'alert-ok'}`}>
            {profileMsg.text}
          </div>
        )}

        {editing ? (
          <form onSubmit={handleProfileSave}>
            <div className="form-group">
              <label>Username</label>
              <input
                type="text"
                value={profileForm.username}
                onChange={(e) => setProfileForm({ ...profileForm, username: e.target.value })}
                minLength={2}
              />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input
                type="email"
                value={profileForm.email}
                onChange={(e) => setProfileForm({ ...profileForm, email: e.target.value })}
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="btn btn-primary btn-sm" disabled={profileSaving}>
                {profileSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setEditing(false)
                  setProfileForm({ username: profile.username || '', email: profile.email || '' })
                  setProfileMsg(null)
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="account-details">
            <div className="account-row">
              <span className="account-label">Username</span>
              <span className="account-value">{profile.username}</span>
            </div>
            <div className="account-row">
              <span className="account-label">Email</span>
              <span className="account-value">{profile.email || '—'}</span>
            </div>
            <div className="account-row">
              <span className="account-label">Role</span>
              <span className="account-value" style={{ textTransform: 'capitalize' }}>{profile.role}</span>
            </div>
            <div className="account-row">
              <span className="account-label">Joined</span>
              <span className="account-value">{formatDate(profile.created_at)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Memberships */}
      {profile.memberships && profile.memberships.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 12px 0' }}>My Memberships</h3>
          {profile.memberships.map((m) => (
            <div key={m.org_id} className="membership-row">
              <div>
                <span style={{ fontWeight: 500 }}>{m.org_name}</span>
                <span className={`role-badge ${m.org_role}`}>{m.org_role}</span>
              </div>
              <div className="perm-pills">
                {m.org_role === 'owner' ? (
                  <span className="perm-pill granted">All permissions</span>
                ) : (
                  <span className={`perm-level-badge ${m.permission_level}`}>
                    {m.permission_level}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Password Change */}
      <div className="card">
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 16px 0' }}>Change Password</h3>

        {pwMsg && (
          <div className={`alert ${pwMsg.type === 'err' ? 'alert-error' : 'alert-ok'}`}>
            {pwMsg.text}
          </div>
        )}

        <form onSubmit={handlePasswordChange}>
          <div className="form-group">
            <label>Current Password</label>
            <input
              type="password"
              value={pwForm.currentPassword}
              onChange={(e) => setPwForm({ ...pwForm, currentPassword: e.target.value })}
              required
            />
          </div>
          <div className="form-group">
            <label>New Password</label>
            <input
              type="password"
              value={pwForm.newPassword}
              onChange={(e) => setPwForm({ ...pwForm, newPassword: e.target.value })}
              required
              minLength={6}
            />
          </div>
          <div className="form-group">
            <label>Confirm New Password</label>
            <input
              type="password"
              value={pwForm.confirm}
              onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })}
              required
              minLength={6}
            />
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={pwSaving}>
            {pwSaving ? 'Changing...' : 'Change Password'}
          </button>
        </form>
      </div>
    </div>
  )
}
