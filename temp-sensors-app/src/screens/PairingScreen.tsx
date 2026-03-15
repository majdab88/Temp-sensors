import React, { useEffect, useState, useCallback } from 'react';
import {
  View, FlatList, Text, StyleSheet, RefreshControl, ActivityIndicator,
} from 'react-native';
import PairingCard from '../components/PairingCard';
import { getPairingRequests } from '../services/api';
import { PairingRequest } from '../types';

export default function PairingScreen() {
  const [requests, setRequests] = useState<PairingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchRequests = useCallback(async () => {
    try {
      const { data } = await getPairingRequests('pending');
      setRequests(data);
    } catch {
      // keep existing
    }
  }, []);

  useEffect(() => {
    fetchRequests().finally(() => setLoading(false));
  }, [fetchRequests]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchRequests();
    setRefreshing(false);
  };

  const onResolved = (id: number) => {
    setRequests((prev) => prev.filter((r) => r.id !== id));
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
        data={requests}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => <PairingCard request={item} onResolved={onResolved} />}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#38bdf8" />
        }
        ListHeaderComponent={
          <Text style={styles.header}>
            {requests.length === 0
              ? 'No pending pairing requests'
              : `${requests.length} pending request${requests.length > 1 ? 's' : ''}`}
          </Text>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyHint}>
              New sensor nodes will appear here when they request to pair.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  list: { padding: 16 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' },
  header: { color: '#94a3b8', fontSize: 14, marginBottom: 12 },
  empty: { alignItems: 'center', marginTop: 40 },
  emptyHint: { color: '#475569', fontSize: 13, textAlign: 'center' },
});
