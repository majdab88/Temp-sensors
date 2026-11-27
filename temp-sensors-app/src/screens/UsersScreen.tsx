import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Screen, Card, T, Row, Button, Field, Chip, Segmented, Loading, ErrorState, Empty, Notice, Sheet, PageHeader } from '../ui';
import { confirm, useToast } from '../ui/feedback';
import * as api from '../services/api';
import { formatDateTimeShort } from '../utils/time';
import type { User } from '../types';
import { C, S } from '../theme';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** System owners — superadmin only. (Users.jsx + EditUserModal.jsx) */
export default function UsersScreen({ tab }: { tab?: boolean }) {
  const toast = useToast();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState({ email: '', password: '', orgName: '' });
  const [editing, setEditing] = useState<User | null>(null);
  const [edit, setEdit] = useState({ email: '', username: '', role: 'owner', password: '' });
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.getUsers().then((r) => { setUsers(r.data); setError(null); }).catch(() => setError('Failed to load users'));
  }, []);
  useEffect(load, [load]);

  async function create() {
    setFormErr(null);
    if (!EMAIL_RE.test(newForm.email.trim())) return setFormErr('Enter a valid email');
    if (newForm.password.length < 10) return setFormErr('Password must be at least 10 characters');
    setBusy(true);
    try {
      await api.createOwner({ email: newForm.email.trim(), password: newForm.password, orgName: newForm.orgName.trim() || undefined });
      setNewForm({ email: '', password: '', orgName: '' }); setCreating(false);
      toast.success('Owner created');
      load();
    } catch (err) { setFormErr(api.errText(err, 'Failed to create user')); }
    finally { setBusy(false); }
  }

  function openEdit(u: User) {
    setFormErr(null);
    setEdit({ email: u.email || '', username: u.username || '', role: u.role === 'member' ? 'member' : 'owner', password: '' });
    setEditing(u);
  }

  async function save() {
    if (!editing) return;
    setFormErr(null);
    const email = edit.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return setFormErr('Enter a valid email');
    if (edit.username.trim().length < 2) return setFormErr('Username must be at least 2 characters');
    if (edit.password && edit.password.length < 10) return setFormErr('New password must be at least 10 characters');
    setBusy(true);
    try {
      await api.updateUser(editing.id, { email, username: edit.username.trim(), role: edit.role, ...(edit.password ? { password: edit.password } : {}) });
      setEditing(null);
      toast.success('User saved');
      load();
    } catch (err) { setFormErr(api.errText(err, 'Failed to save')); }
    finally { setBusy(false); }
  }

  async function remove(u: User) {
    const who = u.email || u.username;
    if (!(await confirm({ title: 'Delete user?', message: `"${who}" will be deleted and their devices left unassigned.`, confirmLabel: 'Delete', danger: true }))) return;
    try { await api.deleteUser(u.id); setUsers((p) => p?.filter((x) => x.id !== u.id) ?? p); toast.success('User deleted'); }
    catch { toast.error('Failed to delete user'); }
  }

  const newButton = <Button label="New owner" icon="user-plus" variant="primary" small onPress={() => { setFormErr(null); setCreating(true); }} />;
  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      {tab && <PageHeader title="Users" subtitle="System owners" right={newButton} />}
      <Screen>
        {!tab && <View style={{ marginBottom: S.md }}>{newButton}</View>}
        {error ? <ErrorState message={error} onRetry={load} />
          : users == null ? <Loading />
          : users.length === 0 ? <Card><Empty icon="users" title="No users yet" body="Create the first system owner." /></Card>
          : users.map((u) => (
            <Card key={u.id} style={{ marginBottom: S.sm }}>
              <Row style={{ alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <T v="h3">{u.email || u.username}</T>
                  {u.email ? <T v="caption">{u.username}</T> : null}
                  <T v="monoSmall" style={{ marginTop: 2 }}>Joined {formatDateTimeShort(u.created_at)}</T>
                  {!!u.organizations?.length && <T v="small">Orgs: {u.organizations.map((o) => o.org_name).join(', ')}</T>}
                </View>
                <Chip tone={u.role === 'superadmin' ? 'ice' : 'muted'} label={u.role} />
              </Row>
              {u.role !== 'superadmin' && (
                <Row style={{ marginTop: S.md }}>
                  <Button label="Edit" icon="edit-2" small onPress={() => openEdit(u)} />
                  <Button label="Delete" variant="danger" small onPress={() => remove(u)} />
                </Row>
              )}
            </Card>
          ))}
      </Screen>

      <Sheet visible={creating} onClose={() => setCreating(false)} title="New owner" subtitle="Creates their organization too"
        footer={<><Button label="Cancel" small onPress={() => setCreating(false)} /><Button label="Create owner" variant="primary" small busy={busy} onPress={create} /></>}>
        {formErr && <Notice tone="alarm">{formErr}</Notice>}
        <Field label="Email" value={newForm.email} onChangeText={(v) => setNewForm({ ...newForm, email: v })} autoCapitalize="none" keyboardType="email-address" placeholder="john@example.com" />
        <Field label="Password" value={newForm.password} onChangeText={(v) => setNewForm({ ...newForm, password: v })} secureTextEntry autoCapitalize="none" hint="At least 10 characters" />
        <Field label="Organization name (optional)" value={newForm.orgName} onChangeText={(v) => setNewForm({ ...newForm, orgName: v })} placeholder="John's coldstore" />
      </Sheet>

      <Sheet visible={!!editing} onClose={() => setEditing(null)} title="Edit user" subtitle={editing?.email || editing?.username}
        footer={<><Button label="Cancel" small onPress={() => setEditing(null)} /><Button label="Save" variant="primary" small busy={busy} onPress={save} /></>}>
        {formErr && <Notice tone="alarm">{formErr}</Notice>}
        <Field label="Email" value={edit.email} onChangeText={(v) => setEdit({ ...edit, email: v })} autoCapitalize="none" keyboardType="email-address" />
        <Field label="Username" value={edit.username} onChangeText={(v) => setEdit({ ...edit, username: v })} autoCapitalize="none" maxLength={64} />
        <T v="label" style={{ marginBottom: 6 }}>Role</T>
        <Segmented value={edit.role} onChange={(v) => setEdit({ ...edit, role: v })} options={[{ value: 'owner', label: 'Owner' }, { value: 'member', label: 'Member' }]} />
        <Field style={{ marginTop: S.md }} label="New password (optional)" value={edit.password} onChangeText={(v) => setEdit({ ...edit, password: v })} secureTextEntry autoCapitalize="none"
          placeholder="Leave blank to keep the current one" hint="Sets a new password. The existing one can't be shown — it's stored hashed." />
      </Sheet>
    </View>
  );
}
