import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Screen, Card, T, Row, Button, Chip, Loading, ErrorState, Empty, Notice, Divider, PageHeader, IconButton } from '../ui';
import { confirm, useToast } from '../ui/feedback';
import * as api from '../services/api';
import { useSocketEvent, useHubRooms } from '../services/socket';
import { sensorOutcome, sensorRolledBack, sensorSendingStale, hubOutcome, Outcome } from '../utils/otaOutcome';
import { formatDateTimeShort } from '../utils/time';
import type { FirmwareImage, Device, Sensor, OtaState } from '../types';
import { C, S } from '../theme';

// Longer than the hub's worst-case app-level rollback (3 boots × 5 min), so a
// hub genuinely mid-recovery is not mistaken for an abandoned update.
const OTA_STALE_MS = 20 * 60 * 1000;

/**
 * Firmware registry — superadmin only. Stage signed images on hubs and
 * sensors and watch them install. Uploading an image stays on the web
 * dashboard (agreed out of scope for the phone). (Firmware.jsx)
 */
export default function FirmwareScreen({ tab }: { tab?: boolean }) {
  const toast = useToast();
  const [images, setImages] = useState<FirmwareImage[] | null>(null);
  const [hubs, setHubs] = useState<Device[]>([]);
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [ota, setOta] = useState<Record<string, OtaState>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [fw, dev, sen] = await Promise.all([api.getFirmware(), api.getDevices(), api.getSensors().catch(() => ({ data: [] as Sensor[] }))]);
      setImages(fw.data); setHubs(dev.data); setSensors(sen.data);
      // Seed from stored state so a reload mid-update still shows progress.
      const seeded: Record<string, OtaState> = {};
      for (const d of dev.data) if (d.ota_state) seeded[d.mac] = { state: d.ota_state, version: d.ota_version, pct: d.ota_pct, error: d.ota_error, updatedAt: d.ota_updated_at };
      setOta(seeded);
      setError(null);
    } catch { setError('Failed to load firmware registry'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Re-joined after every reconnect: the hub reboots mid-update and the final
  // "confirmed" arrives minutes later.
  useHubRooms(hubs.map((h) => h.mac));

  useSocketEvent<any>('otaStatus', (d) => {
    setOta((p) => ({ ...p, [d.hub_mac]: { state: d.state, version: d.version, pct: d.pct, error: d.error, updatedAt: new Date().toISOString() } }));
    if (d.state === 'confirmed') load();
  });
  useSocketEvent<any>('sensorOtaStatus', (d) => {
    setSensors((p) => p.map((x) => x.mac === d.sensor_mac
      ? { ...x, ota_state: d.state, ota_pct: d.pct, ota_error: d.error, ota_version: d.version ?? x.ota_version, ota_updated_at: new Date().toISOString() }
      : x));
    if (d.state === 'installed') load();
  });
  // The node reports its new version on its first wake after rebooting.
  useSocketEvent<any>('sensorData', (d) => {
    if (!d.fw) return;
    setSensors((p) => p.map((x) => x.mac === d.sensor_mac && x.fw_version !== d.fw ? { ...x, fw_version: d.fw, fw_reported_at: new Date().toISOString() } : x));
  });

  async function stageHub(img: FirmwareImage, hub: Device) {
    const from = hub.fw_version ? `from ${hub.fw_version} to ${img.version}` : `to ${img.version}`;
    if (!(await confirm({
      title: `Update ${hub.name || hub.mac}?`,
      message: `${from}. The hub downloads, verifies and reboots. If the new firmware can't reach the cloud, it rolls itself back.`,
      confirmLabel: 'Install',
    }))) return;
    try {
      await api.stageFirmware(img.id, { hub_mac: hub.mac });
      setNotice(`Staged ${img.version} on ${hub.name || hub.mac}`);
      setOta((p) => ({ ...p, [hub.mac]: { state: 'staged', version: img.version, pct: 0, error: null, updatedAt: new Date().toISOString() } }));
    } catch (err) { toast.error(api.errText(err, 'Failed to stage')); }
  }

  async function stageSensor(img: FirmwareImage, sen: Sensor) {
    const name = sen.name || sen.mac;
    if (!(await confirm({
      title: `Send ${img.version} to ${name}?`,
      message: "The hub holds it until someone presses the node's button — a sleeping sensor only listens for an offer on a button-press wake. If the new firmware can't deliver a reading, the sensor rolls itself back.",
      confirmLabel: 'Send',
    }))) return;
    try {
      const res = await api.stageFirmware(img.id, { sensor_mac: sen.mac });
      setNotice(res.data.needs_button ? `Staged ${img.version} — press the button on ${name} to install` : `Staged ${img.version} on ${name}`);
      load();
    } catch (err) { toast.error(api.errText(err, 'Failed to stage')); }
  }

  // Staging waits on a physical button press, so a change of mind must be
  // undoable without walking to the node.
  async function cancelStage(sen: Sensor) {
    try {
      await api.cancelSensorStage(sen.id);
      setSensors((p) => p.map((x) => x.mac === sen.mac ? { ...x, ota_state: null, ota_version: null, ota_pct: null, ota_error: null } : x));
    } catch (err) { toast.error(api.errText(err, 'Failed to cancel')); }
  }

  async function del(img: FirmwareImage) {
    if (!(await confirm({ title: `Delete firmware ${img.version}?`, message: 'Devices already running it are unaffected.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.deleteFirmware(img.id); load(); } catch { toast.error('Failed to delete'); }
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      {tab && <PageHeader title="Firmware" subtitle="Signed images and over-the-air updates" />}
      <Screen>
        <Notice tone="ice" icon="upload-cloud">Upload new images from the web dashboard (or publish.sh). Staging and progress work here.</Notice>
        {notice && <Notice tone="ok">{notice}</Notice>}
        {error ? <ErrorState message={error} onRetry={load} />
          : images == null ? <Loading />
          : images.length === 0 ? <Card><Empty icon="cpu" title="No firmware uploaded yet" /></Card>
          : images.map((img) => (
            <Card key={img.id} style={{ marginBottom: S.md }}>
              <Row>
                <T v="title" style={{ fontSize: 22 }}>{img.version}</T>
                <Chip tone="ice" label={img.device_kind} />
                <View style={{ flex: 1 }} />
                <IconButton name="trash-2" label="Delete image" color={C.alarmDeep} onPress={() => del(img)} />
              </Row>
              <T v="monoSmall">{(img.size / 1024).toFixed(0)} KiB · {img.sha256.slice(0, 16)}…</T>
              {img.notes ? <T v="small" style={{ marginTop: 4, color: C.ink }}>{img.notes}</T> : null}
              <T v="caption">Uploaded {formatDateTimeShort(img.created_at)}{img.created_by ? ` by ${img.created_by}` : ''}</T>
              <Divider />
              {img.device_kind === 'sensor' ? (
                <>
                  <T v="caption" style={{ marginBottom: S.sm }}>Staged now, installed when the node's button is pressed.</T>
                  {sensors.length === 0 && <T v="small">No sensors paired.</T>}
                  {sensors.map((sen) => <SensorRow key={sen.mac} img={img} sen={sen} onSend={() => stageSensor(img, sen)} onCancel={() => cancelStage(sen)} />)}
                </>
              ) : hubs.map((hub) => <HubRow key={hub.mac} img={img} hub={hub} ota={ota[hub.mac]} onInstall={() => stageHub(img, hub)} />)}
            </Card>
          ))}
      </Screen>
    </View>
  );
}

function OutcomeNote({ o }: { o: Outcome | null }) {
  if (!o) return null;
  return <T v="caption" style={{ color: o.tone === 'bad' ? C.amber : C.ink2, marginTop: 2 }}>{o.text}{o.next ? ` ${o.next}` : ''}</T>;
}

function SensorRow({ img, sen, onSend, onCancel }: { img: FirmwareImage; sen: Sensor; onSend: () => void; onCancel: () => void }) {
  // A transfer cut off by a hub restart never reports again.
  const stale = sensorSendingStale(sen);
  const busy = !!sen.ota_state && !stale && !['installed', 'failed', 'declined'].includes(sen.ota_state);
  // Staged for one particular image; other images' rows stay usable.
  const busyHere = busy && sen.ota_version === img.version;
  const transferring = sen.ota_state === 'sending' && !stale;
  // fw_version changes only once the node reboots and reports; trust the
  // install report in between, unless it has since come back on its old one.
  const installed = sen.fw_version === img.version ||
    (sen.ota_state === 'installed' && sen.ota_version === img.version && !sensorRolledBack(sen, img.version));
  const outcome = installed ? null : sensorOutcome(sen, img.version);
  return (
    <View style={{ paddingVertical: 6 }}>
      <Row>
        <T v="small" style={{ flex: 1, color: C.ink }} numberOfLines={1}>{sen.name || sen.mac} · {sen.fw_version ? `v${sen.fw_version}` : 'version unknown'}</T>
        {installed ? <Chip tone="ok" label="Installed" />
          : busyHere ? (
            <>
              <Chip tone="ice" label={sen.ota_state === 'staged' ? 'Staged · press button' : `${sen.ota_state}${sen.ota_pct != null ? ` ${sen.ota_pct}%` : ''}`} />
              {!transferring && <IconButton name="x" label="Cancel staged image" onPress={onCancel} />}
            </>
          ) : <Button label={outcome?.tone === 'bad' ? 'Retry' : 'Send'} variant="primary" small disabled={transferring} onPress={onSend} />}
      </Row>
      <OutcomeNote o={outcome} />
    </View>
  );
}

function HubRow({ img, hub, ota, onInstall }: { img: FirmwareImage; hub: Device; ota?: OtaState; onInstall: () => void }) {
  // The hub takes one update at a time. Only the card of the version being
  // installed shows progress; anything older than the rollback window is
  // treated as abandoned rather than in flight.
  const age = ota?.updatedAt ? Date.now() - new Date(ota.updatedAt).getTime() : 0;
  const stale = age > OTA_STALE_MS;
  const busy = !!ota && !['confirmed', 'failed', 'uptodate'].includes(ota.state) && !stale;
  const isTarget = busy && ota!.version === img.version;
  const outcome = hubOutcome(hub, ota, img.version, stale);
  return (
    <View style={{ paddingVertical: 6 }}>
      <Row>
        <T v="small" style={{ flex: 1, color: C.ink }} numberOfLines={1}>{hub.name || hub.mac} · {hub.fw_version ? `v${hub.fw_version}` : 'version unknown'}</T>
        {hub.fw_version === img.version ? <Chip tone="ok" label="Installed" />
          : isTarget ? <Chip tone="ice" label={`${ota!.state}${ota!.pct != null ? ` ${ota!.pct}%` : ''}`} />
          : <Button label={outcome ? 'Retry' : 'Install'} variant="primary" small disabled={busy} onPress={onInstall} />}
      </Row>
      {busy && !isTarget && <T v="caption">Busy installing {ota!.version}</T>}
      <OutcomeNote o={outcome} />
    </View>
  );
}
