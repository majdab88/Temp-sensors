import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import History from './pages/History'
import Pairing from './pages/Pairing'
import Devices from './pages/Devices'
import Provision from './pages/Provision'
import Users from './pages/Users'
import Organizations from './pages/Organizations'

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
            <Route index element={<Dashboard />} />
            <Route path="history" element={<History />} />
            <Route path="pairing" element={<Pairing />} />
            <Route path="devices" element={<Devices />} />
            <Route path="setup" element={<Provision />} />
            <Route path="organizations" element={<Organizations />} />
            <Route path="users" element={<SuperadminRoute><Users /></SuperadminRoute>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
