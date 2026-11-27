import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert, PermissionsAndroid, Platform } from 'react-native';
import type { Device as BLEDevice } from 'react-native-ble-plx';
import { Screen, Card, T, Row, Button, Field, Icon, Empty } from '../ui';
import {
  scanForHubs, connectToHub, readHubMac, scanWifiNetworks, provisionWifi, provisionCloud,
  subscribeStatus, disconnectHub, WiFiNetwork, ProvStatus,
} from '../services/ble';
import * as api from '../services/api';
import { useOrgData } from '../store/OrgData';
import type { ScreenProps } from '../navigation/types';
import { C, F, R, S } from '../theme';

// A plain step-by-step flow: find the hub, pick its WiFi, wait. Whoever sets a
// hub up should never see a MAC address, a broker or a log — the cloud
// registration and broker credentials happen behind the "Connect" button.
type Step = 'scan' | 'wifi' | 'password' | 'working' | 'done' | 'failed';

const PROGRESS = ['Joining your WiFi', 'Connecting to the cloud', 'Hub is online'];

function bars(rssi: number) { return rssi >= -50 ? 4 : rssi >= -60 ? 3 : rssi >= -70 ? 2 : 1; }

async function blePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (Number(Platform.Version) >= 31) {
    const r = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);
    return Object.values(r).every((x) => x === PermissionsAndroid.RESULTS.GRANTED);
  }
  return (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION)) === PermissionsAndroid.RESULTS.GRANTED;
}

/** Turn whatever went wrong into something the person holding the phone can act on. */
function friendlyError(err: any, ssid: string): string {
  const msg = String(err?.message ?? err?.response?.data?.error ?? '').toLowerCase();
  if (/pass|auth|4-way|handshake|wrong/.test(msg)) return `The hub couldn't join "${ssid}". Check the WiFi password and try again.`;
  if (/no ap|not found|ssid/.test(msg)) return `The hub couldn't find "${ssid}". Move it closer to the router and try again.`;
  if (/timed out/.test(msg)) return 'The hub took too long to come online. Check it has power and is in range of your WiFi, then try again.';
  if (err?.response || /network|request failed/.test(msg)) return "Couldn't reach the cloud. Check your phone's internet connection and try again.";
  if (/disconnect|bluetooth|ble|gatt/.test(msg)) return 'Lost the Bluetooth connection to the hub. Keep the phone close to it and try again.';
  return 'Something went wrong while setting up the hub. Try again.';
}

