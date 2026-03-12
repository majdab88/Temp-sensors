import React, { createContext, useContext, useState, useCallback, useMemo } from 'react'

const AuthContext = createContext(null)

/** Decode the payload of a JWT (no verification — that's the server's job) */
function decodeJwt(token) {
  try {
    const payload = token.split('.')[1]
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return null
  }
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('accessToken'))

  // Impersonation: superadmin viewing a specific org
  const [impersonation, setImpersonation] = useState(() => {
    const stored = sessionStorage.getItem('impersonation')
    return stored ? JSON.parse(stored) : null
  })

  const user = useMemo(() => {
    if (!token) return null
    const decoded = decodeJwt(token)
    if (!decoded) return null
    return { id: decoded.sub, username: decoded.username, email: decoded.email || null, role: decoded.role, orgId: decoded.orgId, permissionLevel: decoded.permissionLevel || null }
  }, [token])

  const login = useCallback((accessToken, refreshToken) => {
    localStorage.setItem('accessToken', accessToken)
    localStorage.setItem('refreshToken', refreshToken)
    setToken(accessToken)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('accessToken')
    localStorage.removeItem('refreshToken')
    sessionStorage.removeItem('impersonation')
    setImpersonation(null)
    setToken(null)
  }, [])

  const startImpersonating = useCallback((orgId, orgName) => {
    const imp = { orgId, orgName }
    sessionStorage.setItem('impersonation', JSON.stringify(imp))
    setImpersonation(imp)
  }, [])

  const stopImpersonating = useCallback(() => {
    sessionStorage.removeItem('impersonation')
    setImpersonation(null)
  }, [])

  return (
    <AuthContext.Provider value={{
      token, user, login, logout,
      isAuthenticated: !!token,
      impersonation, startImpersonating, stopImpersonating,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
