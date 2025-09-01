const { Server } = require('socket.io');
const live = require('../services/liveStore');

let io;

function start(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN?.split(',') || true, credentials: true },
  });
console.log('Socket.IO server started');
  const nsp = io.of('/live');
 console.log('Socket.IO /live namespace ready');
 
  nsp.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);
    // auth can come from handshake.auth or query — keep it simple for now
    const auth = { ...(socket.handshake.auth || {}), ...(socket.handshake.query || {}) };
    const role = (auth.role || 'user').toLowerCase();
    const homeId = auth.homeId;

    if (role === 'admin') socket.join('admins');
    if (role==='user' ) {

      socket.join(`home:${homeId}`);
      socket.emit('home:snapshot', live.getHomeSnapshot(homeId));
    }
    if (homeId) {
      socket.join(`home:${homeId}`);
      // Send initial snapshot for the joined home
      socket.emit('home:snapshot', live.getHomeSnapshot(homeId));
    }

    socket.on('join:home', (hid) => {
      if (!hid) return;
      socket.join(`home:${hid}`);
      socket.emit('home:snapshot', live.getHomeSnapshot(hid));
    });
  });
}

function emitTelemetry(doc) {
  if (!io) return;
  const { device, statusCounts } = require('../services/liveStore').setTelemetry(doc);

  const nsp = io.of('/live');
  const room = `home:${doc.homeId}`;
  nsp.to(room).emit('telemetry', { doc, device, statusCounts });
  nsp.to('admins').emit('telemetry', { doc, device, statusCounts, homeId: doc.homeId });
}

function emitAlert(payload) {
  if (!io) return;
  const nsp = io.of('/live');
  const room = `home:${payload.homeId}`;
  nsp.to(room).emit('alert', payload);
  nsp.to('admins').emit('alert', { ...payload, scope: 'admin' });
}

module.exports = { start, emitTelemetry, emitAlert };
