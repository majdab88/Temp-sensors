import React, { useEffect, useState, useCallback } from 'react';
import {
  View, FlatList, Text, StyleSheet, RefreshControl,
  TouchableOpacity, Alert, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getUsers, deleteUser } from '../services/api';
import { User } from '../types';

const ROLE_COLORS: Record<string, string> = {
  superadmin: '#7c3aed',
  admin: '#0284c7',
  user: '#334155',
};

export default function UsersScreen() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

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
    Alert.alert('Remove User', `Remove "${user.name}" (${user.email})?`, [
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
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Ionicons name="person-circle-outline" size={32} color="#64748b" />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.email}>{item.email}</Text>
            </View>
            <View style={[styles.roleBadge, { backgroundColor: ROLE_COLORS[item.role] ?? '#334155' }]}>
              <Text style={styles.roleText}>{item.role}</Text>
            </View>
            <TouchableOpacity onPress={() => confirmDelete(item)} style={styles.deleteBtn}>
              <Ionicons name="trash-outline" size={18} color="#ef4444" />
            </TouchableOpacity>
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
  roleBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, marginRight: 8 },
  roleText: { color: '#f1f5f9', fontSize: 11, fontWeight: '700', textTransform: 'capitalize' },
  deleteBtn: { padding: 4 },
  empty: { color: '#475569', textAlign: 'center', marginTop: 40 },
});
