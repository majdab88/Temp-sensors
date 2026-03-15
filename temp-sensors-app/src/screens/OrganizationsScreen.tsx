import React, { useEffect, useState, useCallback } from 'react';
import {
  View, FlatList, Text, StyleSheet, RefreshControl,
  TouchableOpacity, Alert, TextInput, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getOrganizations, createOrganization, deleteOrganization } from '../services/api';
import { Organization } from '../types';

export default function OrganizationsScreen() {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

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

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const { data } = await createOrganization(name);
      setOrgs((prev) => [...prev, data as Organization]);
      setNewName('');
    } catch {
      Alert.alert('Error', 'Failed to create organization.');
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = (org: Organization) => {
    Alert.alert('Delete Organization', `Delete "${org.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteOrganization(org.id);
            setOrgs((prev) => prev.filter((o) => o.id !== org.id));
          } catch {
            Alert.alert('Error', 'Failed to delete organization.');
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
      <View style={styles.createRow}>
        <TextInput
          style={styles.input}
          placeholder="New organization name"
          placeholderTextColor="#64748b"
          value={newName}
          onChangeText={setNewName}
        />
        <TouchableOpacity style={styles.createBtn} onPress={handleCreate} disabled={creating || !newName.trim()}>
          {creating ? <ActivityIndicator size={18} color="#fff" /> : <Ionicons name="add" size={22} color="#fff" />}
        </TouchableOpacity>
      </View>

      <FlatList
        data={orgs}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Ionicons name="business-outline" size={18} color="#94a3b8" />
            <Text style={styles.orgName}>{item.name}</Text>
            <TouchableOpacity onPress={() => confirmDelete(item)} style={styles.deleteBtn}>
              <Ionicons name="trash-outline" size={18} color="#ef4444" />
            </TouchableOpacity>
          </View>
        )}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#38bdf8" />}
        ListEmptyComponent={<Text style={styles.empty}>No organizations found.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  list: { padding: 16 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' },
  createRow: { flexDirection: 'row', padding: 16, gap: 10, borderBottomWidth: 1, borderColor: '#334155' },
  input: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#f1f5f9',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#334155',
  },
  createBtn: {
    backgroundColor: '#0284c7',
    borderRadius: 10,
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
    gap: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  orgName: { flex: 1, color: '#f1f5f9', fontSize: 15, fontWeight: '600' },
  deleteBtn: { padding: 4 },
  empty: { color: '#475569', textAlign: 'center', marginTop: 40 },
});
