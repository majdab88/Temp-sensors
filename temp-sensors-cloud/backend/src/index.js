// Phase 2 placeholder — to be replaced with full Express + Socket.IO implementation.
// See CLOUD_MIGRATION_PLAN.md Phase 2 for the complete backend scaffold.
const http = require('http');

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', message: 'Backend stub — Phase 2 not yet implemented' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Backend placeholder listening on port ${PORT}`);
});
