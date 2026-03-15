import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '../context/AuthContext';
import LoginScreen from '../screens/LoginScreen';
import MainTabs from './MainTabs';
import SensorDetailScreen from '../screens/SensorDetailScreen';
import AddDeviceScreen from '../screens/AddDeviceScreen';
import AuditLogScreen from '../screens/AuditLogScreen';
import OrganizationsScreen from '../screens/OrganizationsScreen';
import UsersScreen from '../screens/UsersScreen';

export type RootStackParamList = {
  Login: undefined;
  Main: undefined;
  SensorDetail: { sensorId: number; sensorName: string };
  AddDevice: undefined;
  AuditLog: undefined;
  Organizations: undefined;
  Users: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function AppNavigator() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' }}>
        <ActivityIndicator size="large" color="#38bdf8" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: '#0f172a' },
          headerTintColor: '#f1f5f9',
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: '#0f172a' },
        }}
      >
        {user ? (
          <>
            <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
            <Stack.Screen name="SensorDetail" component={SensorDetailScreen} options={{ title: 'Sensor Detail' }} />
            <Stack.Screen name="AddDevice" component={AddDeviceScreen} options={{ title: 'Add Hub Device' }} />
            <Stack.Screen name="AuditLog" component={AuditLogScreen} options={{ title: 'Audit Log' }} />
            <Stack.Screen name="Organizations" component={OrganizationsScreen} options={{ title: 'Organizations' }} />
            <Stack.Screen name="Users" component={UsersScreen} options={{ title: 'Users' }} />
          </>
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
