import { io, Socket } from 'socket.io-client';
import { Sensor } from '../types';

const BASE_URL = 'https://majdtemp32.duckdns.org';

let socket: Socket | null = null;

export function connectSocket(token: string): Socket {
  if (socket?.connected) return socket;

  socket = io(BASE_URL, {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionAttempts: 10,
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
