import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import AlertRules from './pages/AlertRules'
import History from './pages/History'
import Devices from './pages/Devices'
import Provision from './pages/Provision'
import Users from './pages/Users'
import Organizations from './pages/Organizations'
import Account from './pages/Account'
import AuditLog from './pages/AuditLog'

function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuth()
  return isAuthenticated ? children : <Navigate to="/login" replace />
}

function SuperadminRoute({ children }) {
  const { isAuthenticated, user } = useAuth()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  if (user?.role !== 'superadmin') return <Navigate to="/" replace />
  return children
}

/** Redirect superadmin (not impersonating) away from sensor pages */
function OrgScopedRoute({ children }) {
  const { user, impersonation } = useAuth()
  if (user?.role === 'superadmin' && !impersonation) {
    return <Navigate to="/organizations" replace />
  }
  return children
}

/** Superadmin lands on /organizations; everyone else lands on Dashboard */
function IndexRedirect() {
  const { user, impersonation } = useAuth()
  if (user?.role === 'superadmin' && !impersonation) {
    return <Navigate to="/organizations" replace />
  }
  return <Dashboard />
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<IndexRedirect />} />
            <Route path="alerts" element={<OrgScopedRoute><AlertRules /></OrgScopedRoute>} />
            <Route path="history" element={<OrgScopedRoute><History /></OrgScopedRoute>} />
            <Route path="devices" element={<OrgScopedRoute><Devices /></OrgScopedRoute>} />
            <Route path="setup" element={<OrgScopedRoute><Provision /></OrgScopedRoute>} />
            <Route path="organizations" element={<Organizations />} />
            <Route path="account" element={<Account />} />
            <Route path="audit-log" element={<AuditLog />} />
            <Route path="users" element={<SuperadminRoute><Users /></SuperadminRoute>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
