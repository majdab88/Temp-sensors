import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PairingRequest } from '../types';
import { approvePairing, rejectPairing } from '../services/api';

interface Props {
  request: PairingRequest;
  onResolved: (id: number) => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

export default function PairingCard({ request, onResolved }: Props) {
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null);

  const handle = async (action: 'approve' | 'reject') => {
    setLoading(action);
    try {
      if (action === 'approve') await approvePairing(request.id);
      else await rejectPairing(request.id);
      onResolved(request.id);
    } catch {
      // ignore — keep card visible so user can retry
    } finally {
      setLoading(null);
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="link-outline" size={18} color="#94a3b8" />
        <Text style={styles.mac}>{request.slave_mac}</Text>
      </View>
      <Text style={styles.meta}>
        Hub: {request.hub_name ?? request.hub_mac ?? 'Unknown'}
      </Text>
      <Text style={styles.meta}>Requested: {formatDate(request.requested_at)}</Text>

      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.approveBtn}
          onPress={() => handle('approve')}
          disabled={loading !== null}
        >
          {loading === 'approve' ? (
            <ActivityIndicator size={16} color="#fff" />
          ) : (
            <Text style={styles.btnText}>Approve</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.rejectBtn}
          onPress={() => handle('reject')}
          disabled={loading !== null}
        >
          {loading === 'reject' ? (
            <ActivityIndicator size={16} color="#fff" />
          ) : (
            <Text style={styles.btnText}>Reject</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  mac: { color: '#f1f5f9', fontSize: 15, fontWeight: '600', fontFamily: 'monospace' },
  meta: { color: '#64748b', fontSize: 13, marginBottom: 2 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  approveBtn: {
    flex: 1,
    backgroundColor: '#15803d',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  rejectBtn: {
    flex: 1,
    backgroundColor: '#b91c1c',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
