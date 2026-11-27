import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Screen, PageHeader, Card, T, Row, Chip, Button, Empty, Loading, ErrorState, Sheet, Field, KV, Notice, Divider } from '../ui';
import { confirm, useToast } from '../ui/feedback';
import { useOrgData } from '../store/OrgData';
import { useSocketEvent } from '../services/socket';
import * as api from '../services/api';
import { formatDateTimeShort } from '../utils/time';
import { pairingName } from '../utils/sensor';
import type { Device, PairingRequest } from '../types';
import type { RootStackParamList } from '../navigation/types';
import { C, F, R, S } from '../theme';

const PAIRING_DURATION = 120; // seconds — the hub's own pairing window

/** Hubs, their live status, rename/remove, and pairing new sensors. (Devices.jsx) */
export default function HubsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const toast = useToast();
  const { devices, sensors, hubStatus, loading, error, refresh, patchDevice, removeDevice } = useOrgData();
  const [refreshing, setRefreshing] = useState(false);
  const [renaming, setRenaming] = useState<Device | null>(null);
  const [draft, setDraft] = useState('');

  // Pairing mode: one hub at a time.
  const [pairingHub, setPairingHub] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [requests, setRequests] = useState<PairingRequest[]>([]);
  const [enabling, setEnabling] = useState<string | null>(null);
  const [processing, setProcessing] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPairing = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setPairingHub(null); setCountdown(0); setRequests([]);
  }, []);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  useEffect(() => {
    if (pairingHub && countdown === 0) stopPairing();
  }, [countdown, pairingHub, stopPairing]);

  // The hub's own report is authoritative: when it leaves pairing mode, so do we.
  useSocketEvent<{ hub_mac: string; pairing_mode: boolean }>('pairingModeStatus', (d) => {
    if (!d.pairing_mode && d.hub_mac === pairingHub) stopPairing();
  });
  useSocketEvent<PairingRequest>('pairingRequest', (d) => {
    if (d.hub_mac !== pairingHub) return;
    setRequests((p) => (p.some((r) => r.id === d.id) ? p : [...p, d]));
  });

  async function enablePairing(mac: string) {
    setEnabling(mac);
    try {
      await api.enablePairing(mac, true);
      setPairingHub(mac); setRequests([]); setCountdown(PAIRING_DURATION);
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000);
    } catch { toast.error('Failed to enable pairing mode. Is the hub online?'); }
    finally { setEnabling(null); }
  }

  async function disablePairing() {
    if (pairingHub) { try { await api.enablePairing(pairingHub, false); } catch { /* best-effort */ } }
    stopPairing();
  }

  async function approve(req: PairingRequest) {
    // Approving a sensor that is active on a different hub moves it — and its
    // reading history — here (routes/pairing.js consolidates the rows). Say so.
    const mac = (req.sensor_mac || '').toUpperCase();
    const existing = sensors.find((s) => (s.mac || '').toUpperCase() === mac && (s.hub_mac || '').toUpperCase() !== (pairingHub || '').toUpperCase());
    if (existing) {
      const ok = await confirm({
        title: 'Sensor already paired',
        message: `${existing.name || 'This sensor'} is currently paired to "${existing.hub_name || existing.hub_mac}". Approving will move it — and its reading history — to this hub. Continue?`,
        confirmLabel: 'Move sensor', danger: true,
      });
      if (!ok) return;
    }
    setProcessing(req.id);
    try {
      await api.approvePairing(req.id);
      setRequests((p) => p.filter((r) => r.id !== req.id));
      await disablePairing();
      toast.success('Sensor paired');
      refresh();
    } catch { toast.error('Failed to approve pairing request'); }
    finally { setProcessing(null); }
  }

  async function reject(id: number) {
    setProcessing(id);
    try { await api.rejectPairing(id); setRequests((p) => p.filter((r) => r.id !== id)); }
    catch { toast.error('Failed to reject pairing request'); }
    finally { setProcessing(null); }
  }

  async function rename() {
    if (!renaming || !draft.trim()) return;
    try {
      const res = await api.renameDevice(renaming.id, draft.trim());
      patchDevice(renaming.id, { name: res.data.name });
      setRenaming(null);
      toast.success('Hub renamed');
    } catch { toast.error('Failed to rename hub'); }
  }

  async function remove(d: Device) {
    const ok = await confirm({
      title: `Remove "${d.name || 'this hub'}"?`,
      message: 'This deletes the hub and all its sensors and readings. This cannot be undone.',
      confirmLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteDevice(d.id);
      if (pairingHub === d.mac) stopPairing();
      removeDevice(d.id);
      toast.success('Hub removed');
    } catch { toast.error('Failed to remove hub'); }
  }

  const header = <PageHeader title="Hubs" subtitle="Gateways and sensor pairing"
    right={Platform.OS !== 'web' ? <Button label="Add hub" icon="plus" variant="primary" small onPress={() => nav.navigate('AddHub')} /> : undefined} />;

  if (loading) return <View style={{ flex: 1, backgroundColor: C.page }}>{header}<Loading label="Loading hubs…" /></View>;
  if (error) return <View style={{ flex: 1, backgroundColor: C.page }}>{header}<ErrorState message={error} onRetry={refresh} /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      {header}
      <Screen refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refresh(); setRefreshing(false); }} style={{ paddingTop: S.sm }}>
        {Platform.OS === 'web' && <Notice tone="ice">Adding a hub uses Bluetooth, which needs the phone app.</Notice>}
        {devices.length === 0 ? (
          <Card><Empty icon="hard-drive" title="No hubs yet" body="Add a hub over Bluetooth to start pairing sensors."
            action={Platform.OS !== 'web' ? <Button label="Add hub" icon="bluetooth" variant="primary" onPress={() => nav.navigate('AddHub')} /> : undefined} /></Card>
        ) : devices.map((d) => {
          const live = hubStatus[d.mac];
          const online = live?.online ?? d.online;
          const known = live?.online != null || d.online;
          const isPairing = pairingHub === d.mac;
          const count = sensors.filter((s) => s.hub_mac === d.mac).length;
          return (
            <Card key={d.id} tone={isPairing ? 'ice' : undefined} style={{ marginBottom: S.md }}>
              <Row style={{ alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <T v="h2">{d.name || 'Unnamed Hub'}</T>
                  <T v="monoSmall" selectable>{d.mac}</T>
                </View>
                <Chip tone={online ? 'ok' : known ? 'muted' : 'plain'} icon={online ? 'wifi' : 'wifi-off'} label={online ? 'Online' : known ? 'Offline' : 'Unknown'} />
              </Row>
              <View style={{ marginTop: S.sm }}>
                <KV k="Sensors" v={String(count)} mono />
                <KV k="Registered" v={formatDateTimeShort(d.registered_at)} mono />
                {live?.ip ? <KV k="IP" v={live.ip} mono /> : null}
                {(live?.fw || d.fw_version) ? <KV k="Firmware" v={`v${live?.fw || d.fw_version}`} mono /> : null}
                {/* Measured on this hardware: images come up VALID, so the
                    bootloader never arms its own rollback; the firmware's
                    app-level scheme covers it, which is why VALID reads as
                    protected rather than as a warning. */}
                {live?.img_state ? (
                  <KV k="Boot image" v={`${live.img_state} — ${live.img_state === 'PENDING_VERIFY' ? 'bootloader rollback armed' : 'app-level rollback active'}`} />
                ) : null}
              </View>

              {isPairing ? (
                <View style={styles.pairing}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Row gap={8}>
                      <View style={styles.pulse} />
                      <T v="h3">Pairing mode</T>
                      <Text style={styles.count}>{Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}</Text>
                    </Row>
                    <Button label="Cancel" variant="ghost" small onPress={disablePairing} />
                  </Row>
                  <T v="small" style={{ marginTop: 4 }}>Power on or factory-reset the sensor now (hold its button 3 s). It broadcasts a pairing request.</T>
                  <Divider />
                  {requests.length === 0 ? (
                    <T v="small" style={{ fontStyle: 'italic' }}>Waiting for sensor pairing requests…</T>
                  ) : requests.map((req) => (
                    <View key={req.id} style={styles.req}>
                      <View style={{ flex: 1 }}>
                        <T v="h3">{pairingName(req.sensor_mac)}</T>
                        <T v="monoSmall">{req.sensor_mac}</T>
                      </View>
                      <Button label="Reject" variant="danger" small disabled={processing === req.id} onPress={() => reject(req.id)} />
                      <Button label="Approve" variant="primary" small busy={processing === req.id} onPress={() => approve(req)} />
                    </View>
                  ))}
                </View>
              ) : (
                <Row style={{ marginTop: S.md, flexWrap: 'wrap' }}>
                  <Button label="Add sensor" icon="plus" variant="primary" small
                    disabled={!online || !!enabling || (!!pairingHub && !isPairing)} busy={enabling === d.mac}
                    onPress={() => enablePairing(d.mac)} />
                  <Button label="Rename" icon="edit-2" small onPress={() => { setRenaming(d); setDraft(d.name || ''); }} />
                  <Button label="Remove" variant="danger" small onPress={() => remove(d)} />
                </Row>
              )}
              {!online && !isPairing && <T v="caption" style={{ marginTop: 6 }}>The hub must be online to add sensors.</T>}
            </Card>
          );
        })}
      </Screen>
      <Sheet visible={!!renaming} onClose={() => setRenaming(null)} title="Rename hub" subtitle={renaming?.mac}
        footer={<><Button label="Cancel" small onPress={() => setRenaming(null)} /><Button label="Save" variant="primary" small onPress={rename} /></>}>
        <Field label="Name" value={draft} onChangeText={setDraft} autoFocus maxLength={64} onSubmitEditing={rename} returnKeyType="done" />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  pairing: { marginTop: S.md, backgroundColor: C.iceSoft, borderRadius: R.control, padding: S.md },
  pulse: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.ice },
  count: { fontFamily: F.monoMedium, fontSize: 14, color: C.iceDeep },
  req: { flexDirection: 'row', alignItems: 'center', gap: S.sm, backgroundColor: C.surface, borderRadius: R.control, padding: S.md, marginBottom: S.sm },
});
