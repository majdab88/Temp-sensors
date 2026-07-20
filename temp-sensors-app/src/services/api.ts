import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { TimeRange } from '../types';

const BASE_URL = 'https://majdtemp32.duckdns.org';

const api = axios.create({
  baseURL: `${BASE_URL}/api`,
  timeout: 10000,
});

// Superadmin impersonation — set by AuthContext
let _impersonatedOrgId: number | null = null;
export function setImpersonatedOrg(orgId: number | null) {
  _impersonatedOrgId = orgId;
}

// Attach JWT + optional X-Org-Id header to every request
api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('jwt_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  if (_impersonatedOrgId !== null) {
    config.headers['X-Org-Id'] = String(_impersonatedOrgId);
  }
  return config;
});

// Auto-refresh access token on 401
let _isRefreshing = false;
let _refreshQueue: Array<(token: string | null) => void> = [];

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    if (error.response?.status !== 401 || original._retry) {
      return Promise.reject(error);
    }
    original._retry = true;

    if (_isRefreshing) {
      // Queue this request until refresh completes
      return new Promise((resolve, reject) => {
        _refreshQueue.push((newToken) => {
          if (newToken) {
            original.headers.Authorization = `Bearer ${newToken}`;
            resolve(api(original));
          } else {
            reject(error);
          }
        });
      });
    }

    _isRefreshing = true;
    try {
      const refreshToken = await SecureStore.getItemAsync('jwt_refresh');
      if (!refreshToken) throw new Error('No refresh token');

      const { data } = await axios.post(`${BASE_URL}/api/auth/refresh`, { refreshToken });
      const newToken: string = data.accessToken;
      await SecureStore.setItemAsync('jwt_token', newToken);

      _refreshQueue.forEach((cb) => cb(newToken));
      _refreshQueue = [];

      original.headers.Authorization = `Bearer ${newToken}`;
      return api(original);
    } catch {
      _refreshQueue.forEach((cb) => cb(null));
      _refreshQueue = [];
      await SecureStore.deleteItemAsync('jwt_token');
      await SecureStore.deleteItemAsync('jwt_refresh');
      return Promise.reject(error);
    } finally {
      _isRefreshing = false;
    }
  }
);

// Auth
export const login = (email: string, password: string) =>
  api.post<{ accessToken: string; refreshToken: string }>('/auth/login', { email, password });

// Sensors
export const getSensors = () =>
  api.get<import('../types').Sensor[]>('/sensors');

export const renameSensor = (id: number, name: string) =>
  api.put(`/sensors/${id}`, { name });

export const deleteSensor = (id: number) =>
  api.delete(`/sensors/${id}`);

export const getSensorReadings = (id: number, range: TimeRange) => {
  const now = Date.now();
  const durations: Record<TimeRange, number> = {
    '24h': 86400000,
    '7d': 604800000,
    '30d': 2592000000,
  };
  const from = new Date(now - durations[range]).toISOString();
  return api.get<import('../types').Reading[]>(`/sensors/${id}/readings`, {
    params: { from },
  });
};

// Devices (hubs)
export const getDevices = () =>
  api.get<import('../types').Device[]>('/devices');

export const registerDevice = (mac: string) =>
  api.post<{ device: import('../types').Device }>('/devices/register', { mac });

export const getProvisionConfig = () =>
  api.get<{ mqttHost: string; mqttPort: number; mqttUser: string; mqttPass: string }>('/provision/config');

// Pairing
export const getPairingRequests = (status = 'pending') =>
  api.get<import('../types').PairingRequest[]>('/pairing/requests', { params: { status } });

export const approvePairing = (id: number) =>
  api.post(`/pairing/requests/${id}/approve`);

export const rejectPairing = (id: number) =>
  api.post(`/pairing/requests/${id}/reject`);

export const enablePairing = (hub_mac: string, enable: boolean) =>
  api.post('/pairing/enable', { hub_mac, enable });

// Account
export const getAccount = () =>
  api.get<import('../types').User>('/account');

export const updateAccount = (data: { username?: string; email?: string }) =>
  api.put('/account', data);

export const changePassword = (currentPassword: string, newPassword: string) =>
  api.put('/account/password', { currentPassword, newPassword });

// Users (superadmin)
export const getUsers = () =>
  api.get<import('../types').User[]>('/users');

export const createUser = (data: { name: string; email: string; password: string; role: string }) =>
  api.post('/users', data);

export const deleteUser = (id: number) =>
  api.delete(`/users/${id}`);

// Organizations
export const getOrganizations = () =>
  api.get<import('../types').Organization[]>('/organizations');

export const createOrganization = (name: string) =>
  api.post('/organizations', { name });

export const deleteOrganization = (id: number) =>
  api.delete(`/organizations/${id}`);

// Devices — rename
export const renameDevice = (id: number, name: string) =>
  api.put(`/devices/${id}`, { name });

// Organization members
export const getOrgMembers = (orgId: number) =>
  api.get<import('../types').OrgMember[]>(`/organizations/${orgId}/members`);

export const inviteMember = (orgId: number, data: { email: string; password?: string; permission_level: string }) =>
  api.post(`/organizations/${orgId}/members`, data);

export const removeMember = (orgId: number, userId: number) =>
  api.delete(`/organizations/${orgId}/members/${userId}`);

export const updateMemberPermissions = (orgId: number, userId: number, permission_level: string) =>
  api.put(`/organizations/${orgId}/members/${userId}/permissions`, { permission_level });

// Organization devices
export const getOrgDevices = (orgId: number) =>
  api.get<import('../types').OrgDevice[]>(`/organizations/${orgId}/devices`);

// Audit log
export const getAuditLog = (page = 1, limit = 50, action?: string) =>
  api.get<import('../types').AuditEntry[]>('/audit-log', { params: { page, limit, ...(action ? { action } : {}) } });

// Alerts
export interface ActiveAlert {
  sensor_mac: string;
  sensor_name: string;
  kind: 'high' | 'low';
  value: number;
  message: string;
  ts: number;
}

export const getActiveAlerts = () =>
  api.get<ActiveAlert[]>('/alerts/active');

// Push notifications
export const registerPushToken = (token: string, platform: string) =>
  api.post('/push/register', { token, platform });

export const unregisterPushToken = (token: string) =>
  api.delete('/push/register', { data: { token } });

export default api;
