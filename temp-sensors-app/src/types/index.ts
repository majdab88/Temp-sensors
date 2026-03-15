export interface Sensor {
  id: number;
  name: string;
  mac: string;
  temp: number;
  hum: number;
  rssi: number;
  battery: number;
  active: boolean;
  lastUpdate: number; // Unix timestamp (seconds)
  deviceId?: number;
}

export interface Device {
  id: number;
  mac: string;
  name: string;
  online: boolean;
  ip?: string;
  apiKey?: string;
  registeredAt: string;
}

export interface Reading {
  id: number;
  sensorId: number;
  temp: number;
  hum: number;
  battery: number;
  rssi: number;
  recordedAt: string; // ISO timestamp
}

export interface PairingRequest {
  id: number;
  slaveMac: string;
  deviceId: number;
  deviceName?: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface User {
  id: number;
  name: string;
  email: string;
  role: 'user' | 'admin' | 'superadmin';
  orgId?: number;
  createdAt: string;
}

export interface Organization {
  id: number;
  name: string;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target?: string;
  detail?: string;
  createdAt: string;
}

export type TimeRange = '24h' | '7d' | '30d';
