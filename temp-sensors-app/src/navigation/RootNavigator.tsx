import React from 'react';
import { View, ActivityIndicator, Pressable, Text, StyleSheet } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets, SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { OrgDataProvider, useOrgData } from '../store/OrgData';
import type { RootStackParamList } from './types';
import { C, F, S } from '../theme';

import LoginScreen from '../screens/LoginScreen';
import OverviewScreen from '../screens/OverviewScreen';
import AlertsScreen from '../screens/AlertsScreen';
import ReportsScreen from '../screens/ReportsScreen';
import HubsScreen from '../screens/HubsScreen';
import MoreScreen from '../screens/MoreScreen';
import SensorDetailScreen from '../screens/SensorDetailScreen';
import ExcursionDetailScreen from '../screens/ExcursionDetailScreen';
import AddHubScreen from '../screens/AddHubScreen';
import AccountScreen from '../screens/AccountScreen';
import OrganizationsScreen from '../screens/OrganizationsScreen';
import AuditLogScreen from '../screens/AuditLogScreen';
import UsersScreen from '../screens/UsersScreen';
import FirmwareScreen from '../screens/FirmwareScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

const navTheme = { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: C.page, primary: C.ice, card: C.surface, text: C.ink, border: C.line } };

const tabOptions = (icon: React.ComponentProps<typeof Feather>['name'], badge?: number) => ({
  tabBarIcon: ({ color }: { color: string }) => <Feather name={icon} size={21} color={color} />,
  ...(badge ? { tabBarBadge: badge, tabBarBadgeStyle: { backgroundColor: C.alarm, fontFamily: F.medium, fontSize: 10 } } : {}),
});

const tabScreenOptions = {
  headerShown: false,
  tabBarActiveTintColor: C.ink,
  tabBarInactiveTintColor: C.ink3,
  tabBarStyle: { backgroundColor: C.surface, borderTopColor: C.line, height: 62, paddingTop: 6, paddingBottom: 8 },
  tabBarLabelStyle: { fontFamily: F.medium, fontSize: 11 },
};

/** Org users, and a superadmin while "viewing as" an org. */
function OrgTabs() {
  const { canEdit } = useAuth();
  const { alerts } = useOrgData();
  const alarmCount = Object.keys(alerts).length;
  return (
    <Tab.Navigator screenOptions={tabScreenOptions}>
      <Tab.Screen name="Overview" component={OverviewScreen} options={tabOptions('grid', alarmCount)} />
      <Tab.Screen name="Alerts" component={AlertsScreen} options={tabOptions('bell')} />
      <Tab.Screen name="Reports" component={ReportsScreen} options={tabOptions('file-text')} />
      {canEdit && <Tab.Screen name="Hubs" component={HubsScreen} options={tabOptions('hard-drive')} />}
      <Tab.Screen name="More" component={MoreScreen} options={tabOptions('menu')} />
    </Tab.Navigator>
  );
}

/** Superadmin with no org selected: the admin screens only. */
function AdminTabs() {
  return (
    <Tab.Navigator screenOptions={tabScreenOptions}>
      <Tab.Screen name="Orgs" options={tabOptions('home')}>{() => <OrganizationsScreen tab />}</Tab.Screen>
      <Tab.Screen name="Users" options={tabOptions('users')}>{() => <UsersScreen tab />}</Tab.Screen>
      <Tab.Screen name="Firmware" options={tabOptions('cpu')}>{() => <FirmwareScreen tab />}</Tab.Screen>
      <Tab.Screen name="Audit" options={tabOptions('list')}>{() => <AuditLogScreen tab />}</Tab.Screen>
      <Tab.Screen name="Account" options={tabOptions('user')}>{() => <AccountScreen tab />}</Tab.Screen>
    </Tab.Navigator>
  );
}

/** The "Viewing: <org> ✕" strip, so a superadmin always knows whose data this is. */
function ViewingBar() {
  const { impersonatedOrg, stopImpersonating } = useAuth();
  const insets = useSafeAreaInsets();
  if (!impersonatedOrg) return null;
  return (
    <View style={[styles.viewing, { paddingTop: insets.top + 4 }]}>
      <Feather name="eye" size={13} color={C.onDark} />
      <Text style={styles.viewingText} numberOfLines={1}>Viewing {impersonatedOrg.name}</Text>
      <Pressable onPress={stopImpersonating} hitSlop={10} style={styles.viewingBtn}>
        <Text style={styles.viewingText}>Stop</Text>
        <Feather name="x" size={13} color={C.onDark} />
      </Pressable>
    </View>
  );
}

/** The viewing bar already sits under the status bar; screens below it must not pad for it again. */
function NoTopInset({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return <SafeAreaInsetsContext.Provider value={{ ...insets, top: 0 }}>{children}</SafeAreaInsetsContext.Provider>;
}

const stackOptions = {
  headerStyle: { backgroundColor: C.page },
  headerShadowVisible: false,
  headerTintColor: C.ice,
  headerTitleStyle: { fontFamily: F.bold, fontSize: 17, color: C.ink },
  headerBackTitleVisible: false,
  contentStyle: { backgroundColor: C.page },
};

export default function RootNavigator() {
  const { user, loading, hasOrgContext, impersonatedOrg } = useAuth();

  if (loading) {
    return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: C.page }}><ActivityIndicator size="large" color={C.ice} /></View>;
  }

  const stack = (
    <Stack.Navigator screenOptions={stackOptions}>
      {!user ? (
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
      ) : !hasOrgContext ? (
        <Stack.Screen name="AdminTabs" component={AdminTabs} options={{ headerShown: false }} />
      ) : (
        <>
          <Stack.Screen name="Tabs" component={OrgTabs} options={{ headerShown: false }} />
          <Stack.Screen name="SensorDetail" component={SensorDetailScreen} options={{ title: 'Sensor' }} />
          <Stack.Screen name="ExcursionDetail" component={ExcursionDetailScreen} options={{ title: 'Excursion' }} />
          <Stack.Screen name="AddHub" component={AddHubScreen} options={{ title: 'Add a hub' }} />
          <Stack.Screen name="Account" options={{ title: 'Account' }}>{() => <AccountScreen />}</Stack.Screen>
          <Stack.Screen name="Organizations" options={{ title: 'Organization' }}>{() => <OrganizationsScreen />}</Stack.Screen>
          <Stack.Screen name="AuditLog" options={{ title: 'Audit log' }}>{() => <AuditLogScreen />}</Stack.Screen>
          <Stack.Screen name="Users" options={{ title: 'Users' }}>{() => <UsersScreen />}</Stack.Screen>
          <Stack.Screen name="Firmware" options={{ title: 'Firmware' }}>{() => <FirmwareScreen />}</Stack.Screen>
        </>
      )}
    </Stack.Navigator>
  );

  return (
    <NavigationContainer theme={navTheme}>
      {user && hasOrgContext ? (
        // Keyed by org so "View as" another org starts from a clean store.
        <OrgDataProvider key={impersonatedOrg?.id ?? 'own'}>
          <ViewingBar />
          {impersonatedOrg ? <NoTopInset>{stack}</NoTopInset> : stack}
        </OrgDataProvider>
      ) : stack}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  viewing: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.iceDeep, paddingHorizontal: S.lg, paddingBottom: 6 },
  viewingText: { color: C.onDark, fontFamily: F.medium, fontSize: 12, flexShrink: 1 },
  viewingBtn: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 4 },
});
