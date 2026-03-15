import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { TimeRange } from '../types';

// Set your cloud server URL here (or load from env)
const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://your-cloud-server.example.com';

const api = axios.create({
  baseURL: `${BASE_URL}/api`,
  timeout: 10000,
});

// Attach JWT to every request
api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('jwt_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Auth
export const login = (email: string, password: string) =>
  api.post<{ token: string; user: import('../types').User }>('/auth/login', { email, password });

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
  api.post<{ device: import('../types').Device; mqttUser: string; mqttPass: string; mqttHost: string; mqttPort: number }>('/devices/register', { mac });

// Pairing
export const getPairingRequests = (status = 'pending') =>
  api.get<import('../types').PairingRequest[]>('/pairing/requests', { params: { status } });

export const approvePairing = (id: number) =>
  api.post(`/pairing/requests/${id}/approve`);

export const rejectPairing = (id: number) =>
  api.post(`/pairing/requests/${id}/reject`);

// Account
export const getAccount = () =>
  api.get<import('../types').User>('/account');

export const updateAccount = (data: { name?: string; password?: string }) =>
  api.put('/account', data);

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

// Audit log
export const getAuditLog = (page = 1, limit = 50) =>
  api.get<import('../types').AuditEntry[]>('/audit-log', { params: { page, limit } });

export default api;
