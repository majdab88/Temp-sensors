import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Screen, Card, T, Row, Button, Field, KV, Notice, Section, Chip, Loading, ErrorState, PageHeader } from '../ui';
import { confirm, useToast } from '../ui/feedback';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import { formatDateTimeShort } from '../utils/time';
import type { User } from '../types';
import { C, S } from '../theme';

/** Profile, memberships, password. (Account.jsx) `tab` adds the large header for the admin tab bar. */
export default function AccountScreen({ tab }: { tab?: boolean }) {
  const toast = useToast();
  const { refreshUser, isSuperadmin, logout } = useAuth();
  const [profile, setProfile] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ username: '', email: '' });
  const [saving, setSaving] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [pwSaving, setPwSaving] = useState(false);

  const load = () => api.getAccount()
    .then((r) => { setProfile(r.data); setForm({ username: r.data.username || '', email: r.data.email || '' }); setError(null); })
    .catch(() => setError('Failed to load profile'));
  useEffect(() => { load(); }, []);

  async function saveProfile() {
    setSaving(true);
    try {
      const res = await api.updateAccount({ username: form.username || undefined, email: form.email || undefined });
      setProfile((p) => (p ? { ...p, ...res.data } : p));
      setEditing(false);
      refreshUser().catch(() => {});
      toast.success('Profile updated');
    } catch (err) { toast.error(api.errText(err, 'Failed to update profile')); }
    finally { setSaving(false); }
  }

  async function changePassword() {
    setPwErr(null);
    if (pw.next !== pw.confirm) return setPwErr('New passwords do not match');
    if (pw.next.length < 10) return setPwErr('New password must be at least 10 characters');
    setPwSaving(true);
    try {
      await api.changePassword(pw.current, pw.next);
      setPw({ current: '', next: '', confirm: '' });
      toast.success('Password changed');
    } catch (err) { setPwErr(api.errText(err, 'Failed to change password')); }
    finally { setPwSaving(false); }
  }

  const header = tab ? <PageHeader title="Account" /> : null;
  if (error) return <View style={{ flex: 1, backgroundColor: C.page }}>{header}<Screen><ErrorState message={error} onRetry={load} /></Screen></View>;
  if (!profile) return <View style={{ flex: 1, backgroundColor: C.page }}>{header}<Screen><Loading /></Screen></View>;

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      {header}
      <Screen>
        <Section title="Profile" style={{ marginTop: 0 }} right={!editing ? <Button label="Edit" icon="edit-2" variant="ghost" small onPress={() => setEditing(true)} /> : undefined}>
          <Card>
            {editing ? (
              <>
                <Field label="Username" value={form.username} onChangeText={(v) => setForm({ ...form, username: v })} autoCapitalize="none" />
                <Field label="Email" value={form.email} onChangeText={(v) => setForm({ ...form, email: v })} autoCapitalize="none" keyboardType="email-address" />
                <Row>
                  <Button label="Save" variant="primary" small busy={saving} onPress={saveProfile} />
                  <Button label="Cancel" small onPress={() => { setEditing(false); setForm({ username: profile.username || '', email: profile.email || '' }); }} />
                </Row>
              </>
            ) : (
              <>
                <KV k="Username" v={profile.username} />
                <KV k="Email" v={profile.email || '—'} />
                <KV k="Role" v={profile.role} />
                <KV k="Joined" v={formatDateTimeShort(profile.created_at)} mono />
              </>
            )}
          </Card>
        </Section>

        {!!profile.memberships?.length && (
          <Section title="Memberships">
            <Card>
              {profile.memberships.map((m, i) => (
                <Row key={m.org_id} style={[{ paddingVertical: 8 }, i > 0 && { borderTopWidth: 1, borderTopColor: C.line }]}>
                  <View style={{ flex: 1 }}>
                    <T v="h3">{m.org_name}</T>
                    <T v="caption">{m.org_role}</T>
                  </View>
                  <Chip tone="ice" label={m.org_role === 'owner' ? 'All permissions' : m.permission_level} />
                </Row>
              ))}
            </Card>
          </Section>
        )}

        <Section title="Change password">
          <Card>
            {pwErr && <Notice tone="alarm">{pwErr}</Notice>}
            <Field label="Current password" value={pw.current} onChangeText={(v) => setPw({ ...pw, current: v })} secureTextEntry autoCapitalize="none" />
            <Field label="New password" value={pw.next} onChangeText={(v) => setPw({ ...pw, next: v })} secureTextEntry autoCapitalize="none" hint="At least 10 characters. Other sessions are signed out; this phone stays signed in." />
            <Field label="Confirm new password" value={pw.confirm} onChangeText={(v) => setPw({ ...pw, confirm: v })} secureTextEntry autoCapitalize="none" />
            <Button label="Change password" variant="primary" small busy={pwSaving} disabled={!pw.current || !pw.next} onPress={changePassword} />
          </Card>
        </Section>

        {tab && isSuperadmin && (
          <Section>
            <Button label="Sign out" icon="log-out" variant="danger" onPress={async () => {
              if (await confirm({ title: 'Sign out?', message: 'This phone stops getting push alerts for this account.', confirmLabel: 'Sign out', danger: true })) logout();
            }} />
          </Section>
        )}
      </Screen>
    </View>
  );
}
