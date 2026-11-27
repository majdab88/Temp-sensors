import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable } from 'react-native';
import { Screen, Card, T, Row, Button, Field, Chip, Segmented, Loading, ErrorState, Empty, Notice, Divider, Icon, Sheet, PageHeader } from '../ui';
import { confirm, useToast } from '../ui/feedback';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import { formatDateTimeShort } from '../utils/time';
import type { Organization, OrgMember, OrgDevice } from '../types';
import { C, S } from '../theme';

type Level = 'viewer' | 'editor' | 'admin';
const LEVELS: { value: Level; label: string }[] = [
  { value: 'viewer', label: 'Viewer' }, { value: 'editor', label: 'Editor' }, { value: 'admin', label: 'Admin' },
];
const LEVEL_HINT: Record<Level, string> = { viewer: 'Read-only access', editor: 'Manage hubs, sensors and alerts', admin: 'Full org control' };

/** Organizations: members, permissions, hubs; superadmin "View as". (Organizations.jsx) */
export default function OrganizationsScreen({ tab }: { tab?: boolean }) {
  const { isSuperadmin, impersonateOrg } = useAuth();
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(() => {
    api.getOrganizations().then((r) => { setOrgs(r.data); setError(null); }).catch(() => setError('Failed to load organizations'));
  }, []);
  useEffect(load, [load]);

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      {tab && <PageHeader title="Organizations" subtitle="Every system — open one to manage it or view as it" />}
      <Screen>
        {error ? <ErrorState message={error} onRetry={load} />
          : orgs == null ? <Loading />
          : orgs.length === 0 ? <Card><Empty icon="home" title="No organizations" body={isSuperadmin ? 'Create an owner user to create an organization.' : "You aren't part of an organization yet."} /></Card>
          : orgs.map((o) => (
            <Card key={o.id} style={{ marginBottom: S.md }}>
              <Pressable onPress={() => setOpen(open === o.id ? null : o.id)}>
                <Row style={{ alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <T v="h2">{o.name}</T>
                    <T v="small">Owner: {o.owner_email || o.owner_username}</T>
                    <T v="monoSmall" style={{ marginTop: 2 }}>
                      {o.device_count} hub{Number(o.device_count) !== 1 ? 's' : ''} · {o.member_count} member{Number(o.member_count) !== 1 ? 's' : ''} · since {formatDateTimeShort(o.created_at).slice(0, 10)}
                    </T>
                  </View>
                  <Icon name={open === o.id ? 'chevron-up' : 'chevron-down'} color={C.ink3} />
                </Row>
              </Pressable>
              {isSuperadmin && <Button label="View as this org" icon="eye" variant="primary" small style={{ marginTop: S.md }} onPress={() => impersonateOrg(o.id, o.name)} />}
              {open === o.id && <OrgDetail org={o} onChanged={load} />}
            </Card>
          ))}
      </Screen>
    </View>
  );
}

function OrgDetail({ org, onChanged }: { org: Organization; onChanged: () => void }) {
  const toast = useToast();
  const { isOrgAdmin } = useAuth();
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [devices, setDevices] = useState<OrgDevice[] | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const [invite, setInvite] = useState(false);
  const [form, setForm] = useState<{ email: string; password: string; level: Level }>({ email: '', password: '', level: 'viewer' });
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [rename, setRename] = useState<OrgDevice | null>(null);
  const [draft, setDraft] = useState('');

  const loadMembers = () => api.getOrgMembers(org.id).then((r) => setMembers(r.data)).catch(() => setMembers([]));
  useEffect(() => {
    loadMembers();
    api.getOrgDevices(org.id).then((r) => setDevices(r.data)).catch(() => setDevices([]));
  }, [org.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function setLevel(m: OrgMember, level: Level) {
    if (level === m.permission_level) return;
    setSaving(m.id);
    try {
      await api.setMemberPermission(org.id, m.id, level);
      setMembers((p) => p?.map((x) => (x.id === m.id ? { ...x, permission_level: level } : x)) ?? p);
      toast.success('Permission updated');
    } catch { toast.error('Failed to update permission level'); }
    finally { setSaving(null); }
  }

  async function remove(m: OrgMember) {
    const who = m.email || m.username;
    if (!(await confirm({ title: 'Remove member?', message: `"${who}" will lose access to this organization.`, confirmLabel: 'Remove', danger: true }))) return;
    try {
      await api.removeMember(org.id, m.id);
      setMembers((p) => p?.filter((x) => x.id !== m.id) ?? p);
      toast.success('Member removed');
      onChanged();
    } catch { toast.error('Failed to remove member'); }
  }

  async function add() {
    setInviteErr(null); setAdding(true);
    try {
      await api.addMember(org.id, { email: form.email.trim(), password: form.password || undefined, permission_level: form.level });
      setForm({ email: '', password: '', level: 'viewer' }); setInvite(false);
      await loadMembers();
      toast.success('Member added');
      onChanged();
    } catch (err) { setInviteErr(api.errText(err, 'Failed to add member')); }
    finally { setAdding(false); }
  }

  async function saveName() {
    if (!rename || !draft.trim()) return;
    try {
      const res = await api.renameDevice(rename.id, draft.trim());
      setDevices((p) => p?.map((d) => (d.id === rename.id ? { ...d, name: res.data.name } : d)) ?? p);
      setRename(null);
    } catch { toast.error('Failed to rename hub'); }
  }

  return (
    <View>
      <Divider />
      <Row style={{ justifyContent: 'space-between' }}>
        <T v="label">Members</T>
        {isOrgAdmin && <Button label={invite ? 'Cancel' : 'Invite'} icon={invite ? 'x' : 'user-plus'} variant="ghost" small onPress={() => setInvite(!invite)} />}
      </Row>
      {invite && (
        <View style={{ backgroundColor: C.page, borderRadius: 12, padding: S.md, marginTop: S.sm }}>
          {inviteErr && <Notice tone="alarm">{inviteErr}</Notice>}
          <Field label="Email" value={form.email} onChangeText={(v) => setForm({ ...form, email: v })} autoCapitalize="none" keyboardType="email-address" placeholder="member@example.com" />
          <Field label="Password (new users only)" value={form.password} onChangeText={(v) => setForm({ ...form, password: v })} secureTextEntry autoCapitalize="none"
            hint="Existing users are added directly; no password needed." />
          <T v="label" style={{ marginBottom: 6 }}>Permission level</T>
          <Segmented value={form.level} onChange={(v) => setForm({ ...form, level: v })} options={LEVELS} />
          <T v="caption" style={{ marginTop: 4 }}>{LEVEL_HINT[form.level]}</T>
          <Button label="Add member" variant="primary" small busy={adding} disabled={!form.email.trim()} style={{ marginTop: S.md }} onPress={add} />
        </View>
      )}
      {members == null ? <Loading /> : members.length === 0 ? <T v="small">No members yet</T> : members.map((m) => (
        <View key={m.id} style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <Row>
            <T v="h3" style={{ flex: 1 }} numberOfLines={1}>{m.email || m.username}</T>
            <Chip tone={m.org_role === 'owner' ? 'ice' : 'muted'} label={m.org_role} />
          </Row>
          {m.org_role !== 'owner' && (isOrgAdmin ? (
            <Row style={{ marginTop: S.sm }}>
              <Segmented style={{ flex: 1, opacity: saving === m.id ? 0.5 : 1 }} value={m.permission_level} onChange={(v) => setLevel(m, v)} options={LEVELS} />
              <Button label="Remove" variant="danger" small onPress={() => remove(m)} />
            </Row>
          ) : <T v="caption">{m.permission_level}</T>)}
        </View>
      ))}

      <T v="label" style={{ marginTop: S.lg, marginBottom: S.sm }}>Hubs and sensors</T>
      {devices == null ? <Loading /> : devices.length === 0 ? <T v="small">No hubs registered</T> : devices.map((d) => (
        <View key={d.id} style={{ marginBottom: S.md }}>
          <Row>
            <View style={{ flex: 1 }}>
              <T v="h3">{d.name || 'Unnamed Hub'}</T>
              <T v="monoSmall">{d.mac} · {formatDateTimeShort(d.registered_at)}</T>
            </View>
            <Button label="Rename" variant="ghost" small onPress={() => { setRename(d); setDraft(d.name || ''); }} />
          </Row>
          {d.sensors?.length ? d.sensors.map((s) => (
            <Row key={s.id} style={{ paddingLeft: S.lg, paddingVertical: 4 }}>
              <T v="small" style={{ flex: 1, color: C.ink }} numberOfLines={1}>{s.name || s.mac}</T>
              <Chip tone={s.active ? 'ok' : 'muted'} label={s.active ? 'active' : 'inactive'} />
            </Row>
          )) : <T v="caption" style={{ paddingLeft: S.lg }}>No sensors paired</T>}
        </View>
      ))}
      <Sheet visible={!!rename} onClose={() => setRename(null)} title="Rename hub" subtitle={rename?.mac}
        footer={<><Button label="Cancel" small onPress={() => setRename(null)} /><Button label="Save" variant="primary" small onPress={saveName} /></>}>
        <Field label="Name" value={draft} onChangeText={setDraft} autoFocus maxLength={64} />
      </Sheet>
    </View>
  );
}
