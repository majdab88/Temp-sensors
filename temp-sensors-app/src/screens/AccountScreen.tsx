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
import { updateAccount } from '../services/api';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function AccountScreen() {
  const { user, logout } = useAuth();
  const navigation = useNavigation<Nav>();
  const [name, setName] = useState(user?.name ?? '');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const saveChanges = async () => {
    const updates: { name?: string; password?: string } = {};
    if (name.trim() && name.trim() !== user?.name) updates.name = name.trim();
    if (password) updates.password = password;
    if (!Object.keys(updates).length) return;

    setSaving(true);
    try {
      await updateAccount(updates);
      setPassword('');
      Alert.alert('Saved', 'Account updated successfully.');
    } catch {
      Alert.alert('Error', 'Failed to update account.');
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
        <View style={styles.field}>
          <Text style={styles.label}>Email</Text>
          <Text style={styles.value}>{user?.email}</Text>
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Role</Text>
          <Text style={styles.value}>{user?.role}</Text>
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Display Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Your name"
            placeholderTextColor="#64748b"
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>New Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="Leave blank to keep current"
            placeholderTextColor="#64748b"
            secureTextEntry
          />
        </View>
        <TouchableOpacity style={styles.saveBtn} onPress={saveChanges} disabled={saving}>
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Save Changes</Text>}
        </TouchableOpacity>
      </View>

      {/* Navigation links */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>More</Text>

        <TouchableOpacity style={styles.row} onPress={() => navigation.navigate('AuditLog')}>
          <Ionicons name="list-outline" size={20} color="#94a3b8" />
          <Text style={styles.rowLabel}>Audit Log</Text>
          <Ionicons name="chevron-forward" size={18} color="#475569" />
        </TouchableOpacity>

        {(user?.role === 'admin' || user?.role === 'superadmin') && (
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
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  saveBtnText: { color: '#fff', fontWeight: '700' },
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
