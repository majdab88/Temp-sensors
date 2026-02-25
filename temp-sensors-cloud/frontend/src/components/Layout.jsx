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

function IconThermo({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>
    </svg>
  )
}

export default function Layout() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const [pendingCount, setPendingCount] = useState(0)

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

  const navLinks = [
    { to: '/', end: true,  icon: <IconDashboard />, label: 'Dashboard' },
    { to: '/history',      icon: <IconHistory />,   label: 'History'   },
    { to: '/pairing',      icon: <IconPairing />,   label: 'Pairing', onClick: handlePairingClick, badge: pendingCount },
    { to: '/devices',      icon: <IconDevices />,   label: 'Devices'   },
  ]

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
          <button className="logout-btn" onClick={handleLogout}>
            <IconLogout /> Logout
          </button>
        </div>
      </nav>

      {/* ── Main content ───────────────────────────────────── */}
      <main className="main-content">
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
