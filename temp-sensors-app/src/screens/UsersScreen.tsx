import React, { useEffect, useState, useCallback } from 'react';
import {
  View, FlatList, Text, StyleSheet, RefreshControl,
  TouchableOpacity, Alert, ActivityIndicator, TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getUsers, deleteUser, createUser } from '../services/api';
import { User } from '../types';

const ROLE_COLORS: Record<string, string> = {
  superadmin: '#7c3aed',
  owner: '#0284c7',
  member: '#334155',
};

export default function UsersScreen() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Create user form
  const [showForm, setShowForm] = useState(false);
  const [formEmail, setFormEmail] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formOrgName, setFormOrgName] = useState('');
  const [creating, setCreating] = useState(false);

  const fetchUsers = useCallback(async () => {
    try {
      const { data } = await getUsers();
      setUsers(data);
    } catch {
      // keep existing
    }
  }, []);

  useEffect(() => {
    fetchUsers().finally(() => setLoading(false));
  }, [fetchUsers]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchUsers();
    setRefreshing(false);
  };

  const confirmDelete = (user: User) => {
    Alert.alert('Remove User', `Remove "${user.username}" (${user.email ?? user.username})?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteUser(user.id);
            setUsers((prev) => prev.filter((u) => u.id !== user.id));
          } catch {
            Alert.alert('Error', 'Failed to remove user.');
          }
        },
      },
    ]);
  };

  const handleCreate = async () => {
    if (!formEmail.trim()) {
      Alert.alert('Error', 'Email is required.');
      return;
    }
    if (formPassword.length < 6) {
      Alert.alert('Error', 'Password must be at least 6 characters.');
      return;
    }
    setCreating(true);
    try {
      await createUser({
        email: formEmail.trim(),
        password: formPassword,
        name: formOrgName.trim() || formEmail.trim(),
        role: 'owner',
      });
      setFormEmail('');
      setFormPassword('');
      setFormOrgName('');
      setShowForm(false);
      await fetchUsers();
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error ?? 'Failed to create user.');
    } finally {
      setCreating(false);
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
    <View style={styles.container}>
      <FlatList
        data={users}
        keyExtractor={(item) => String(item.id)}
        ListHeaderComponent={
          <View>
            {/* Create user section */}
            <TouchableOpacity
              style={styles.createToggle}
              onPress={() => setShowForm(!showForm)}
            >
              <Ionicons name={showForm ? 'close-circle-outline' : 'person-add-outline'} size={18} color="#38bdf8" />
              <Text style={styles.createToggleText}>{showForm ? 'Cancel' : 'Create New User'}</Text>
            </TouchableOpacity>

            {showForm && (
              <View style={styles.formCard}>
                <TextInput
                  style={styles.input}
                  value={formEmail}
                  onChangeText={setFormEmail}
                  placeholder="Email"
                  placeholderTextColor="#64748b"
                  autoCapitalize="none"
                  keyboardType="email-address"
                />
                <TextInput
                  style={styles.input}
                  value={formPassword}
                  onChangeText={setFormPassword}
                  placeholder="Password (min 6 chars)"
                  placeholderTextColor="#64748b"
                  secureTextEntry
                />
                <TextInput
                  style={styles.input}
                  value={formOrgName}
                  onChangeText={setFormOrgName}
                  placeholder="Organization name (optional)"
                  placeholderTextColor="#64748b"
                />
                <TouchableOpacity
                  style={styles.createBtn}
                  onPress={handleCreate}
                  disabled={creating}
                >
                  {creating ? (
                    <ActivityIndicator size={14} color="#fff" />
                  ) : (
                    <Text style={styles.createBtnText}>Create Owner Account</Text>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Ionicons name="person-circle-outline" size={32} color="#64748b" />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.name}>{item.username}</Text>
              <Text style={styles.email}>{item.email ?? ''}</Text>
              {item.created_at && (
                <Text style={styles.joinDate}>
                  Joined: {new Date(item.created_at).toLocaleDateString()}
                </Text>
              )}
            </View>
            <View style={[styles.roleBadge, { backgroundColor: ROLE_COLORS[item.role] ?? '#334155' }]}>
              <Text style={styles.roleText}>{item.role}</Text>
            </View>
            {item.role !== 'superadmin' && (
              <TouchableOpacity onPress={() => confirmDelete(item)} style={styles.deleteBtn}>
                <Ionicons name="trash-outline" size={18} color="#ef4444" />
              </TouchableOpacity>
            )}
          </View>
        )}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#38bdf8" />}
        ListEmptyComponent={<Text style={styles.empty}>No users found.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  list: { padding: 16 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' },
  createToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  createToggleText: { color: '#38bdf8', fontSize: 14, fontWeight: '600' },
  formCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
    gap: 10,
  },
  input: {
    backgroundColor: '#0f172a',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#f1f5f9',
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  createBtn: {
    backgroundColor: '#0284c7',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  createBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  name: { color: '#f1f5f9', fontSize: 15, fontWeight: '600' },
  email: { color: '#64748b', fontSize: 12, marginTop: 2 },
  joinDate: { color: '#475569', fontSize: 11, marginTop: 1 },
  roleBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, marginRight: 8 },
  roleText: { color: '#f1f5f9', fontSize: 11, fontWeight: '700', textTransform: 'capitalize' },
  deleteBtn: { padding: 4 },
  empty: { color: '#475569', textAlign: 'center', marginTop: 40 },
});
