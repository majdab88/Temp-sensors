import React, { useEffect, useState, useCallback } from 'react';
import {
  View, FlatList, Text, StyleSheet, RefreshControl, ActivityIndicator,
} from 'react-native';
import { getAuditLog } from '../services/api';
import { AuditEntry } from '../types';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function AuditLogScreen() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchPage = useCallback(async (p: number, append: boolean) => {
    try {
      const { data } = await getAuditLog(p, 50);
      setEntries((prev) => append ? [...prev, ...data] : data);
      setHasMore(data.length === 50);
    } catch {
      // keep existing
    }
  }, []);

  useEffect(() => {
    fetchPage(1, false).finally(() => setLoading(false));
  }, [fetchPage]);

  const onRefresh = async () => {
    setRefreshing(true);
    setPage(1);
    await fetchPage(1, false);
    setRefreshing(false);
  };

  const loadMore = async () => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    const next = page + 1;
    setPage(next);
    await fetchPage(next, true);
    setLoadingMore(false);
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
        data={entries}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <View style={styles.entry}>
            <View style={styles.entryHeader}>
              <Text style={styles.actor}>{item.actor}</Text>
              <Text style={styles.date}>{formatDate(item.createdAt)}</Text>
            </View>
            <Text style={styles.action}>{item.action}</Text>
            {item.target && <Text style={styles.target}>→ {item.target}</Text>}
            {item.detail && <Text style={styles.detail}>{item.detail}</Text>}
          </View>
        )}
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