/** Add a hub over Bluetooth. (Same backend steps as the dashboard's Setup page.) */
export default function AddHubScreen({ navigation }: ScreenProps<'AddHub'>) {
  const { refresh } = useOrgData();
  const [step, setStep] = useState<Step>('scan');
  const [found, setFound] = useState<BLEDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [hubName, setHubName] = useState('');
  const [nets, setNets] = useState<WiFiNetwork[]>([]);
  const [netScan, setNetScan] = useState(false);
  const [ssid, setSsid] = useState('');
  const [typed, setTyped] = useState(false);
  const [pass, setPass] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const stopScan = useRef<(() => void) | null>(null);
  const hubRef = useRef<BLEDevice | null>(null);

  useEffect(() => () => { stopScan.current?.(); if (hubRef.current) disconnectHub(hubRef.current); }, []);

  async function scan() {
    if (!(await blePermissions())) {
      Alert.alert('Bluetooth needed', 'Allow Bluetooth and location so the app can find your hub.');
      return;
    }
    setFound([]); setScanning(true);
    stopScan.current = scanForHubs(
      (d) => setFound((p) => (p.some((x) => x.id === d.id) ? p : [...p, d])),
      () => { setScanning(false); Alert.alert("Couldn't search", 'Check that Bluetooth is turned on, then try again.'); },
    );
    setTimeout(() => { stopScan.current?.(); setScanning(false); }, 10000);
  }

  async function pick(d: BLEDevice) {
    stopScan.current?.(); setScanning(false);
    setConnecting(d.id);
    try {
      hubRef.current = await connectToHub(d);
      setHubName(d.name ?? 'your hub');
      setStep('wifi');
      loadNetworks();
    } catch {
      Alert.alert("Couldn't connect", 'Keep the phone close to the hub and try again.');
    } finally { setConnecting(null); }
  }

  async function loadNetworks() {
    if (!hubRef.current) return;
    setNetScan(true); setNets([]);
    try {
      const list = await scanWifiNetworks(hubRef.current);
      setNets([...list].filter((n) => n.ssid).sort((a, b) => b.rssi - a.rssi));
    } catch { /* the "not listed" option still works */ }
    finally { setNetScan(false); }
  }

  function chooseNetwork(n: WiFiNetwork) {
    setSsid(n.ssid); setTyped(false); setPass('');
    if (n.enc === 0 || n.auth === 'open') connect(n.ssid, '');
    else setStep('password');
  }

  async function connect(net: string, password: string) {
    const h = hubRef.current;
    if (!h) return;
    setStep('working'); setProgress(0); setError('');
    try {
      // The cloud gives every hub its own broker account; the hub never needs
      // the person to know any of it.
      const mac = await readHubMac(h);
      const { data: device } = await api.registerDevice(mac, null);
      const { data: cfg } = await api.getProvisionConfig();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { unsub(); reject(new Error('timed out')); }, 60000);
        const unsub = subscribeStatus(h, (st: ProvStatus) => {
          if (st.state === 'connecting') setProgress(1);
          if (st.state === 'connected') { clearTimeout(timeout); unsub(); resolve(); }
          if (st.state === 'failed') { clearTimeout(timeout); unsub(); reject(new Error(st.detail ?? 'failed')); }
        });
        provisionWifi(h, net, password)
          .then(() => provisionCloud(h, cfg.mqttHost, cfg.mqttPort || 8883, device.mqtt_user, device.api_key))
          .catch((e) => { clearTimeout(timeout); unsub(); reject(e); });
      });
      setProgress(2);
      await disconnectHub(h); hubRef.current = null;
      setStep('done');
      refresh();
    } catch (err) {
      setError(friendlyError(err, net));
      setStep('failed');
    }
  }

  if (Platform.OS === 'web') {
    return <Screen><Empty icon="bluetooth" title="Use the phone app" body="Setting up a hub uses Bluetooth, which only the phone app can do." /></Screen>;
  }

  // ── Find the hub ───────────────────────────────────────────────────────────
  if (step === 'scan') {
    return (
      <Screen>
        <Hero icon="bluetooth" title="Find your hub" body="Plug the hub in and keep your phone close to it." />
        <Button label={scanning ? 'Searching…' : 'Search for hubs'} icon="search" variant="primary" full busy={scanning} onPress={scan} />
        <View style={{ marginTop: S.lg }}>
          {found.map((d) => (
            <Pressable key={d.id} disabled={!!connecting} onPress={() => pick(d)}>
              {({ pressed }) => (
                <Card style={[styles.row, pressed && { opacity: 0.7 }]}>
                  <View style={styles.rowIcon}><Icon name="hard-drive" color={C.ice} /></View>
                  <T v="h3" style={{ flex: 1 }}>{d.name ?? 'Hub'}</T>
                  {connecting === d.id ? <ActivityIndicator color={C.ice} /> : <Icon name="chevron-right" color={C.ink3} />}
                </Card>
              )}
            </Pressable>
          ))}
          {!scanning && found.length === 0 && (
            <T v="small" style={{ textAlign: 'center' }}>No hub showing up? Hold its button for 3 seconds to reset it, then search again.</T>
          )}
          {connecting && <T v="small" style={{ textAlign: 'center', marginTop: S.md }}>Connecting to the hub…</T>}
        </View>
      </Screen>
    );
  }

  // ── Pick the WiFi ──────────────────────────────────────────────────────────
  if (step === 'wifi') {
    return (
      <Screen>
        <Hero icon="wifi" title="Choose your WiFi" body={`${hubName} will use this network to reach the cloud.`} />
        {netScan && <Row style={{ justifyContent: 'center', marginBottom: S.md }}><ActivityIndicator color={C.ice} /><T v="small">Looking for networks…</T></Row>}
        {nets.map((n) => (
          <Pressable key={n.ssid} onPress={() => chooseNetwork(n)}>
            {({ pressed }) => (
              <Card style={[styles.row, pressed && { opacity: 0.7 }]}>
                <View style={styles.bars}>{[1, 2, 3, 4].map((i) => <View key={i} style={[styles.bar, { height: 3 + i * 3 }, bars(n.rssi) >= i && { backgroundColor: C.ice }]} />)}</View>
                <T v="h3" style={{ flex: 1 }} numberOfLines={1}>{n.ssid}</T>
                {n.enc !== 0 && n.auth !== 'open' && <Icon name="lock" size={14} color={C.ink3} />}
              </Card>
            )}
          </Pressable>
        ))}
        <Row style={{ justifyContent: 'center', marginTop: S.sm }}>
          {!netScan && <Button label="Search again" icon="refresh-cw" variant="ghost" small onPress={loadNetworks} />}
          <Button label="My network isn't listed" variant="ghost" small onPress={() => { setSsid(''); setTyped(true); setPass(''); setStep('password'); }} />
        </Row>
      </Screen>
    );
  }

  // ── Password ───────────────────────────────────────────────────────────────
  if (step === 'password') {
    return (
      <Screen>
        <Hero icon="lock" title={typed ? 'Enter your WiFi' : 'WiFi password'} body={typed ? 'Type the network name and password exactly as they are.' : `For "${ssid}"`} />
        <Card>
          {typed && <Field label="Network name" value={ssid} onChangeText={setSsid} autoCapitalize="none" autoCorrect={false} placeholder="Home WiFi" />}
          <Field label="Password" value={pass} onChangeText={setPass} secureTextEntry={!showPass} autoCapitalize="none" autoCorrect={false}
            autoFocus={!typed} placeholder="WiFi password" returnKeyType="go" onSubmitEditing={() => ssid.trim() && connect(ssid.trim(), pass)} />
          <Button label={showPass ? 'Hide password' : 'Show password'} icon={showPass ? 'eye-off' : 'eye'} variant="ghost" small onPress={() => setShowPass((v) => !v)} style={{ marginTop: -6 }} />
          <Button label="Connect hub" variant="primary" full disabled={!ssid.trim()} onPress={() => connect(ssid.trim(), pass)} style={{ marginTop: S.md }} />
        </Card>
        <Button label="Choose another network" variant="ghost" small style={{ alignSelf: 'center', marginTop: S.md }} onPress={() => setStep('wifi')} />
      </Screen>
    );
  }

  // ── Working / failed / done ────────────────────────────────────────────────
  if (step === 'working') {
    return (
      <Screen>
        <Hero icon="loader" title="Setting up your hub" body="This takes up to a minute. Keep the phone near the hub." />
        <Card>
          {PROGRESS.map((label, i) => (
            <Row key={label} gap={S.md} style={{ paddingVertical: 10 }}>
              {i < progress ? <View style={[styles.dot, { backgroundColor: C.ok }]}><Icon name="check" size={13} color={C.onDark} /></View>
                : i === progress ? <ActivityIndicator color={C.ice} style={{ width: 24 }} />
                : <View style={styles.dot} />}
              <T v="body" style={i > progress ? { color: C.ink3 } : undefined}>{label}</T>
            </Row>
          ))}
        </Card>
      </Screen>
    );
  }

  if (step === 'failed') {
    return (
      <Screen>
        <Hero icon="alert-triangle" tone="amber" title="That didn't work" body={error} />
        <Button label="Try again" variant="primary" full onPress={() => setStep(hubRef.current ? 'wifi' : 'scan')} />
        <Button label="Start over" variant="ghost" style={{ alignSelf: 'center', marginTop: S.sm }} onPress={() => {
          if (hubRef.current) disconnectHub(hubRef.current);
          hubRef.current = null; setFound([]); setStep('scan');
        }} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Hero icon="check" tone="ok" title="Your hub is online" body="Next, pair your sensors to it from the Hubs tab." />
      <Button label="Done" variant="primary" full onPress={() => navigation.goBack()} />
    </Screen>
  );
}

function Hero({ icon, title, body, tone = 'ice' }: { icon: React.ComponentProps<typeof Icon>['name']; title: string; body: string; tone?: 'ice' | 'ok' | 'amber' }) {
  const bg = tone === 'ok' ? C.ok : tone === 'amber' ? C.amber : C.ice;
  return (
    <View style={styles.hero}>
      <View style={[styles.heroIcon, { backgroundColor: bg }]}><Icon name={icon} size={28} color={C.onDark} /></View>
      <T v="title" style={{ textAlign: 'center', marginTop: S.md }}>{title}</T>
      <Text style={styles.heroBody}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: S.xl, paddingHorizontal: S.md },
  heroIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  heroBody: { fontFamily: F.regular, fontSize: 15, color: C.ink2, textAlign: 'center', marginTop: 6, lineHeight: 21 },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, marginBottom: S.sm, paddingVertical: 14 },
  rowIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.iceSoft, alignItems: 'center', justifyContent: 'center' },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, width: 22 },
  bar: { width: 3, borderRadius: 1, backgroundColor: C.lineStrong },
  dot: { width: 24, height: 24, borderRadius: 12, backgroundColor: C.inset, alignItems: 'center', justifyContent: 'center' },
});
