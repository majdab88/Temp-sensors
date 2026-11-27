import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Screen, PageHeader, Card, T, Icon, IconName, Button, Section } from '../ui';
import { confirm } from '../ui/feedback';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import { C, S } from '../theme';

type Item = { icon: IconName; label: string; sub: string; to: keyof RootStackParamList; show: boolean };

export default function MoreScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user, isSuperadmin, isOrgAdmin, impersonatedOrg, stopImpersonating, logout } = useAuth();

  const items: Item[] = [
    { icon: 'user', label: 'Account', sub: 'Profile, memberships, password', to: 'Account', show: true },
    { icon: 'home', label: isSuperadmin ? 'Organizations' : 'My organization', sub: 'Members, permissions and hubs', to: 'Organizations', show: isOrgAdmin },
    { icon: 'list', label: 'Audit log', sub: 'Who did what, and when', to: 'AuditLog', show: isOrgAdmin },
    { icon: 'users', label: 'Users', sub: 'System owners', to: 'Users', show: isSuperadmin },
    { icon: 'cpu', label: 'Firmware', sub: 'Over-the-air updates', to: 'Firmware', show: isSuperadmin },
  ];

  async function signOut() {
    if (await confirm({ title: 'Sign out?', message: 'This phone stops getting push alerts for this account until you sign in again.', confirmLabel: 'Sign out', danger: true })) logout();
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      <PageHeader title="More" subtitle={`${user?.email || user?.username} · ${user?.role}`} />
      <Screen style={{ paddingTop: S.sm }}>
        {impersonatedOrg && (
          <Card tone="ice" style={{ marginBottom: S.md }}>
            <T v="small">You're viewing</T>
            <T v="h2">{impersonatedOrg.name}</T>
            <Button label="Stop viewing" icon="x" small style={{ marginTop: S.md }} onPress={stopImpersonating} />
          </Card>
        )}
        <Card style={{ paddingVertical: S.xs }}>
          {items.filter((i) => i.show).map((i, idx) => (
            <Pressable key={i.to} onPress={() => nav.navigate(i.to as any)} style={({ pressed }) => [styles.row, idx > 0 && styles.sep, pressed && { opacity: 0.6 }]}>
              <View style={styles.icon}><Icon name={i.icon} color={C.ice} /></View>
              <View style={{ flex: 1 }}>
                <T v="h3">{i.label}</T>
                <T v="caption">{i.sub}</T>
              </View>
              <Icon name="chevron-right" color={C.ink3} />
            </Pressable>
          ))}
        </Card>
        <Section>
          <Button label="Sign out" icon="log-out" variant="danger" onPress={signOut} />
        </Section>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingVertical: 12 },
  sep: { borderTopWidth: 1, borderTopColor: C.line },
  icon: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.iceSoft, alignItems: 'center', justifyContent: 'center' },
});
