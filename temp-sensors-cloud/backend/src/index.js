'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const jwt      = require('jsonwebtoken');

const { query } = require('./db');
const { currentUser } = require('./middleware/auth');
const { initMqtt, getHubStatus } = require('./mqtt');
const { initAlerts } = require('./alerts');
const { startHealthMonitor } = require('./health');
const authRoutes      = require('./routes/auth');
const deviceRoutes    = require('./routes/devices');
const sensorRoutes    = require('./routes/sensors');
const readingRoutes   = require('./routes/readings');
const pairingRoutes   = require('./routes/pairing');
const provisionRoutes = require('./routes/provision');
const userRoutes      = require('./routes/users');
const orgRoutes       = require('./routes/organizations');
const accountRoutes   = require('./routes/account');
const auditRoutes     = require('./routes/audit-log');
const alertRoutes     = require('./routes/alerts');
const pushRoutes      = require('./routes/push');
const healthRoutes    = require('./routes/health');
const excursionRoutes = require('./routes/excursions');
const firmwareRoutes  = require('./routes/firmware');
const sensorCfgRoutes = require('./routes/sensor-config');

const app    = express();
const server = http.createServer(app);

// One proxy hop: nginx. Without this req.ip is nginx's address for every
// request, so the per-IP login limiter was one global limit -- ten bad attempts
// from anyone locked everyone out -- and every audit entry logged the same IP.
// nginx appends the real client address as the last X-Forwarded-For entry
// (after restoring it from Cloudflare on the proxied name), and with one
// trusted hop that last entry is what Express reads, so a client cannot spoof
// it by sending its own header.
app.set('trust proxy', 1);

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
app.use('/api/provision',            provisionRoutes);
app.use('/api/users',                userRoutes);
app.use('/api/organizations',        orgRoutes);
app.use('/api/account',              accountRoutes);
app.use('/api/audit-log',            auditRoutes);
app.use('/api/firmware',             firmwareRoutes);
app.use('/api/sensor-config',         sensorCfgRoutes);
app.use('/api/alerts',               alertRoutes);
app.use('/api/push',                 pushRoutes);
app.use('/api/health',               healthRoutes);
app.use('/api/excursions',           excursionRoutes);

// ── 404 fallback ──────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Socket.IO — room per hub MAC ──────────────────────────────────────────────
// Dashboard / app emits `join` with a hub MAC to receive live events:
//   sensorData, hubStatus, pairingRequest, alert
const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;

// Both checks matter. Without them anyone who knew a hub MAC -- and half of one
// is in the hub's BLE name -- received that site's readings, alarms, pairing
// requests and OTA status. Clients send the access token in the handshake
// (`auth: { token }`); it is checked once per connection, so an expired token
// is only refused when the socket reconnects, and the clients refresh it then.
// A revoked session (password changed, user deleted) is refused the same way.
io.use(async (socket, next) => {
  try {
    const decoded = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET);
    if (!(await currentUser(decoded))) return next(new Error('unauthorized'));
    socket.data.user = decoded;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

// Membership is read from the database, not the token, so a removed member
// cannot join again with a token issued before the removal.
async function mayJoin(user, mac) {
  if (user.role === 'superadmin') return true;
  const r = await query(
    `SELECT 1 FROM devices d JOIN memberships m ON m.org_id = d.org_id
      WHERE d.mac = $1 AND m.user_id = $2`,
    [mac, user.sub]
  );
  return r.rows.length > 0;
}

io.on('connection', (socket) => {
  socket.on('join', async (hubMac) => {
    if (typeof hubMac !== 'string' || !MAC_RE.test(hubMac)) return;
    const mac = hubMac.toUpperCase();
    try {
      if (!(await mayJoin(socket.data.user, mac))) return;
    } catch (err) {
      console.error('Socket join check failed:', err.message);
      return;
    }
    socket.join(`hub:${mac}`);
    // Replay last known status so the client doesn't show "Unknown"
    // when the hub's retained MQTT message arrived before this client connected.
    const cached = getHubStatus(mac);
    if (cached) socket.emit('hubStatus', cached);
  });
  socket.on('leave', (hubMac) => {
    if (typeof hubMac === 'string' && MAC_RE.test(hubMac)) {
      socket.leave(`hub:${hubMac.toUpperCase()}`);
    }
  });
});

// ── Alert engine + health monitor + MQTT bridge ───────────────────────────────
initAlerts(io);
startHealthMonitor(io);
initMqtt(io);

// ── Seed superadmin on first boot ─────────────────────────────────────────────
async function seedSuperadmin() {
  try {
    const { rows } = await query("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1");
    if (rows.length > 0) return;
    const username = process.env.ADMIN_USERNAME || 'admin';
    const hash = process.env.ADMIN_PASSWORD_HASH;
    if (!hash) { console.error('ADMIN_PASSWORD_HASH not set — cannot seed superadmin'); return; }
    await query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING',
      [username, hash, 'superadmin']
    );
    console.log(`Seeded superadmin user: ${username}`);
  } catch (err) {
    console.error('Failed to seed superadmin:', err.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
seedSuperadmin().then(() => {
  server.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
  });
});
