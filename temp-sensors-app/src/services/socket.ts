import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { getItem } from './storage';
import { getAccount, BASE_URL } from './api';

let socket: Socket | null = null;

export function connectSocket(token: string): Socket {
  // Reuse the existing instance (even while still connecting) so we never spawn
  // duplicate/orphaned sockets. disconnectSocket() clears it on logout.
  if (socket) return socket;

  // The server checks the access token in the handshake, on every reconnect.
  // A fixed token would be refused on the first reconnect after it expired
  // (an hour) -- routine on a phone that sleeps or changes network -- so read
  // the current one each time; api.ts keeps it refreshed in storage.
  const s = io(BASE_URL, {
    auth: (cb) => {
      getItem('jwt_token')
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

/**
 * Subscribe to a socket event for the life of the component. The handler is
 * read through a ref, so it always sees current state without resubscribing.
 */
export function useSocketEvent<T = any>(event: string, handler: (data: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = socket;
    if (!s) return;
    const fn = (d: T) => ref.current(d);
    s.on(event, fn);
    return () => { s.off(event, fn); };
  }, [event]);
}

/**
 * Join the rooms of these hubs, and re-join after every reconnect: the server
 * forgets a socket's rooms when it drops, and replays the cached hubStatus on
 * each join.
 */
export function useHubRooms(macs: string[]) {
  const key = macs.join(',');
  useEffect(() => {
    const s = socket;
    if (!s || !key) return;
    const list = key.split(',');
    const join = () => list.forEach((m) => s.emit('join', m));
    join();
    s.on('connect', join);
    return () => {
      s.off('connect', join);
      list.forEach((m) => s.emit('leave', m));
    };
  }, [key]);
}
