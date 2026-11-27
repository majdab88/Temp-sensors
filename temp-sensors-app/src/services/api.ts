import axios from 'axios';
import { getItem, setItem, deleteItem } from './storage';
import type {
  Sensor, Reading, Device, AlertRule, ActiveAlert, AlertEvent, Excursion,
  HealthSettings, SensorConfig, User, Organization, OrgMember, OrgDevice,
  AuditEntry, FirmwareImage,
} from '../types';

// The web dashboard and the API share this origin. The app never talks to the
// MQTT broker itself -- it hands a hub whatever address /provision/config
// returns (mqtt.majdabed.com), so a broker move needs no app rebuild.
export const BASE_URL = 'https://temp.majdabed.com';

const api = axios.create({ baseURL: `${BASE_URL}/api`, timeout: 15000 });

// Superadmin "View as" — set by AuthContext.
let _impersonatedOrgId: number | null = null;
export function setImpersonatedOrg(orgId: number | null) {
  _impersonatedOrgId = orgId;
}

api.interceptors.request.use(async (config) => {
  const token = await getItem('jwt_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (_impersonatedOrgId !== null) config.headers['X-Org-Id'] = String(_impersonatedOrgId);
  return config;
});

// Called when the refresh token is gone too, so the app can drop to Login.
let _onSessionEnded: (() => void) | null = null;
export function onSessionEnded(cb: (() => void) | null) { _onSessionEnded = cb; }

// Auto-refresh the access token on 401, queueing requests that arrive while a
// refresh is in flight so only one refresh is ever sent.
let _isRefreshing = false;
let _refreshQueue: Array<(token: string | null) => void> = [];

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    if (error.response?.status !== 401 || !original || original._retry || original.url?.includes('/auth/')) {
      return Promise.reject(error);
    }
    original._retry = true;

    if (_isRefreshing) {
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
      const refreshToken = await getItem('jwt_refresh');
      if (!refreshToken) throw new Error('No refresh token');
      const { data } = await axios.post(`${BASE_URL}/api/auth/refresh`, { refreshToken });
      const newToken: string = data.accessToken;
      await setItem('jwt_token', newToken);
      if (data.refreshToken) await setItem('jwt_refresh', data.refreshToken);
      _refreshQueue.forEach((cb) => cb(newToken));
      _refreshQueue = [];
      original.headers.Authorization = `Bearer ${newToken}`;
      return api(original);
    } catch {
      _refreshQueue.forEach((cb) => cb(null));
      _refreshQueue = [];
      await deleteItem('jwt_token');
      await deleteItem('jwt_refresh');
      _onSessionEnded?.();
      return Promise.reject(error);
    } finally {
      _isRefreshing = false;
    }
  }
);

/** The server's own error text, or a fallback. */
export function errText(err: any, fallback: string): string {
  return err?.response?.data?.error || fallback;
}

// ── Auth ─────────────────────────────────────────────────────────────────────
// An identifier with an @ is an email; anything else is a username (superadmin).
export const login = (identifier: string, password: string) =>
  api.post<{ accessToken: string; refreshToken: string }>('/auth/login',
    identifier.includes('@') ? { email: identifier, password } : { username: identifier, password });

// ── Sensors ──────────────────────────────────────────────────────────────────
export const getSensors = () => api.get<Sensor[]>('/sensors');
export const renameSensor = (id: number, name: string) => api.put(`/sensors/${id}`, { name });
export const deleteSensor = (id: number) => api.delete(`/sensors/${id}`);
export const setBatteryType = (id: number, type: 'lithium' | 'alkaline') =>
  api.put<{ id: number; battery_type: string; battery: number | null }>(`/sensors/${id}/battery-type`, { type });
export const requestLive = (id: number) =>
  api.post<{ duration_s: number; interval_s: number; starts_within_secs: number }>(`/sensors/${id}/live`, {});
export const stopLive = (id: number) => api.delete(`/sensors/${id}/live`);

export const getReadings = (id: number, params: { from?: string; to?: string; limit?: number }) =>
  api.get<Reading[]>(`/sensors/${id}/readings`, { params });
export const getLatestReading = (id: number) => api.get<Reading>(`/sensors/${id}/readings/latest`);

// ── Sensor configuration (superadmin) ─────────────────────────────────────────
export const getSensorConfig = (id: number) => api.get<SensorConfig>(`/sensor-config/${id}`);
export const putSensorConfig = (id: number, body: {
  sleep_secs: number; sh_a: number; sh_b: number; sh_c: number; r_series: number;
}) => api.put<{ unchanged?: boolean; applies_within_secs?: number }>(`/sensor-config/${id}`, body);

// ── Alerts ───────────────────────────────────────────────────────────────────
export const getActiveAlerts = () => api.get<ActiveAlert[]>('/alerts/active');
export const getAlertEvents = (limit = 8) => api.get<AlertEvent[]>('/alerts/events', { params: { limit } });
export const getAlertRule = (sensorId: number) => api.get<AlertRule | null>(`/alerts/rules/${sensorId}`);
export interface AlertRuleInput {
  high_limit: number | null;
  low_limit: number | null;
  hysteresis: number;
  channels: string[];
  enabled: boolean;
  cooldown_s?: number;
}
export const saveAlertRule = (sensorId: number, rule: AlertRuleInput) =>
  api.put<AlertRule>(`/alerts/rules/${sensorId}`, rule);
