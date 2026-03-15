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
  api_key?: string;
  registered_at: string;
}

export interface Reading {
  id: number;
  temp: number;
  hum: number;
  battery: number;
  rssi: number;
  recorded_at: string;
}

export interface PairingRequest {
  id: number;
  slave_mac: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_at: string;
  resolved_at?: string;
  resolved_by?: string;
  hub_mac?: string;
  hub_name?: string;
}

export interface Membership {
  org_id: number;
  org_name: string;
  org_role: string;
  permission_level: 'viewer' | 'editor' | 'admin';
  joined_at: string;
}

export interface User {
  id: number;
  username: string;
  email: string | null;
  role: 'owner' | 'member' | 'superadmin';
  created_at: string;
  memberships?: Membership[];
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
