import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react'

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

  // Org permission level fetched from the API (source of truth)
  const [permissionLevel, setPermissionLevel] = useState(null)

  // Impersonation: superadmin viewing a specific org
  const [impersonation, setImpersonation] = useState(() => {
    const stored = sessionStorage.getItem('impersonation')
    return stored ? JSON.parse(stored) : null
  })

  // Fetch real permission level from /api/account whenever token changes
  useEffect(() => {
    if (!token) {
      setPermissionLevel(null)
      return
    }
    fetch('/api/account', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.memberships?.length > 0) {
          setPermissionLevel(data.memberships[0].permission_level)
        }
      })
      .catch(() => {})
  }, [token])

  const user = useMemo(() => {
    if (!token) return null
    const decoded = decodeJwt(token)
    if (!decoded) return null
    return {
      id: decoded.sub,
      username: decoded.username,
      email: decoded.email || null,
      role: decoded.role,
      orgId: decoded.orgId,
      permissionLevel: permissionLevel || decoded.permissionLevel || null,
    }
  }, [token, permissionLevel])

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
    setPermissionLevel(null)
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
