import { io } from 'socket.io-client'
import api from './api'

// Single socket instance, connects to the same origin (proxied by nginx / Vite dev server).
// Call socket.connect() after login and socket.disconnect() on logout.
//
// The server checks the access token in the handshake. It is passed as a
// function so every (re)connect sends the token current at that moment rather
// than the one the page loaded with.
const socket = io({
  autoConnect: false,
  transports: ['websocket', 'polling'],
  auth: (cb) => cb({ token: localStorage.getItem('accessToken') }),
})

// The client does not retry a handshake the server refused (socket.active goes
// false), and the usual reason is an access token that expired while the tab
// was open -- it is only checked when the socket reconnects. Any API call
// renews it through the 401 interceptor in api.js, or sends the user to /login
// if the refresh token has gone too; then connect again. The delay keeps a
// server refusing for some other reason from being retried in a tight loop.
socket.on('connect_error', async () => {
  if (socket.active) return // network trouble: the client is already retrying
  if (!localStorage.getItem('accessToken')) return // logged out
  try {
    await api.get('/account')
  } catch {
    return
  }
  setTimeout(() => { if (!socket.connected) socket.connect() }, 5000)
})

export default socket
