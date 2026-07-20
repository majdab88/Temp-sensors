import { io, Socket } from 'socket.io-client';
import { Sensor } from '../types';

const BASE_URL = 'https://majdtemp32.duckdns.org';

let socket: Socket | null = null;

export function connectSocket(token: string): Socket {
  // Reuse the existing instance (even while still connecting) so we never spawn
  // duplicate/orphaned sockets. disconnectSocket() clears it on logout.
  if (socket) return socket;

  socket = io(BASE_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionAttempts: Infinity,
  });

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
