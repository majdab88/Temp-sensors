import React, { useEffect, useState, useCallback } from 'react';
import {
  View, FlatList, Text, StyleSheet, RefreshControl,
  TouchableOpacity, ActivityIndicator, TextInput, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  getOrganizations, getOrgMembers, getOrgDevices,
  inviteMember, removeMember, updateMemberPermissions, renameDevice,
} from '../services/api';
import { Organization, OrgMember, OrgDevice } from '../types';
import { useAuth } from '../context/AuthContext';

const PERM_LEVELS = ['viewer', 'editor', 'admin'] as const;
const PERM_COLORS: Record<string, string> = {
  viewer: '#475569', editor: '#0284c7', admin: '#7c3aed',
};

export default function OrganizationsScreen() {
  const { user, impersonateOrg } = useAuth();
  const isSuperadmin = user?.role === 'superadmin';
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Expanded org state
  const [expandedOrgId, setExpandedOrgId] = useState<number | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [devices, setDevices] = useState<OrgDevice[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [devicesLoading, setDevicesLoading] = useState(false);

  // Invite member form
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [invitePassword, setInvitePassword] = useState('');
  const [invitePermission, setInvitePermission] = useState<string>('viewer');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Device rename
  const [editingDeviceId, setEditingDeviceId] = useState<number | null>(null);
  const [editingDeviceName, setEditingDeviceName] = useState('');

  const fetchOrgs = useCallback(async () => {
    try {
      const { data } = await getOrganizations();
      setOrgs(data);
    } catch {
      // keep existing
    }
  }, []);

  useEffect(() => {
    fetchOrgs().finally(() => setLoading(false));
  }, [fetchOrgs]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchOrgs();
    setRefreshing(false);
  };

  const toggleExpand = async (orgId: number) => {
    if (expandedOrgId === orgId) {
      setExpandedOrgId(null);
      return;
    }
    setExpandedOrgId(orgId);
    setShowInviteForm(false);
    setEditingDeviceId(null);
    setMembersLoading(true);
    setDevicesLoading(true);

    const [membersRes, devicesRes] = await Promise.allSettled([
      getOrgMembers(orgId),
      getOrgDevices(orgId),
    ]);
    setMembers(membersRes.status === 'fulfilled' ? membersRes.value.data : []);
    setMembersLoading(false);
    setDevices(devicesRes.status === 'fulfilled' ? devicesRes.value.data : []);
    setDevicesLoading(false);
  };

  const handleInvite = async (orgId: number) => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteError(null);
    try {
      await inviteMember(orgId, {
        email: inviteEmail.trim(),
        password: invitePassword || undefined,
        permission_level: invitePermission,
      });
      setInviteEmail('');
      setInvitePassword('');
      setInvitePermission('viewer');
      setShowInviteForm(false);
      const res = await getOrgMembers(orgId);
      setMembers(res.data);
    } catch (err: any) {
      setInviteError(err?.response?.data?.error || 'Failed to add member');
    } finally {
      setInviting(false);
    }
  };

  const handleRemoveMember = (orgId: number, member: OrgMember) => {
    Alert.alert(
      'Remove Member',
      `Remove "${member.username || member.email}" from this organization?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeMember(orgId, member.id);
              setMembers((prev) => prev.filter((m) => m.id !== member.id));
            } catch {
              Alert.alert('Error', 'Failed to remove member.');
            }
          },
        },
      ]
    );
  };

  const handleChangePermission = async (orgId: number, userId: number, newLevel: string) => {
    try {
      await updateMemberPermissions(orgId, userId, newLevel);
      setMembers((prev) =>
        prev.map((m) =>
          m.id === userId ? { ...m, permission_level: newLevel as OrgMember['permission_level'] } : m
        )
      );
    } catch {
      Alert.alert('Error', 'Failed to update permission level.');
    }
  };

  const handleRenameDevice = async (deviceId: number) => {
    const trimmed = editingDeviceName.trim();
    if (!trimmed) return;
    try {
      await renameDevice(deviceId, trimmed);
      setDevices((prev) => prev.map((d) => d.id === deviceId ? { ...d, name: trimmed } : d));
      setEditingDeviceId(null);
    } catch {
      Alert.alert('Error', 'Failed to rename device.');
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#38bdf8" />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={orgs}
      keyExtractor={(item) => String(item.id)}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#38bdf8" />}
      ListHeaderComponent={
        isSuperadmin ? (
          <Text style={styles.subtitle}>
            All systems — tap an org to manage members, devices, and sensors.
          </Text>
        ) : null
      }
      renderItem={({ item: org }) => {
        const isExpanded = expandedOrgId === org.id;
        return (
          <View style={styles.card}>
            {/* Card header — always visible */}
            <TouchableOpacity style={styles.cardHeader} onPress={() => toggleExpand(org.id)} activeOpacity={0.7}>
              <View style={{ flex: 1 }}>
                <Text style={styles.orgName}>{org.name}</Text>
                {org.owner_email && (
                  <Text style={styles.meta}>
                    <Text style={styles.metaLabel}>Owner: </Text>
                    <Text style={styles.metaMono}>{org.owner_email}</Text>
                  </Text>
                )}
                <View style={styles.statsRow}>
                  <View style={styles.stat}>
                    <Ionicons name="hardware-chip-outline" size={14} color="#64748b" />
                    <Text style={styles.statText}>{org.device_count ?? 0} hubs</Text>
                  </View>
                  <View style={styles.stat}>
                    <Ionicons name="people-outline" size={14} color="#64748b" />
                    <Text style={styles.statText}>{org.member_count ?? 0} members</Text>
                  </View>
                </View>
              </View>
              <View style={styles.headerActions}>
                {isSuperadmin && (
                  <TouchableOpacity
                    style={styles.viewAsBtn}
                    onPress={() => impersonateOrg(org.id, org.name)}
                  >
                    <Text style={styles.viewAsBtnText}>View As</Text>
                  </TouchableOpacity>
                )}
                <Ionicons
                  name={isExpanded ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color="#64748b"
                />
              </View>
            </TouchableOpacity>

            {/* Expanded content */}
            {isExpanded && (
              <View style={styles.expandedContent}>
                {/* --- Members Section --- */}
                <View style={styles.sectionDivider}>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>Members</Text>
                    <TouchableOpacity onPress={() => setShowInviteForm(!showInviteForm)}>
                      <Ionicons name={showInviteForm ? 'close' : 'person-add-outline'} size={18} color="#38bdf8" />
                    </TouchableOpacity>
                  </View>

                  {/* Invite form */}
                  {showInviteForm && (
                    <View style={styles.inviteForm}>
                      <TextInput
                        style={styles.input}
                        value={inviteEmail}
                        onChangeText={setInviteEmail}
                        placeholder="Email address"
                        placeholderTextColor="#64748b"
                        autoCapitalize="none"
                        keyboardType="email-address"
                      />
                      <TextInput
                        style={styles.input}
                        value={invitePassword}
                        onChangeText={setInvitePassword}
                        placeholder="Password (new users only)"
                        placeholderTextColor="#64748b"
                        secureTextEntry
                      />
                      <View style={styles.permRow}>
                        {PERM_LEVELS.map((level) => (
                          <TouchableOpacity
                            key={level}
                            style={[
                              styles.permChip,
                              invitePermission === level && { backgroundColor: PERM_COLORS[level] },
                            ]}
                            onPress={() => setInvitePermission(level)}
                          >
                            <Text style={[
                              styles.permChipText,
                              invitePermission === level && { color: '#fff' },
                            ]}>
                              {level}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                      {inviteError && <Text style={styles.errorText}>{inviteError}</Text>}
                      <TouchableOpacity
                        style={styles.inviteBtn}
                        onPress={() => handleInvite(org.id)}
                        disabled={inviting}
                      >
                        {inviting ? (
                          <ActivityIndicator size={14} color="#fff" />
                        ) : (
                          <Text style={styles.inviteBtnText}>Add Member</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  )}

                  {membersLoading ? (
                    <ActivityIndicator size="small" color="#38bdf8" style={{ marginTop: 8 }} />
                  ) : members.length === 0 ? (
                    <Text style={styles.emptyText}>No members</Text>
                  ) : (
                    members.map((m) => (
                      <View key={m.id} style={styles.memberRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.memberName}>{m.username || m.email}</Text>
                          {m.username && <Text style={styles.memberEmail}>{m.email}</Text>}
                          <Text style={styles.memberRole}>{m.org_role}</Text>
                        </View>
                        <View style={styles.memberActions}>
                          {/* Permission level buttons */}
                          {PERM_LEVELS.map((level) => (
                            <TouchableOpacity
                              key={level}
                              style={[
                                styles.permBtn,
                                m.permission_level === level && { backgroundColor: PERM_COLORS[level] },
                              ]}
                              onPress={() => handleChangePermission(org.id, m.id, level)}
                              disabled={m.permission_level === level}
                            >
                              <Text style={[
                                styles.permBtnText,
                                m.permission_level === level && { color: '#fff' },
                              ]}>
                                {level.charAt(0).toUpperCase()}
                              </Text>
                            </TouchableOpacity>
                          ))}
                          {m.org_role !== 'owner' && (
                            <TouchableOpacity
                              style={styles.removeMemberBtn}
                              onPress={() => handleRemoveMember(org.id, m)}
                            >
                              <Ionicons name="trash-outline" size={14} color="#ef4444" />
                            </TouchableOpacity>
                          )}
                        </View>
                      </View>
                    ))
                  )}
                </View>

                {/* --- Devices & Sensors Section --- */}
                <View style={styles.sectionDivider}>
                  <Text style={styles.sectionTitle}>Devices & Sensors</Text>
                  {devicesLoading ? (
                    <ActivityIndicator size="small" color="#38bdf8" style={{ marginTop: 8 }} />
                  ) : devices.length === 0 ? (
                    <Text style={styles.emptyText}>No devices registered</Text>
                  ) : (
                    devices.map((device) => (
                      <View key={device.id} style={styles.deviceBlock}>
                        {/* Device row */}
                        <View style={styles.deviceRow}>
                          {editingDeviceId === device.id ? (
                            <View style={styles.deviceEditRow}>
                              <TextInput
                                style={styles.deviceEditInput}
                                value={editingDeviceName}
                                onChangeText={setEditingDeviceName}
                                autoFocus
                                maxLength={30}
                              />
                              <TouchableOpacity onPress={() => handleRenameDevice(device.id)} style={styles.deviceEditBtn}>
                                <Ionicons name="checkmark" size={16} color="#22c55e" />
                              </TouchableOpacity>
                              <TouchableOpacity onPress={() => setEditingDeviceId(null)} style={styles.deviceEditBtn}>
                                <Ionicons name="close" size={16} color="#ef4444" />
                              </TouchableOpacity>
                            </View>
                          ) : (
                            <View style={styles.deviceNameRow}>
                              <Text style={styles.deviceName}>{device.name || 'Unnamed Hub'}</Text>
                              <TouchableOpacity
                                onPress={() => { setEditingDeviceId(device.id); setEditingDeviceName(device.name || ''); }}
                                style={styles.deviceEditBtn}
                              >
                                <Ionicons name="pencil-outline" size={12} color="#64748b" />
                              </TouchableOpacity>
                              <Text style={styles.deviceMac}>{device.mac}</Text>
                            </View>
                          )}
                        </View>
                        {device.registered_at && (
                          <Text style={styles.deviceDate}>
                            Registered: {new Date(device.registered_at).toLocaleDateString()}
                          </Text>
                        )}

                        {/* Sensors under this device */}
                        {device.sensors && device.sensors.length > 0 ? (
                          <View style={styles.sensorsList}>
                            {device.sensors.map((sensor) => (
                              <View key={sensor.id} style={styles.sensorRow}>
                                <Text style={styles.sensorName}>{sensor.name || sensor.mac}</Text>
                                {sensor.name && <Text style={styles.sensorMac}>{sensor.mac}</Text>}
                                <View style={[
                                  styles.sensorBadge,
                                  { backgroundColor: sensor.active ? '#14532d' : '#450a0a' },
                                ]}>
                                  <Text style={styles.sensorBadgeText}>
                                    {sensor.active ? 'active' : 'inactive'}
                                  </Text>
                                </View>
                              </View>
                            ))}
                          </View>
                        ) : (
                          <Text style={styles.noSensors}>No sensors paired</Text>
                        )}
                      </View>
                    ))
                  )}
                </View>
              </View>
            )}
          </View>
        );
      }}
      ListEmptyComponent={
        <Text style={styles.empty}>No organizations found.</Text>
      }
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  list: { padding: 16 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' },
  subtitle: { color: '#64748b', fontSize: 13, marginBottom: 16, lineHeight: 18 },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  headerActions: {
    alignItems: 'flex-end',
    gap: 8,
  },
  orgName: { color: '#f1f5f9', fontSize: 17, fontWeight: '700', marginBottom: 4 },
  viewAsBtn: {
    backgroundColor: '#0284c7',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  viewAsBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  meta: { color: '#94a3b8', fontSize: 13, marginBottom: 6 },
  metaLabel: { color: '#64748b' },
  metaMono: { fontFamily: 'monospace' },
  statsRow: { flexDirection: 'row', gap: 16 },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statText: { color: '#64748b', fontSize: 13 },
  empty: { color: '#475569', textAlign: 'center', marginTop: 40 },
  expandedContent: { marginTop: 16 },
  sectionDivider: {
    borderTopWidth: 1,
    borderTopColor: '#334155',
    paddingTop: 12,
    marginTop: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  sectionTitle: { color: '#94a3b8', fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  emptyText: { color: '#475569', fontSize: 13, marginTop: 4 },

  // Invite form
  inviteForm: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    gap: 8,
  },
  input: {
    backgroundColor: '#1e293b',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#f1f5f9',
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  permRow: { flexDirection: 'row', gap: 8 },
  permChip: {
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  permChipText: { color: '#94a3b8', fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  errorText: { color: '#ef4444', fontSize: 12 },
  inviteBtn: {
    backgroundColor: '#0284c7',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  inviteBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  // Member row
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#0f172a',
  },
  memberName: { color: '#f1f5f9', fontSize: 14, fontWeight: '600' },
  memberEmail: { color: '#64748b', fontSize: 11 },
  memberRole: { color: '#475569', fontSize: 11, marginTop: 1 },
  memberActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  permBtn: {
    borderRadius: 4,
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f172a',
  },
  permBtnText: { color: '#64748b', fontSize: 11, fontWeight: '700' },
  removeMemberBtn: { padding: 4, marginLeft: 4 },

  // Devices
  deviceBlock: { marginTop: 8 },
  deviceRow: { marginBottom: 2 },
  deviceNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  deviceName: { color: '#f1f5f9', fontSize: 14, fontWeight: '600' },
  deviceMac: { color: '#475569', fontSize: 11 },
  deviceDate: { color: '#475569', fontSize: 11, marginBottom: 4 },
  deviceEditRow: { flexDirection: 'row', alignItems: 'center' },
  deviceEditInput: {
    flex: 1,
    backgroundColor: '#0f172a',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    color: '#f1f5f9',
    fontSize: 13,
    borderWidth: 1,
    borderColor: '#0284c7',
  },
  deviceEditBtn: { padding: 4, marginLeft: 4 },

  // Sensors
  sensorsList: { paddingLeft: 16, marginTop: 4 },
  sensorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#0f172a',
    gap: 8,
  },
  sensorName: { color: '#cbd5e1', fontSize: 12, fontWeight: '500' },
  sensorMac: { color: '#475569', fontSize: 11 },
  sensorBadge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 },
  sensorBadgeText: { color: '#f1f5f9', fontSize: 10, fontWeight: '700' },
  noSensors: { color: '#475569', fontSize: 11, paddingLeft: 16, marginTop: 4 },
});