export const deleteAlertRule = (sensorId: number) => api.delete(`/alerts/rules/${sensorId}`);

export const getHealthSettings = () => api.get<HealthSettings>('/health/settings');
export const saveHealthSettings = (s: HealthSettings) => api.put<HealthSettings>('/health/settings', s);

// ── Excursions ───────────────────────────────────────────────────────────────
export interface ExcursionFilter { sensor_id?: number; active?: 'true'; unacked?: 'true'; from?: string }
export const getExcursions = (f: ExcursionFilter) =>
  api.get<Excursion[]>('/excursions', { params: { ...f, limit: 500 } });
export const getExcursion = (id: number) =>
  api.get<{ excursion: Excursion; readings: { recorded_at: string; temp: number | null; hum: number | null }[] }>(`/excursions/${id}`);
export const ackExcursion = (id: number, note?: string) =>
  api.post<{ ack_at: string; ack_by: string }>(`/excursions/${id}/ack`, note ? { note } : {});

/** Text of an authenticated CSV endpoint (the JWT can't ride on a plain link). */
export async function getCsv(url: string, params: object): Promise<{ text: string; filename: string | null }> {
  const res = await api.get<string>(url, { params, responseType: 'text', transformResponse: (d) => d });
  const cd: string = res.headers['content-disposition'] || '';
  const m = /filename="?([^"]+)"?/.exec(cd);
  return { text: res.data, filename: m ? m[1] : null };
}

// ── Hubs ─────────────────────────────────────────────────────────────────────
export const getDevices = () => api.get<Device[]>('/devices');
export const renameDevice = (id: number, name: string) => api.put<{ name: string }>(`/devices/${id}`, { name });
export const deleteDevice = (id: number) => api.delete(`/devices/${id}`);
// Returns the device row with the hub's own broker account: mqtt_user, and
// api_key as its password.
export const registerDevice = (mac: string, name: string | null) =>
  api.post<Device & { api_key: string; mqtt_user: string }>('/devices/register', { mac, name });
export const getProvisionConfig = () => api.get<{ mqttHost: string; mqttPort: number }>('/provision/config');

// ── Pairing ──────────────────────────────────────────────────────────────────
export const enablePairing = (hub_mac: string, enable: boolean) => api.post('/pairing/enable', { hub_mac, enable });
export const approvePairing = (id: number) => api.post(`/pairing/requests/${id}/approve`);
export const rejectPairing = (id: number) => api.post(`/pairing/requests/${id}/reject`);

// ── Account ──────────────────────────────────────────────────────────────────
export const getAccount = () => api.get<User>('/account');
export const updateAccount = (data: { username?: string; email?: string }) => api.put<Partial<User>>('/account', data);
// The change ends every session, this one included. Keep the tokens it returns
// so this device stays signed in.
export async function changePassword(currentPassword: string, newPassword: string) {
  const res = await api.put<{ accessToken?: string; refreshToken?: string }>(
    '/account/password', { currentPassword, newPassword });
  if (res.data.accessToken && res.data.refreshToken) {
    await setItem('jwt_token', res.data.accessToken);
    await setItem('jwt_refresh', res.data.refreshToken);
  }
  return res;
}

// ── Users (superadmin) ───────────────────────────────────────────────────────
export const getUsers = () => api.get<User[]>('/users');
export const createOwner = (data: { email: string; password: string; orgName?: string }) =>
  api.post('/users', { ...data, role: 'owner' });
export const updateUser = (id: number, data: { email: string; username: string; role: string; password?: string }) =>
  api.put(`/users/${id}`, data);
export const deleteUser = (id: number) => api.delete(`/users/${id}`);

// ── Organizations ────────────────────────────────────────────────────────────
export const getOrganizations = () => api.get<Organization[]>('/organizations');
export const getOrgMembers = (orgId: number) => api.get<OrgMember[]>(`/organizations/${orgId}/members`);
export const addMember = (orgId: number, data: { email: string; password?: string; permission_level: string }) =>
  api.post(`/organizations/${orgId}/members`, data);
export const removeMember = (orgId: number, userId: number) => api.delete(`/organizations/${orgId}/members/${userId}`);
export const setMemberPermission = (orgId: number, userId: number, permission_level: string) =>
  api.put(`/organizations/${orgId}/members/${userId}/permissions`, { permission_level });
export const getOrgDevices = (orgId: number) => api.get<OrgDevice[]>(`/organizations/${orgId}/devices`);

// ── Audit log ────────────────────────────────────────────────────────────────
export const getAuditLog = (params: { limit: number; offset: number; action?: string }) =>
  api.get<{ rows: AuditEntry[]; total: number }>('/audit-log', { params });

// ── Firmware (superadmin) ────────────────────────────────────────────────────
export const getFirmware = () => api.get<FirmwareImage[]>('/firmware');
export const stageFirmware = (imageId: number, target: { hub_mac: string } | { sensor_mac: string }) =>
  api.post<{ needs_button?: boolean }>(`/firmware/${imageId}/stage`, target);
export const cancelSensorStage = (sensorId: number) => api.delete(`/firmware/stage/${sensorId}`);
export const deleteFirmware = (id: number) => api.delete(`/firmware/${id}`);

// ── Push ─────────────────────────────────────────────────────────────────────
export const registerPushToken = (token: string, platform: string) => api.post('/push/register', { token, platform });
export const unregisterPushToken = (token: string) => api.delete('/push/register', { data: { token } });

export default api;
