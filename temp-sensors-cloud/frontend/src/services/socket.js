import { io } from 'socket.io-client'

// Single socket instance, connects to the same origin (proxied by nginx / Vite dev server).
// Call socket.connect() after login and socket.disconnect() on logout.
const socket = io({ autoConnect: false, transports: ['websocket', 'polling'] })

export default socket
