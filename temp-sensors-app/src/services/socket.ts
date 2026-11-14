import { io, Socket } from 'socket.io-client';
import * as SecureStore from 'expo-secure-store';
import { Sensor } from '../types';
import { getAccount } from './api';

const BASE_URL = 'https://temp.majdabed.com';

let socket: Socket | null = null;

export function connectSocket(token: string): Socket {
  // Reuse the existing instance (even while still connecting) so we never spawn
  // duplicate/orphaned sockets. disconnectSocket() clears it on logout.
  if (socket) return socket;

  // The server checks the access token in the handshake, on every reconnect.
  // A fixed token would be refused on the first reconnect after it expired
  // (an hour) -- routine on a phone that sleeps or changes network -- so read
  // the current one each time; api.ts keeps it refreshed in SecureStore.
  const s = io(BASE_URL, {
    auth: (cb) => {
      SecureStore.getItemAsync('jwt_token')
        .then((stored) => cb({ token: stored ?? token }))
        .catch(() => cb({ token }));
    },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionAttempts: Infinity,
  });

  // A refused handshake is not retried (s.active goes false). Any API call
  // renews an expired token through the 401 interceptor; then connect again.
  // The delay keeps a refusal for some other reason out of a tight loop.
  s.on('connect_error', async () => {
    if (s.active) return; // network trouble: already retrying
    try {
      await getAccount();
    } catch {
      return; // refresh failed too: the session is over
    }
    setTimeout(() => {
      if (socket === s && !s.connected) s.connect();
    }, 5000);
  });

  socket = s;
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

export function getSocket(): Socket | null {
  return socket;
}

// Typed event subscriptions used in DashboardScreen
export type SensorUpdateHandler = (sensor: Partial<Sensor> & { mac: string }) => void;
export type SensorOfflineHandler = (mac: string) => void;

// Hub & pairing events used in DevicesScreen / PairingScreen
export type HubStatusHandler = (data: { mac: string; online: boolean; ip?: string }) => void;
export type PairingRequestHandler = (request: import('../types').PairingRequest) => void;
export type PairingModeStatusHandler = (data: { hub_mac: string; enabled: boolean }) => void;
