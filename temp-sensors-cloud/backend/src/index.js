'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');

const { initMqtt }   = require('./mqtt');
const authRoutes     = require('./routes/auth');
const deviceRoutes   = require('./routes/devices');
const sensorRoutes   = require('./routes/sensors');
const readingRoutes  = require('./routes/readings');
const pairingRoutes  = require('./routes/pairing');

const app    = express();
const server = http.createServer(app);

// Socket.IO — the React dashboard connects here for live updates.
// CORS is handled by nginx in production; allow all origins here for simplicity.
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// ── Health check (unauthenticated) ────────────────────────────────────────────
app.get(['/health', '/api/health'], (_req, res) => res.json({ status: 'ok' }));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',                 authRoutes);
app.use('/api/devices',              deviceRoutes);
app.use('/api/sensors',              sensorRoutes);
// Readings router uses mergeParams to access :id from the parent path
app.use('/api/sensors/:id/readings', readingRoutes);
app.use('/api/pairing',              pairingRoutes);

// ── 404 fallback ──────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Socket.IO — room per hub MAC ──────────────────────────────────────────────
// Dashboard / app emits `join` with a hub MAC to receive live events:
//   sensorData, hubStatus, pairingRequest
const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;

io.on('connection', (socket) => {
  socket.on('join', (hubMac) => {
    if (typeof hubMac === 'string' && MAC_RE.test(hubMac)) {
      socket.join(`hub:${hubMac.toUpperCase()}`);
    }
  });
  socket.on('leave', (hubMac) => {
    if (typeof hubMac === 'string' && MAC_RE.test(hubMac)) {
      socket.leave(`hub:${hubMac.toUpperCase()}`);
    }
  });
});

// ── MQTT bridge ───────────────────────────────────────────────────────────────
initMqtt(io);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
