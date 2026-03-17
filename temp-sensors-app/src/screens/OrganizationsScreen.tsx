import React, { useEffect, useState, useCallback } from 'react';
import {
  View, FlatList, Text, StyleSheet, RefreshControl,
  TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getOrganizations } from '../services/api';
import { Organization } from '../types';
import { useAuth } from '../context/AuthContext';

export default function OrganizationsScreen() {
  const { user, impersonateOrg } = useAuth();
  const isSuperadmin = user?.role === 'superadmin';
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

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
            All systems — tap "View As" to manage an org's sensors and hubs.
          </Text>
        ) : null
      }
      renderItem={({ item }) => (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.orgName}>{item.name}</Text>
            {isSuperadmin && (
              <TouchableOpacity
                style={styles.viewAsBtn}
                onPress={() => impersonateOrg(item.id, item.name)}
              >
                <Text style={styles.viewAsBtnText}>View As</Text>
              </TouchableOpacity>
            )}
          </View>

          {item.owner_email && (
            <Text style={styles.meta}>
              <Text style={styles.metaLabel}>Owner: </Text>
              <Text style={styles.metaMono}>{item.owner_email}</Text>
            </Text>
          )}

          <View style={styles.statsRow}>
            <View style={styles.stat}>
              <Ionicons name="hardware-chip-outline" size={14} color="#64748b" />
              <Text style={styles.statText}>{item.device_count ?? 0} hubs</Text>
            </View>
            <View style={styles.stat}>
              <Ionicons name="people-outline" size={14} color="#64748b" />
              <Text style={styles.statText}>{item.member_count ?? 0} members</Text>
            </View>
          </View>

          {item.created_at && (
            <Text style={styles.createdAt}>
              Created: {new Date(item.created_at).toLocaleString()}
            </Text>
          )}
        </View>
      )}
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
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  orgName: { color: '#f1f5f9', fontSize: 17, fontWeight: '700', flex: 1, marginRight: 8 },
  viewAsBtn: {
    backgroundColor: '#0284c7',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  viewAsBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  meta: { color: '#94a3b8', fontSize: 13, marginBottom: 8 },
  metaLabel: { color: '#64748b' },
  metaMono: { fontFamily: 'monospace' },
  statsRow: { flexDirection: 'row', gap: 16, marginBottom: 8 },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statText: { color: '#64748b', fontSize: 13 },
  createdAt: { color: '#475569', fontSize: 12 },
  empty: { color: '#475569', textAlign: 'center', marginTop: 40 },
});
