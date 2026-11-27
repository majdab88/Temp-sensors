import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert, PermissionsAndroid, Platform } from 'react-native';
import type { Device as BLEDevice } from 'react-native-ble-plx';
import { Screen, Card, T, Row, Button, Field, Notice, Icon, Empty } from '../ui';
import {
  scanForHubs, connectToHub, readHubMac, scanWifiNetworks, provisionWifi, provisionCloud,
  subscribeStatus, disconnectHub, WiFiNetwork, ProvStatus,
} from '../services/ble';
import * as api from '../services/api';
import { useOrgData } from '../store/OrgData';
import { formatTime } from '../utils/time';
import type { ScreenProps } from '../navigation/types';
import { C, F, R, S } from '../theme';

const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;
type Phase = 'find' | 'register' | 'wifi' | 'sending' | 'done' | 'failed';
type Log = { ts: string; msg: string; type: 'ok' | 'err' | 'inf' };

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

/**
 * Add a hub over Bluetooth: find it, register it with the cloud (which issues
 * the hub's own broker account), then hand it WiFi + broker credentials and
 * follow its status until it reaches the cloud. (Provision.jsx)
 */
export default function AddHubScreen({ navigation }: ScreenProps<'AddHub'>) {
  const { refresh } = useOrgData();
  const [phase, setPhase] = useState<Phase>('find');
  const [found, setFound] = useState<BLEDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [hub, setHub] = useState<BLEDevice | null>(null);
  const [mac, setMac] = useState('');
  const [macAuto, setMacAuto] = useState(false);
  const [name, setName] = useState('');
  const [registering, setRegistering] = useState(false);
  const [creds, setCreds] = useState<{ user: string; pass: string } | null>(null);
  const [broker, setBroker] = useState<{ host: string; port: number } | null>(null);
  const [brokerErr, setBrokerErr] = useState(false);
  const [nets, setNets] = useState<WiFiNetwork[]>([]);
  const [netScan, setNetScan] = useState(false);
  const [ssid, setSsid] = useState<string | null>(null);
  const [openNet, setOpenNet] = useState(false);
  const [manual, setManual] = useState('');
  const [pass, setPass] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [stage, setStage] = useState('');
  const [logs, setLogs] = useState<Log[]>([]);
  const stopScan = useRef<(() => void) | null>(null);
  const hubRef = useRef<BLEDevice | null>(null);

  const log = (msg: string, type: Log['type'] = 'inf') => setLogs((p) => [...p.slice(-99), { ts: formatTime(new Date()), msg, type }]);

  useEffect(() => {
    api.getProvisionConfig()
      .then((r) => { if (r.data.mqttHost) setBroker({ host: r.data.mqttHost, port: r.data.mqttPort || 8883 }); else setBrokerErr(true); })
      .catch(() => setBrokerErr(true));
    return () => { stopScan.current?.(); if (hubRef.current) disconnectHub(hubRef.current); };
  }, []);

  async function scan() {
    if (!(await blePermissions())) {
      Alert.alert('Permission needed', 'Bluetooth and location permissions are needed to find hubs.');
      return;
    }
    setFound([]); setScanning(true);
    log('Scanning for TempHub devices…');
    stopScan.current = scanForHubs(
      (d) => setFound((p) => (p.some((x) => x.id === d.id) ? p : [...p, d])),
      (err) => { setScanning(false); log(`Scan failed: ${err.message}`, 'err'); },
    );
    setTimeout(() => { stopScan.current?.(); setScanning(false); }, 10000);
  }

  async function connect(d: BLEDevice) {
    stopScan.current?.(); setScanning(false);
    setConnecting(d.id);
    try {
      const c = await connectToHub(d);
      hubRef.current = c; setHub(c);
      setName(d.name || '');
      log(`Connected to ${d.name}`, 'ok');
      try {
        const m = await readHubMac(c);
        if (MAC_RE.test(m)) { setMac(m.toUpperCase()); setMacAuto(true); log(`Hub MAC: ${m}`, 'ok'); }
      } catch { log('Hub did not report its MAC — enter it manually', 'inf'); }
      setPhase('register');
    } catch (err: any) {
      log(`Connection failed: ${err?.message ?? 'unknown'}`, 'err');
      Alert.alert('Connection failed', err?.message ?? 'Could not connect to the hub.');
    } finally { setConnecting(null); }
  }

  async function register() {
    const m = mac.trim().toUpperCase();
    if (!MAC_RE.test(m)) return;
    setRegistering(true);
    log('Registering hub with the cloud…');
    try {
      const { data } = await api.registerDevice(m, name.trim() || null);
      setCreds({ user: data.mqtt_user, pass: data.api_key });
      log('Hub registered — broker account issued', 'ok');
      setPhase('wifi');
      wifiScan();
    } catch (err) {
      log(`Registration failed: ${api.errText(err, 'unknown error')}`, 'err');
    } finally { setRegistering(false); }
  }

  async function wifiScan() {
    if (!hubRef.current) return;
    setNetScan(true); setNets([]);
    log('Requesting WiFi scan…');
    try {
      const list = await scanWifiNetworks(hubRef.current);
      setNets([...list].filter((n) => n.ssid).sort((a, b) => b.rssi - a.rssi));
      log(`Found ${list.length} network(s)`, 'ok');
    } catch (err: any) {
      log(`WiFi scan unavailable (${err?.message ?? 'error'}) — enter the network name`, 'inf');
    } finally { setNetScan(false); }
  }

  async function provision() {
    const net = ssid || manual.trim();
    if (!hubRef.current || !creds || !broker || !net) return;
    const h = hubRef.current;
    setPhase('sending'); setStage('Sending credentials…');
    log(`Sending credentials for "${net}"…`);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { unsub(); reject(new Error('Timed out waiting for the hub to connect.')); }, 60000);
        const unsub = subscribeStatus(h, (st: ProvStatus) => {
          log(`Hub: ${st.state}${st.detail ? ` — ${st.detail}` : ''}`);
          if (st.state === 'connecting') setStage('Hub is connecting to WiFi and the cloud…');
          if (st.state === 'connected') { clearTimeout(timeout); unsub(); resolve(); }
          if (st.state === 'failed') { clearTimeout(timeout); unsub(); reject(new Error(st.detail ?? 'Provisioning failed.')); }
        });
        provisionWifi(h, net, openNet && ssid ? '' : pass)
          .then(() => { log('WiFi credentials written', 'ok'); return provisionCloud(h, broker.host, broker.port, creds.user, creds.pass); })
          .then(() => { log('Broker credentials written — waiting for the hub…', 'ok'); setStage('Waiting for the hub…'); })
          .catch((e) => { clearTimeout(timeout); unsub(); reject(e); });
      });
      log('Provisioning complete', 'ok');
      await disconnectHub(h); hubRef.current = null;
      setPhase('done');
      refresh();
    } catch (err: any) {
      log(`Failed: ${err?.message ?? 'unknown'}`, 'err');
      setStage(err?.message ?? 'Provisioning failed.');
      setPhase('failed');
    }
  }

  function startOver() {
    if (hubRef.current) disconnectHub(hubRef.current);
    hubRef.current = null; setHub(null);
    setMac(''); setMacAuto(false); setName(''); setCreds(null);
    setNets([]); setSsid(null); setOpenNet(false); setManual(''); setPass(''); setLogs([]);
    setPhase('find');
  }

  if (Platform.OS === 'web') {
    return <Screen><Empty icon="bluetooth" title="Bluetooth needs the phone app" body="Hub setup talks to the hub over Bluetooth, which the web build can't do." /></Screen>;
  }

  if (phase === 'done') {
    return (
      <Screen>
        <Card style={{ alignItems: 'center', paddingVertical: S.xxl }}>
          <View style={styles.okIcon}><Icon name="check" size={28} color={C.onDark} /></View>
          <T v="title" style={{ marginTop: S.md }}>Hub ready</T>
          <T v="small" style={{ textAlign: 'center', marginTop: 4 }}>It's on WiFi and connected to the cloud. Pair sensors to it from the Hubs tab.</T>
          <Row style={{ marginTop: S.lg }}>
            <Button label="Set up another" onPress={startOver} />
            <Button label="Done" variant="primary" onPress={() => navigation.goBack()} />
          </Row>
        </Card>
      </Screen>
    );
  }

  const ssidChosen = !!(ssid || manual.trim());
  const step = (n: number, title: string, state: 'done' | 'active' | 'locked') => (
    <Row style={{ marginBottom: S.sm }}>
      <View style={[styles.num, state === 'done' && { backgroundColor: C.ok }, state === 'active' && { backgroundColor: C.ice }]}>
        {state === 'done' ? <Icon name="check" size={14} color={C.onDark} /> : <Text style={[styles.numText, state !== 'locked' && { color: C.onDark }]}>{n}</Text>}
      </View>
      <T v="h3" style={state === 'locked' ? { color: C.ink3 } : undefined}>{title}</T>
    </Row>
  );

  return (
    <Screen>
      {brokerErr && <Notice tone="alarm">Couldn't load the broker address from the server. Hub setup can't finish until it's configured.</Notice>}

      <Card style={styles.step}>
        {step(1, 'Find your hub', hub ? 'done' : 'active')}
        {hub ? (
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="mono">{hub.name}</T>
            <Button label="Disconnect" variant="ghost" small onPress={startOver} />
          </Row>
        ) : (
          <>
            <T v="small" style={{ marginBottom: S.md }}>Power the hub on. A new or reset hub advertises as TempHub-XXXXXX.</T>
            <Button label={scanning ? 'Scanning…' : 'Scan for hubs'} icon="bluetooth" variant="primary" busy={scanning} onPress={scan} />
            {found.map((d) => (
              <Pressable key={d.id} onPress={() => connect(d)} disabled={!!connecting} style={styles.listRow}>
                <Icon name="hard-drive" color={C.ice} />
                <View style={{ flex: 1 }}>
                  <T v="h3">{d.name ?? 'Unknown'}</T>
                  <T v="caption">{d.id}</T>
                </View>
                {connecting === d.id ? <ActivityIndicator color={C.ice} /> : <T v="monoSmall">{d.rssi} dBm</T>}
              </Pressable>
            ))}
          </>
        )}
      </Card>

      <Card style={styles.step}>
        {step(2, 'Register with the cloud', creds ? 'done' : hub ? 'active' : 'locked')}
        {phase === 'register' && (
          <>
            <Field label="Hub MAC address" value={mac} onChangeText={setMac} editable={!macAuto} autoCapitalize="characters"
              placeholder="AA:BB:CC:DD:EE:FF" hint={macAuto ? 'Read from the hub.' : 'Find it on the hub label or its serial log.'} />
            <Field label="Hub name (optional)" value={name} onChangeText={setName} placeholder="Coldroom hub" maxLength={64} />
            <Button label="Register" variant="primary" busy={registering} disabled={!MAC_RE.test(mac.trim())} onPress={register} />
          </>
        )}
        {creds && <T v="monoSmall">{mac} {name ? `· ${name}` : ''} · registered</T>}
      </Card>

      <Card style={styles.step}>
        {step(3, 'WiFi network', phase === 'wifi' && ssidChosen ? 'done' : creds ? 'active' : 'locked')}
        {creds && phase !== 'register' && (
          <>
            <Row style={{ justifyContent: 'space-between', marginBottom: S.sm }}>
              <T v="small">The hub scans for networks itself.</T>
              <Button label={netScan ? 'Scanning…' : 'Rescan'} icon="refresh-cw" variant="ghost" small busy={netScan} onPress={wifiScan} />
            </Row>
            {nets.map((n) => {
              const sel = ssid === n.ssid, b = bars(n.rssi), open = n.enc === 0 || n.auth === 'open';
              return (
                <Pressable key={n.ssid} onPress={() => { setSsid(n.ssid); setOpenNet(open); setManual(''); }} style={[styles.listRow, sel && styles.listSel]}>
                  <Icon name={sel ? 'check-circle' : 'circle'} color={sel ? C.ice : C.ink3} />
                  <T v="body" style={{ flex: 1 }} numberOfLines={1}>{n.ssid}</T>
                  <View style={styles.bars}>{[1, 2, 3, 4].map((i) => <View key={i} style={[styles.bar, { height: 3 + i * 3 }, b >= i && { backgroundColor: C.ice }]} />)}</View>
                  <Icon name={open ? 'unlock' : 'lock'} size={14} color={C.ink3} />
                </Pressable>
              );
            })}
            <Field style={{ marginTop: S.sm }} label={nets.length ? 'Or enter the name' : 'Network name (SSID)'} value={manual}
              onChangeText={(v) => { setManual(v); setSsid(null); }} autoCapitalize="none" autoCorrect={false} placeholder="Network name" />
            {((ssid && !openNet) || (manual && !ssid)) && (
              <View>
                <Field label="Password" value={pass} onChangeText={setPass} secureTextEntry={!showPass} autoCapitalize="none" autoCorrect={false} placeholder="WiFi password" />
                <Button label={showPass ? 'Hide password' : 'Show password'} icon={showPass ? 'eye-off' : 'eye'} variant="ghost" small onPress={() => setShowPass((v) => !v)} style={{ marginTop: -6 }} />
              </View>
            )}
          </>
        )}
      </Card>

      <Card style={styles.step}>
        {step(4, 'Send to the hub', creds && ssidChosen ? 'active' : 'locked')}
        {creds && ssidChosen && broker && (
          <>
            <View style={styles.broker}>
              <Text style={styles.brokerText}>Broker  {broker.host}:{broker.port}</Text>
              <Text style={styles.brokerText}>User    {creds.user}</Text>
              <Text style={styles.brokerText}>Pass    ••••••••</Text>
            </View>
            {phase === 'sending' ? (
              <Row style={{ marginTop: S.md }}><ActivityIndicator color={C.ice} /><T v="small">{stage}</T></Row>
            ) : (
              <>
                {phase === 'failed' && <View style={{ marginTop: S.md }}><Notice tone="alarm">{stage}</Notice></View>}
                <Button label={phase === 'failed' ? 'Try again' : 'Provision hub'} variant="primary" full style={{ marginTop: S.md }} onPress={provision} />
              </>
            )}
          </>
        )}
      </Card>

      {logs.length > 0 && (
        <View style={styles.log}>
          {logs.map((l, i) => (
            <Text key={i} style={[styles.logLine, l.type === 'err' && { color: '#FFB3BC' }, l.type === 'ok' && { color: '#9FE1CB' }]}>
              {l.ts}  {l.type === 'ok' ? '✓' : l.type === 'err' ? '✗' : '→'} {l.msg}
            </Text>
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  step: { marginBottom: S.md },
  num: { width: 24, height: 24, borderRadius: 12, backgroundColor: C.inset, alignItems: 'center', justifyContent: 'center' },
  numText: { fontFamily: F.monoMedium, fontSize: 12, color: C.ink3 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingVertical: 12, paddingHorizontal: S.sm, borderRadius: R.control, marginTop: S.xs },
  listSel: { backgroundColor: C.iceSoft },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  bar: { width: 3, borderRadius: 1, backgroundColor: C.lineStrong },
  broker: { backgroundColor: C.page, borderRadius: R.control, padding: S.md, gap: 2 },
  brokerText: { fontFamily: F.mono, fontSize: 12, color: C.ink2 },
  okIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: C.ok, alignItems: 'center', justifyContent: 'center' },
  log: { backgroundColor: C.ink, borderRadius: R.control, padding: S.md, marginTop: S.sm },
  logLine: { fontFamily: F.mono, fontSize: 11, color: '#C9D6DE', lineHeight: 17 },
});
