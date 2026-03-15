import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/AppNavigator';
import { useAuth } from '../context/AuthContext';
import { updateAccount, changePassword } from '../services/api';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function AccountScreen() {
  const { user, logout } = useAuth();
  const navigation = useNavigation<Nav>();
  const [username, setUsername] = useState(user?.username ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const saveChanges = async () => {
    const usernameChanged = username.trim() && username.trim() !== user?.username;
    const passwordChange = newPassword.length > 0;

    if (!usernameChanged && !passwordChange) return;

    if (passwordChange && !currentPassword) {
      Alert.alert('Error', 'Enter your current password to set a new one.');
      return;
    }

    setSaving(true);
    try {
      if (usernameChanged) {
        await updateAccount({ username: username.trim() });
      }
      if (passwordChange) {
        await changePassword(currentPassword, newPassword);
        setCurrentPassword('');
        setNewPassword('');
      }
      Alert.alert('Saved', 'Account updated successfully.');
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error ?? 'Failed to update account.');
    } finally {
      setSaving(false);
    }
  };

  const confirmLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: logout },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Profile info */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Profile</Text>

        {user?.email && (
          <View style={styles.field}>
            <Text style={styles.label}>Email</Text>
            <Text style={styles.value}>{user.email}</Text>
          </View>
        )}

        <View style={styles.field}>
          <Text style={styles.label}>Role</Text>
          <Text style={styles.value}>{user?.role}</Text>
          {user?.memberships?.[0] && (
            <Text style={styles.subValue}>
              {user.memberships[0].org_name} · {user.memberships[0].permission_level}
            </Text>
          )}
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Username</Text>
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            placeholder="Username"
            placeholderTextColor="#64748b"
            autoCapitalize="none"
          />
        </View>
      </View>

      {/* Password change */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Change Password</Text>
        <View style={styles.field}>
          <Text style={styles.label}>Current Password</Text>
          <TextInput
            style={styles.input}
            value={currentPassword}
            onChangeText={setCurrentPassword}
            placeholder="Current password"
            placeholderTextColor="#64748b"
            secureTextEntry
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>New Password</Text>
          <TextInput
            style={styles.input}
            value={newPassword}
            onChangeText={setNewPassword}
            placeholder="New password (min 6 chars)"
            placeholderTextColor="#64748b"
            secureTextEntry
          />
        </View>
      </View>

      <TouchableOpacity style={styles.saveBtn} onPress={saveChanges} disabled={saving}>
        {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Save Changes</Text>}
      </TouchableOpacity>

      {/* Navigation links */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>More</Text>

        <TouchableOpacity style={styles.row} onPress={() => navigation.navigate('AuditLog')}>
          <Ionicons name="list-outline" size={20} color="#94a3b8" />
          <Text style={styles.rowLabel}>Audit Log</Text>
          <Ionicons name="chevron-forward" size={18} color="#475569" />
        </TouchableOpacity>

        {(user?.role === 'owner' || user?.role === 'superadmin') && (
          <TouchableOpacity style={styles.row} onPress={() => navigation.navigate('Organizations')}>
            <Ionicons name="business-outline" size={20} color="#94a3b8" />
            <Text style={styles.rowLabel}>Organizations</Text>
            <Ionicons name="chevron-forward" size={18} color="#475569" />
          </TouchableOpacity>
        )}

        {user?.role === 'superadmin' && (
          <TouchableOpacity style={styles.row} onPress={() => navigation.navigate('Users')}>
            <Ionicons name="people-outline" size={20} color="#94a3b8" />
            <Text style={styles.rowLabel}>Users</Text>
            <Ionicons name="chevron-forward" size={18} color="#475569" />
          </TouchableOpacity>
        )}
      </View>

      <TouchableOpacity style={styles.logoutBtn} onPress={confirmLogout}>
        <Ionicons name="log-out-outline" size={20} color="#ef4444" />
        <Text style={styles.logoutText}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  content: { padding: 16 },
  section: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  sectionTitle: { color: '#94a3b8', fontSize: 12, fontWeight: '700', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 },
  field: { marginBottom: 12 },
  label: { color: '#64748b', fontSize: 12, marginBottom: 4 },
  value: { color: '#f1f5f9', fontSize: 15 },
  subValue: { color: '#64748b', fontSize: 12, marginTop: 2 },
  input: {
    backgroundColor: '#0f172a',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#f1f5f9',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#334155',
  },
  saveBtn: {
    backgroundColor: '#0284c7',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 16,
  },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    gap: 12,
  },
  rowLabel: { flex: 1, color: '#f1f5f9', fontSize: 15 },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  logoutText: { color: '#ef4444', fontWeight: '700', fontSize: 15 },
});
