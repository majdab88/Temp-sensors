// Shapes returned by the backend (temp-sensors-cloud/backend/src/routes).
// node-postgres returns bigint columns as strings — never add numbers to them.

export interface Sensor {
  id: number;
  device_id: number;
  mac: string;
  name: string | null;
  paired_at: string;
  active: boolean;
  fw_version: string | null;
  fw_reported_at: string | null;
  cfg_ver: number | null;
  probe_error: boolean | null;
  ota_state: string | null;
  ota_version: string | null;
  ota_pct: number | null;
  ota_error: string | null;
  ota_updated_at: string | null;
  live_until: string | null;
  live_interval_s: number | null;
  live_requested_at: string | null;
  cfg_sleep_secs: number | null;
  battery_type: 'lithium' | 'alkaline' | null;
  hub_mac: string;
  hub_name: string | null;
  temp: number | null;
  hum: number | null;
  rssi: number | null;
  battery: number | null;
  lastUpdate: string | null; // bigint epoch seconds, as a string
}

export interface Reading {
  id?: number;
  temp: number | null;
  hum: number | null;
  battery: number | null;
  rssi: number | null;
  recorded_at: string;
  bat_mv?: number | null;
  bat_load_mv?: number | null;
}

export interface Device {
  id: number;
  mac: string;
  name: string | null;
  org_id: number | null;
  org_name?: string | null;
  registered_at: string;
  fw_version: string | null;
  fw_reported_at: string | null;
  ota_state: string | null;
  ota_version: string | null;
  ota_pct: number | null;
  ota_error: string | null;
  ota_updated_at: string | null;
  online: boolean;
  ip: string | null;
}

/** Live hub state from the `hubStatus` socket event. */
export interface HubStatus {
  hub_mac: string;
  online?: boolean;
  ip?: string;
  fw?: string;
  img_state?: string;
  ts?: number;
}

export interface AlertRule {
  sensor_id: number;
  high_limit: number | null;
  low_limit: number | null;
  hysteresis: number;
  channels: string[];
  cooldown_s?: number;
  enabled: boolean;
}

export interface ActiveAlert {
  sensor_mac: string;
  sensor_name: string | null;
  hub_mac?: string;
  kind: 'high' | 'low';
  value: number;
  high_limit: number | null;
  low_limit: number | null;
  message: string;
  ts: number; // ms
  excursion_id: number | null;
  acked?: boolean;
  ack_by?: string | null;
}

export interface AlertEvent {
  id: number | string;
  sensor_name: string | null;
  sensor_mac: string;
  kind: 'high' | 'low' | 'recovered';
  value: number | null;
  ts: number | string; // epoch seconds
}

export interface Excursion {
  id: number;
  sensor_id: number;
  sensor_name: string | null;
  sensor_mac: string;
  hub_name: string | null;
  hub_mac: string;
  kind: 'high' | 'low';
  peak_value: number | null;
  limit_value: number | null;
  started_at: string;
  ended_at: string | null;
  ack_at: string | null;
  ack_by: string | null;
  ack_note: string | null;
  duration_s: string | number;
}

export interface HealthSettings {
  sensor_offline_enabled: boolean;
  sensor_offline_minutes: number | string;
  hub_offline_enabled: boolean;
  hub_offline_minutes: number | string;
  low_battery_enabled: boolean;
  escalation_enabled: boolean;
  escalation_minutes: number | string;
  org_id?: number | null;
}

export interface SensorConfig {
  id: number;
  mac: string;
  name: string | null;
  applied_cfg_ver: number | null;
  cfg_desired_ver: number | null;
  cfg_sleep_secs: number | null;
  cfg_sh_a: number | null;
  cfg_sh_b: number | null;
  cfg_sh_c: number | null;
  cfg_r_series: number | null;
  pending: boolean;
  history: {
    cfg_ver: number;
    sleep_secs: number;
    sh_a: number;
    sh_b: number;
    sh_c: number;
    r_series: number;
    changed_at: string;
    applied_at: string | null;
  }[];
}

export interface PairingRequest {
  id: number;
  hub_mac: string;
  sensor_mac: string;
  ts?: number;
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
  organizations?: { org_id: number; org_name: string }[];
}

export interface Organization {
  id: number;
  name: string;
  owner_email?: string;
  owner_username?: string;
  device_count?: number | string;
  member_count?: number | string;
  created_at?: string;
}

export interface OrgMember {
  id: number;
  email: string;
  username: string;
  org_role: string;
  permission_level: 'viewer' | 'editor' | 'admin';
  joined_at: string;
}

export interface OrgDevice {
  id: number;
  mac: string;
  name: string | null;
  registered_at: string;
  sensors: { id: number; name: string | null; mac: string; active: boolean; paired_at: string }[];
}

export interface AuditEntry {
  id: number;
  action: string;
  username: string | null;
  target_type: string | null;
  target_id: number | string | null;
  details: unknown;
  created_at: string;
}

export interface FirmwareImage {
  id: number;
  device_kind: 'hub' | 'sensor';
  version: string;
  size: number;
  sha256: string;
  notes: string | null;
  created_at: string;
  created_by: string | null;
}

export interface OtaState {
  state: string;
  version: string | null;
  pct: number | null;
  error: string | null;
  updatedAt: string | null;
}
