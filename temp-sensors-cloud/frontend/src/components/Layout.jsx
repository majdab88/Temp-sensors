import React, { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import socket from '../services/socket'

function IconDashboard({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  )
}

function IconHistory({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  )
}

function IconPairing({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
  )
}

function IconDevices({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
  )
}

function IconLogout({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  )
}

function IconSetup({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  )
}

function IconThermo({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>
    </svg>
  )
}

function IconUsers({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  )
}

function IconOrg({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  )
}

function IconAccount({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  )
}

function IconAudit({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
      <polyline points="10 9 9 9 8 9"/>
    </svg>
  )
}

export default function Layout() {
  const { user, logout, impersonation, stopImpersonating } = useAuth()
  const navigate = useNavigate()
  const [pendingCount, setPendingCount] = useState(0)

  const isSuperadmin = user?.role === 'superadmin'
  const isViewer = user?.permissionLevel === 'viewer'

  useEffect(() => {
    socket.on('pairingRequest', () => setPendingCount((n) => n + 1))
    return () => { socket.off('pairingRequest') }
  }, [])

  function handleLogout() {
    socket.disconnect()
    logout()
    navigate('/login')
  }

  function handlePairingClick() {
    setPendingCount(0)
  }

  function handleStopImpersonating() {
    stopImpersonating()
    navigate('/organizations')
  }

  // Sensor pages only shown when the user has an org context
  // (owners/members always do; superadmin only when impersonating)
  const showSensorPages = !isSuperadmin || impersonation

  const navLinks = []

  if (showSensorPages) {
    navLinks.push(
      { to: '/', end: true,  icon: <IconDashboard />, label: 'Dashboard' },
      { to: '/history',      icon: <IconHistory />,   label: 'History'   },
    )
    if (!isViewer) {
      navLinks.push(
        { to: '/pairing', icon: <IconPairing />, label: 'Pairing', onClick: handlePairingClick, badge: pendingCount },
        { to: '/devices', icon: <IconDevices />, label: 'Devices' },
        { to: '/setup',   icon: <IconSetup />,   label: 'Setup'   },
      )
    }
  }

  // Admin-only nav links
  if (isSuperadmin) {
    navLinks.push(
      { to: '/organizations', end: !showSensorPages, icon: <IconOrg />,   label: 'Orgs' },
      { to: '/users',         icon: <IconUsers />, label: 'Users' },
      { to: '/audit-log',     icon: <IconAudit />, label: 'Audit Log' },
    )
  } else if (user?.role === 'owner' || user?.permissionLevel === 'admin') {
    navLinks.push(
      { to: '/organizations', icon: <IconOrg />, label: 'My Org' },
      { to: '/audit-log',     icon: <IconAudit />, label: 'Audit Log' },
    )
  }

  // Account link for all users
  navLinks.push(
    { to: '/account', icon: <IconAccount />, label: 'Account' },
  )

  return (
    <div className="layout">

      {/* ── Mobile top header ─────────────────────────────── */}
      <header className="mobile-header">
        <div className="mobile-brand">
          <IconThermo size={18} />
          <span>TempSensors</span>
        </div>
        <button className="mobile-logout-btn" onClick={handleLogout} aria-label="Logout">
          <IconLogout size={18} />
        </button>
      </header>

      {/* ── Desktop sidebar ────────────────────────────────── */}
      <nav className="sidebar">
        <div className="sidebar-brand">
          <IconThermo />
          <span>TempSensors</span>
        </div>
        <ul className="nav-list">
          {navLinks.map(({ to, end, icon, label, onClick, badge }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}
                onClick={onClick}
              >
                {icon} {label}
                {badge > 0 && <span className="nav-badge">{badge}</span>}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="sidebar-footer">
          {user && (
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8, textAlign: 'center' }}>
              {user.email || user.username} <span style={{ opacity: 0.6 }}>({user.role})</span>
            </div>
          )}
          <button className="logout-btn" onClick={handleLogout}>
            <IconLogout /> Logout
          </button>
        </div>
      </nav>

      {/* ── Main content ───────────────────────────────────── */}
      <main className="main-content">
        {impersonation && (
          <div style={{
            background: '#fef3c7', color: '#92400e', padding: '8px 16px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            borderRadius: 8, marginBottom: 16, fontSize: 13, fontWeight: 500,
          }}>
            <span>Viewing as: <strong>{impersonation.orgName}</strong></span>
            <button
              className="btn btn-ghost btn-sm"
              style={{ color: '#92400e', fontWeight: 600 }}
              onClick={handleStopImpersonating}
            >
              Stop Viewing
            </button>
          </div>
        )}
        <Outlet />
      </main>

      {/* ── Mobile bottom tab bar ─────────────────────────── */}
      <nav className="bottom-nav">
        {navLinks.map(({ to, end, icon, label, onClick, badge }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => 'bottom-nav-link' + (isActive ? ' active' : '')}
            onClick={onClick}
          >
            <div className="bottom-nav-icon">
              {icon}
              {badge > 0 && <span className="bottom-badge">{badge}</span>}
            </div>
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

    </div>
  )
}
