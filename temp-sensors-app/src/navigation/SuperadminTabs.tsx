import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import OrganizationsScreen from '../screens/OrganizationsScreen';
import UsersScreen from '../screens/UsersScreen';
import AuditLogScreen from '../screens/AuditLogScreen';
import AccountScreen from '../screens/AccountScreen';

export type SuperadminTabParamList = {
  Orgs: undefined;
  Users: undefined;
  AuditLog: undefined;
  Account: undefined;
};

const Tab = createBottomTabNavigator<SuperadminTabParamList>();

export default function SuperadminTabs() {
  return (
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
        name="Orgs"
        component={OrganizationsScreen}
        options={{
          title: 'Organizations',
          tabBarIcon: ({ color, size }) => <Ionicons name="business-outline" color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="Users"
        component={UsersScreen}
        options={{
          title: 'Users',
          tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="AuditLog"
        component={AuditLogScreen}
        options={{
          title: 'Audit Log',
          tabBarIcon: ({ color, size }) => <Ionicons name="document-text-outline" color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="Account"
        component={AccountScreen}
        options={{
          title: 'Account',
          tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" color={color} size={size} />,
        }}
      />
    </Tab.Navigator>
  );
}
