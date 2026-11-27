import React, { createContext, useContext, useState, useEffect, useRef, ReactNode, useCallback } from 'react';
import { User } from '../types';
import {
  login as apiLogin, getAccount, setImpersonatedOrg, registerPushToken, unregisterPushToken, onSessionEnded,
} from '../services/api';
import { connectSocket, disconnectSocket } from '../services/socket';
import { registerForPushNotifications } from '../services/push';
import { getItem, setItem, deleteItem } from '../services/storage';

interface ImpersonatedOrg { id: number; name: string }

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  impersonatedOrg: ImpersonatedOrg | null;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  impersonateOrg: (id: number, name: string) => void;
  stopImpersonating: () => void;
  // Role gates, matching the web dashboard (frontend/src/components/Layout.jsx)
  isSuperadmin: boolean;
  /** Org permission level from the first membership; null for superadmin. */
  permissionLevel: 'viewer' | 'editor' | 'admin' | null;
  /** Rename, delete, pair, set alert rules, acknowledge… — everyone but viewers. */
  canEdit: boolean;
  /** Org page + audit log: owners, org admins, superadmin. */
  isOrgAdmin: boolean;
  /** Sensor screens need an org: always for org users, for superadmin only while viewing one. */
  hasOrgContext: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [impersonatedOrg, setImpersonatedOrgState] = useState<ImpersonatedOrg | null>(null);
  const pushTokenRef = useRef<string | null>(null);

  // Register this device for push and hand the token to the backend.
  // Non-fatal: a failure here must never block login/session restore.
  const setupPush = async () => {
    try {
      const result = await registerForPushNotifications();
      if (result) {
        pushTokenRef.current = result.token;
        await registerPushToken(result.token, result.platform);
      }
    } catch (err) {
      console.warn('[push] setup failed', err);
    }
  };

  const clearLocal = useCallback(async () => {
    disconnectSocket();
    setImpersonatedOrg(null);
    setImpersonatedOrgState(null);
    await deleteItem('jwt_token');
    await deleteItem('jwt_refresh');
    setUser(null);
  }, []);

  // A refresh that fails mid-session (revoked, expired) ends it here too.
  useEffect(() => {
    onSessionEnded(() => { clearLocal(); });
    return () => onSessionEnded(null);
  }, [clearLocal]);

  // Restore session on app start. getAccount() goes through the 401
  // interceptor, which refreshes an expired access token by itself.
  useEffect(() => {
    (async () => {
      try {
        if (await getItem('jwt_token')) {
          const { data } = await getAccount();
          setUser(data);
          connectSocket((await getItem('jwt_token')) ?? '');
          setupPush();
        }
      } catch {
        await deleteItem('jwt_token');
        await deleteItem('jwt_refresh');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = async (identifier: string, password: string) => {
    const { data } = await apiLogin(identifier.trim(), password);
    await setItem('jwt_token', data.accessToken);
    await setItem('jwt_refresh', data.refreshToken);
    const { data: userData } = await getAccount();
    setUser(userData);
    connectSocket(data.accessToken);
    setupPush();
  };

  const logout = async () => {
    // Stop push to this device for the current account before dropping the token.
    if (pushTokenRef.current) {
      try { await unregisterPushToken(pushTokenRef.current); } catch { /* best-effort */ }
      pushTokenRef.current = null;
    }
    await clearLocal();
  };

  const refreshUser = async () => {
    const { data } = await getAccount();
    setUser(data);
  };

  const impersonateOrg = (id: number, name: string) => {
    setImpersonatedOrg(id);
    setImpersonatedOrgState({ id, name });
  };

  const stopImpersonating = () => {
    setImpersonatedOrg(null);
    setImpersonatedOrgState(null);
  };

  const isSuperadmin = user?.role === 'superadmin';
  const permissionLevel = user?.memberships?.[0]?.permission_level ?? null;
  const canEdit = !!user && permissionLevel !== 'viewer';
  const isOrgAdmin = isSuperadmin || user?.role === 'owner' || permissionLevel === 'admin';
  const hasOrgContext = !!user && (!isSuperadmin || !!impersonatedOrg);

  return (
    <AuthContext.Provider value={{
      user, loading, impersonatedOrg, login, logout, refreshUser, impersonateOrg, stopImpersonating,
      isSuperadmin, permissionLevel, canEdit, isOrgAdmin, hasOrgContext,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
