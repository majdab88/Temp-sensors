import React from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import socket from '../services/socket'

function IconDashboard({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  )
}

function IconBell({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  )
}

function IconHistory({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  )
}

function IconReports({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
    </svg>
  )
}

function IconDevices({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
  )
}

function IconSetup({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  )
}

function IconFirmware({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="6" width="12" height="12" rx="2"/>
      <path d="M10 2v4M14 2v4M10 18v4M14 18v4M2 10h4M2 14h4M18 10h4M18 14h4"/>
    </svg>
  )
}

function IconUsers({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  )
}

function IconOrg({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  )
}

function IconAccount({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  )
}

function IconAudit({ size = 20 }) {
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
  const isSuperadmin = user?.role === 'superadmin'
  const isViewer = user?.permissionLevel === 'viewer'

  function handleLogout() {
    socket.disconnect()
    logout()
    navigate('/login')
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
      { to: '/alerts',       icon: <IconBell />,      label: 'Alerts'    },
      { to: '/history',      icon: <IconHistory />,   label: 'History'   },
      { to: '/reports',      icon: <IconReports />,   label: 'Reports'   },
    )
    if (!isViewer) {
      navLinks.push(
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
      { to: '/firmware',      icon: <IconFirmware />, label: 'Firmware' },
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

      {/* ── Top bar ────────────────────────────────────────── */}
      <header className="topbar">
        <NavLink to="/" className="brand">TempSensors<b>.</b></NavLink>

        <nav className="topnav">
          {navLinks.map(({ to, end, label }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => 'top-link' + (isActive ? ' active' : '')}
            >
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="topbar-right">
          {impersonation && (
            <button className="imp-chip" onClick={handleStopImpersonating} title="Stop viewing this organization">
              Viewing: {impersonation.orgName} ✕
            </button>
          )}
          {user && (
            <span className="topbar-user">
              {user.email || user.username} · {user.role}
            </span>
          )}
          <button className="logout-btn" onClick={handleLogout}>Logout</button>
        </div>
      </header>

      {/* ── Main content ───────────────────────────────────── */}
      <main className="main-content">
        <Outlet />
      </main>

      {/* ── Mobile bottom tab bar ─────────────────────────── */}
      <nav className="bottom-nav">
        {navLinks.map(({ to, end, icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => 'bottom-nav-link' + (isActive ? ' active' : '')}
          >
            <div className="bottom-nav-icon">{icon}</div>
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

    </div>
  )
}
