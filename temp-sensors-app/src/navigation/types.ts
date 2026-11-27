import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type RootStackParamList = {
  Login: undefined;
  Tabs: undefined;
  AdminTabs: undefined;
  SensorDetail: { sensorId: number };
  ExcursionDetail: { id: number };
  AddHub: undefined;
  Account: undefined;
  Organizations: undefined;
  AuditLog: undefined;
  Users: undefined;
  Firmware: undefined;
};

export type ScreenProps<K extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, K>;
