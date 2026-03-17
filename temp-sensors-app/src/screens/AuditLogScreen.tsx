import React, { useEffect, useState, useCallback } from 'react';
import {
  View, FlatList, Text, StyleSheet, RefreshControl, ActivityIndicator,
  ScrollView, TouchableOpacity,
} from 'react-native';
import { getAuditLog } from '../services/api';
import { AuditEntry } from '../types';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

const ACTION_FILTERS = [
  { key: '', label: 'All' },
  { key: 'auth', label: 'Auth' },
  { key: 'user', label: 'User' },
  { key: 'device', label: 'Device' },
  { key: 'sensor', label: 'Sensor' },
  { key: 'pairing', label: 'Pairing' },
  { key: 'member', label: 'Member' },
  { key: 'account', label: 'Account' },
  { key: 'org', label: 'Org' },
];

function getActionColor(action: string): string {
  if (action.startsWith('auth')) return '#3b82f6';
  if (action.includes('delete') || action.includes('remove') || action.includes('reject')) return '#ef4444';
  if (action.includes('create') || action.includes('register') || action.includes('approve') || action.includes('add')) return '#22c55e';
  if (action.includes('update') || action.includes('rename') || action.includes('permissions')) return '#eab308';
  return '#64748b';
}

export default function AuditLogScreen() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeFilter, setActiveFilter] = useState('');

  const fetchPage = useCallback(async (p: number, append: boolean, filter: string) => {
    try {
      const { data } = await getAuditLog(p, 50, filter || undefined);
      setEntries((prev) => append ? [...prev, ...data] : data);
      setHasMore(data.length === 50);
    } catch {
      // keep existing
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setPage(1);
    fetchPage(1, false, activeFilter).finally(() => setLoading(false));
  }, [fetchPage, activeFilter]);

  const onRefresh = async () => {
    setRefreshing(true);
    setPage(1);
    await fetchPage(1, false, activeFilter);
    setRefreshing(false);
  };

  const loadMore = async () => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    const next = page + 1;
    setPage(next);
    await fetchPage(next, true, activeFilter);
    setLoadingMore(false);
  };

  const handleFilterChange = (filter: string) => {
    setActiveFilter(filter);
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
      {/* Filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterBar}
        contentContainerStyle={styles.filterContent}
      >
        {ACTION_FILTERS.map((f) => (
          <TouchableOpacity
            key={f.key}
            style={[styles.filterChip, activeFilter === f.key && styles.filterChipActive]}
            onPress={() => handleFilterChange(f.key)}
          >
            <Text style={[styles.filterChipText, activeFilter === f.key && styles.filterChipTextActive]}>
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <FlatList
        data={entries}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => {
          const borderColor = getActionColor(item.action);
          return (
            <View style={[styles.entry, { borderLeftColor: borderColor, borderLeftWidth: 3 }]}>
              <View style={styles.entryHeader}>
                <Text style={styles.actor}>{item.actor}</Text>
                <Text style={styles.date}>{formatDate(item.createdAt)}</Text>
              </View>
              <Text style={styles.action}>{item.action}</Text>
              {item.target && <Text style={styles.target}>→ {item.target}</Text>}
              {item.detail && <Text style={styles.detail}>{item.detail}</Text>}
            </View>
          );
        }}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#38bdf8" />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        ListFooterComponent={loadingMore ? <ActivityIndicator color="#38bdf8" style={{ margin: 16 }} /> : null}
        ListEmptyComponent={<Text style={styles.empty}>No audit entries found.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  list: { padding: 16 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' },
  filterBar: {
    maxHeight: 48,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  filterContent: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  filterChip: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  filterChipActive: {
    backgroundColor: '#0284c7',
    borderColor: '#0284c7',
  },
  filterChipText: { color: '#94a3b8', fontSize: 13, fontWeight: '600' },
  filterChipTextActive: { color: '#fff' },
  entry: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  entryHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  actor: { color: '#38bdf8', fontSize: 13, fontWeight: '700' },
  date: { color: '#475569', fontSize: 11 },
  action: { color: '#f1f5f9', fontSize: 14, fontWeight: '600' },
  target: { color: '#94a3b8', fontSize: 13, marginTop: 2 },
  detail: { color: '#64748b', fontSize: 12, marginTop: 2 },
  empty: { color: '#475569', textAlign: 'center', marginTop: 40 },
});
