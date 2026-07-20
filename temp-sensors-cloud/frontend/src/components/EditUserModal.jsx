import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import api from '../services/api'

/**
 * Superadmin editor for a single user: email, username, role, and an optional
 * password reset. Passwords are stored as bcrypt hashes and cannot be read —
 * this only *sets* a new one. Leaving the password blank keeps the current one.
 *
 * onClose(changed) — changed=true if the user was saved.
 */
export default function EditUserModal({ user, onClose }) {
  const [email, setEmail]       = useState(user.email || '')
  const [username, setUsername] = useState(user.username || '')
  const [role, setRole]         = useState(user.role === 'member' ? 'member' : 'owner')
  const [password, setPassword] = useState('')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState(null)

  async function handleSave() {
    setError(null)
    const emailStr = email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr)) return setError('Enter a valid email')
    if (username.trim().length < 2) return setError('Username must be at least 2 characters')
    if (password && password.length < 6) return setError('New password must be at least 6 characters')

    const payload = { email: emailStr, username: username.trim(), role }
    if (password) payload.password = password

    setSaving(true)
    try {
      await api.put(`/users/${user.id}`, payload)
      onClose(true)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save')
      setSaving(false)
    }
  }

  return createPortal(
    <div className="modal-overlay" onClick={() => onClose(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Edit user</h3>
          <div className="modal-sub">{user.email || user.username}</div>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="form-group">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>

        <div className="form-group">
          <label>Username</label>
          <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={64} />
        </div>

        <div className="form-group">
          <label>Role</label>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="owner">Owner</option>
            <option value="member">Member</option>
          </select>
        </div>

        <div className="form-group">
          <label>New password <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>(optional)</span></label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="Leave blank to keep current" autoComplete="new-password" />
          <div className="form-hint">Sets a new password. The existing one can’t be shown — it’s stored hashed.</div>
        </div>

        <div className="modal-actions">
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={() => onClose(false)} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
