import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import { User } from '../types';
import { login as apiLogin, getAccount } from '../services/api';
import { connectSocket, disconnectSocket } from '../services/socket';

interface AuthContextValue {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore session on app start
  useEffect(() => {
    (async () => {
      try {
        const storedToken = await SecureStore.getItemAsync('jwt_token');
        if (storedToken) {
          setToken(storedToken);
          const { data } = await getAccount();
          setUser(data);
          connectSocket(storedToken);
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
  };

  const logout = async () => {
    disconnectSocket();
    await SecureStore.deleteItemAsync('jwt_token');
    await SecureStore.deleteItemAsync('jwt_refresh');
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
