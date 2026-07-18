import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

// Show alerts as a banner (with sound) even when the app is in the foreground.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Request notification permission and return this device's Expo push token.
 * Returns null when push isn't available (simulator, denied permission, or no
 * EAS projectId configured) — callers treat that as "no push", not an error.
 */
export async function registerForPushNotifications(): Promise<{ token: string; platform: string } | null> {
  // Remote push only works on physical devices.
  if (!Device.isDevice) return null;

  // Android requires an explicit channel for the notification to show.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('alerts', {
      name: 'Temperature alerts',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
    });
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  let status = existing;
  if (existing !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') return null;

  const projectId =
    Constants?.expoConfig?.extra?.eas?.projectId ?? (Constants as any)?.easConfig?.projectId;
  if (!projectId) {
    console.warn('[push] no EAS projectId — cannot obtain a push token');
    return null;
  }

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  return { token, platform: Platform.OS };
}
