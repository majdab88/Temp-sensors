import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Screen, Card, T, Row, Button, Picker, Loading, ErrorState, Empty, PageHeader } from '../ui';
import * as api from '../services/api';
import { formatDateTime } from '../utils/time';
import type { AuditEntry } from '../types';
import { C, S } from '../theme';

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Login',
  'user.create': 'User created',
  'user.update': 'User updated',
  'user.delete': 'User deleted',
  'member.add': 'Member added',
  'member.remove': 'Member removed',
  'member.permissions_update': 'Permissions updated',
  'device.register': 'Device registered',
  'device.rename': 'Device renamed',
  'device.assign': 'Device assigned',
  'sensor.rename': 'Sensor renamed',
  'sensor.delete': 'Sensor deleted',
  'pairing.approve': 'Pairing approved',
  'pairing.reject': 'Pairing rejected',
  'org.rename': 'Org renamed',
  'account.update': 'Profile updated',
  'account.password_change': 'Password changed',
};
// Colour marks the kind of change, never red: red is for temperature alarms.
const ACTION_TONE: Record<string, string> = {
  'member.add': C.ok, 'device.register': C.ok, 'pairing.approve': C.ok,
  'member.remove': C.amber, 'sensor.delete': C.amber, 'pairing.reject': C.amber, 'user.delete': C.amber,
  'member.permissions_update': C.ice, 'auth.login': C.ice,
};
const PAGE = 30;

/** Every user action in the org (superadmin: everywhere). (AuditLog.jsx) */
export default function AuditLogScreen({ tab }: { tab?: boolean }) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [action, setAction] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setRows(null);
    api.getAuditLog({ limit: PAGE, offset: page * PAGE, ...(action ? { action } : {}) })
      .then((r) => { setRows(r.data.rows); setTotal(r.data.total); setError(null); })
      .catch(() => setError('Failed to load audit log'));
  }, [page, action]);
  useEffect(load, [load]);

  const pages = Math.ceil(total / PAGE);
  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      {tab && <PageHeader title="Audit log" subtitle={`${total} ${total === 1 ? 'entry' : 'entries'}`} />}
      <Screen>
        <Picker label="Action" value={action} onChange={(v) => { setAction(v); setPage(0); }}
          options={[{ value: '', label: 'All actions' }, ...Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label }))]} />
        {!tab && <T v="caption" style={{ marginBottom: S.sm }}>{total} {total === 1 ? 'entry' : 'entries'}</T>}
        {error ? <ErrorState message={error} onRetry={load} />
          : rows == null ? <Loading />
          : rows.length === 0 ? <Card><Empty icon="list" title="No entries" body={action ? 'Nothing for this filter.' : 'No activity recorded yet.'} /></Card>
          : (
            <Card style={{ paddingVertical: S.xs }}>
              {rows.map((e, i) => (
                <View key={e.id} style={[{ paddingVertical: 10, flexDirection: 'row', gap: S.md }, i > 0 && { borderTopWidth: 1, borderTopColor: C.line }]}>
                  <View style={{ width: 3, borderRadius: 2, backgroundColor: ACTION_TONE[e.action] ?? C.lineStrong }} />
                  <View style={{ flex: 1 }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <T v="h3">{ACTION_LABELS[e.action] || e.action}</T>
                      <T v="caption">{e.username || '—'}</T>
                    </Row>
                    <T v="monoSmall">{formatDateTime(e.created_at)}{e.target_type ? ` · ${e.target_type} #${e.target_id}` : ''}</T>
                    {e.details ? <T v="caption" numberOfLines={3} selectable>{JSON.stringify(e.details)}</T> : null}
                  </View>
                </View>
              ))}
            </Card>
          )}
        {pages > 1 && (
          <Row style={{ justifyContent: 'center', marginTop: S.md }}>
            <Button label="Previous" small disabled={page === 0} onPress={() => setPage(page - 1)} />
            <T v="small">Page {page + 1} of {pages}</T>
            <Button label="Next" small disabled={page >= pages - 1} onPress={() => setPage(page + 1)} />
          </Row>
        )}
      </Screen>
    </View>
  );
}
