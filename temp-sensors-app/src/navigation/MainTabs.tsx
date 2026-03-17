import React, { useEffect, useState } from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { View, Text, StyleSheet } from 'react-native';
import DashboardScreen from '../screens/DashboardScreen';
import DevicesScreen from '../screens/DevicesScreen';
import PairingScreen from '../screens/PairingScreen';
import AccountScreen from '../screens/AccountScreen';
import { getPairingRequests } from '../services/api';
import { TouchableOpacity } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { canEdit } from '../utils/permissions';

export type MainTabParamList = {
  Dashboard: undefined;
  Devices: undefined;
  Pairing: undefined;
  Account: undefined;
};

const Tab = createBottomTabNavigator<MainTabParamList>();

function PairingBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{count > 9 ? '9+' : count}</Text>
    </View>
  );
}

export default function MainTabs() {
  const { user, impersonatedOrg, stopImpersonating } = useAuth();
  const editor = canEdit(user);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (!editor) return;
    const fetchPending = async () => {
      try {
        const { data } = await getPairingRequests('pending');
        setPendingCount(data.length);
      } catch {
        // ignore
      }
    };
    fetchPending();
    const interval = setInterval(fetchPending, 30000);
    return () => clearInterval(interval);
  }, [editor]);

  return (
    <View style={{ flex: 1 }}>
      {impersonatedOrg && (
        <View style={styles.banner}>
          <Text style={styles.bannerText} numberOfLines={1}>
            Viewing as: <Text style={styles.bannerOrg}>{impersonatedOrg.name}</Text>
          </Text>
          <TouchableOpacity onPress={stopImpersonating} style={styles.bannerStop}>
            <Ionicons name="close-circle" size={18} color="#fbbf24" />
            <Text style={styles.bannerStopText}>Exit</Text>
          </TouchableOpacity>
        </View>
      )}
    <Tab.Navigator
      screenOptions={{
        tabBarStyle: { backgroundColor: '#1e293b', borderTopColor: '#334155' },
        tabBarActiveTintColor: '#38bdf8',
        tabBarInactiveTintColor: '#64748b',
        headerStyle: { backgroundColor: '#0f172a' },
        headerTintColor: '#f1f5f9',
        headerTitleStyle: { fontWeight: '600' },
      }}
    >
      <Tab.Screen
        name="Dashboard"
        component={DashboardScreen}
        options={{
          title: 'Sensors',
          tabBarIcon: ({ color, size }) => <Ionicons name="thermometer-outline" color={color} size={size} />,
        }}
      />
      {editor && (
        <Tab.Screen
          name="Devices"
          component={DevicesScreen}
          options={{
            title: 'Hubs',
            tabBarIcon: ({ color, size }) => <Ionicons name="hardware-chip-outline" color={color} size={size} />,
          }}
        />
      )}
      {editor && (
        <Tab.Screen
          name="Pairing"
          component={PairingScreen}
          options={{
            title: 'Pairing',
            tabBarIcon: ({ color, size }) => (
              <View>
                <Ionicons name="link-outline" color={color} size={size} />
                <PairingBadge count={pendingCount} />
              </View>
            ),
          }}
        />
      )}
      <Tab.Screen
        name="Account"
        component={AccountScreen}
        options={{
          title: 'Account',
          tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" color={color} size={size} />,
        }}
      />
    </Tab.Navigator>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#78350f',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#92400e',
  },
  bannerText: { color: '#fde68a', fontSize: 13, flex: 1 },
  bannerOrg: { fontWeight: '700' },
  bannerStop: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 10 },
  bannerStopText: { color: '#fbbf24', fontSize: 13, fontWeight: '700' },
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    backgroundColor: '#ef4444',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
});
