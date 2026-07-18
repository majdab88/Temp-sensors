import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import { User } from '../types';
import { login as apiLogin, getAccount, setImpersonatedOrg, registerPushToken, unregisterPushToken } from '../services/api';
import { connectSocket, disconnectSocket } from '../services/socket';
import { registerForPushNotifications } from '../services/push';

interface ImpersonatedOrg {
  id: number;
  name: string;
}

interface AuthContextValue {
  user: User | null;
  token: string | null;
  loading: boolean;
  impersonatedOrg: ImpersonatedOrg | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  impersonateOrg: (id: number, name: string) => void;
  stopImpersonating: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
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

  // Restore session on app start
  useEffect(() => {
    (async () => {
      try {
        const storedToken = await SecureStore.getItemAsync('jwt_token');
        if (storedToken) {
          setToken(storedToken);
          try {
            const { data } = await getAccount();
            setUser(data);
            connectSocket(storedToken);
            setupPush();
          } catch (err: any) {
            // Access token expired — the response interceptor in api.ts will have
            // already attempted a refresh and stored a new jwt_token if successful.
            // Try once more with whatever token is now in SecureStore.
            if (err.response?.status === 401) {
              const refreshedToken = await SecureStore.getItemAsync('jwt_token');
              if (refreshedToken && refreshedToken !== storedToken) {
                setToken(refreshedToken);
                const { data } = await getAccount();
                setUser(data);
                connectSocket(refreshedToken);
                setupPush();
              } else {
                throw err; // refresh also failed → clear tokens below
              }
            } else {
              throw err;
            }
          }
        }
      } catch {
        await SecureStore.deleteItemAsync('jwt_token');
        await SecureStore.deleteItemAsync('jwt_refresh');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = async (email: string, password: string) => {
    const { data } = await apiLogin(email, password);
    await SecureStore.setItemAsync('jwt_token', data.accessToken);
    await SecureStore.setItemAsync('jwt_refresh', data.refreshToken);
    setToken(data.accessToken);
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
    disconnectSocket();
    setImpersonatedOrg(null);
    setImpersonatedOrgState(null);
    await SecureStore.deleteItemAsync('jwt_token');
    await SecureStore.deleteItemAsync('jwt_refresh');
    setToken(null);
    setUser(null);
  };

  const impersonateOrg = (id: number, name: string) => {
    setImpersonatedOrg(id);
    setImpersonatedOrgState({ id, name });
  };

  const stopImpersonating = () => {
    setImpersonatedOrg(null);
    setImpersonatedOrgState(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, impersonatedOrg, login, logout, impersonateOrg, stopImpersonating }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
