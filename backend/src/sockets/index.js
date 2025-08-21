const jwt = require('jsonwebtoken');

let io;

function init(server) {
  const { Server } = require('socket.io');
  const origins = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
  io = new Server(server, {
    cors: {
      origin: origins.length ? origins : '*',
      credentials: true
    }
  });

  // JWT auth during handshake
  io.use((socket, next) => {
    try {
      const hdr = socket.handshake.headers?.authorization || '';
      const viaAuth = socket.handshake.auth?.token;
      const token = viaAuth || (hdr.startsWith('Bearer ') ? hdr.split(' ')[1] : null);
      if (!token) return next(new Error('Missing token'));
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = {
        id: payload.sub,
        role: payload.role,
        homes: payload.homes || []
      };
      next();
    } catch (e) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { role, homes } = socket.user;
    if (role === 'admin') socket.join('admin');
    homes.forEach(h => socket.join(`home:${h}`));
    socket.emit('ready', { ok: true, rooms: Array.from(socket.rooms) });
  });

  console.log('✅ Socket.IO ready');
  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

function emitTelemetry(doc) {
  if (!io) return;
  io.to(`home:${doc.homeId}`).emit('telemetry', doc);
  io.to('admin').emit('telemetry', doc);
}

function emitAlert(alertObj) {
  if (!io) return;
  io.to(`home:${alertObj.homeId}`).emit('alert', alertObj);
  io.to('admin').emit('alert', alertObj);
}

function emitCommand(cmdObj) {
  if (!io) return;
  io.to(`home:${cmdObj.homeId}`).emit('command', cmdObj);
  io.to('admin').emit('command', cmdObj);
}

module.exports = { init, getIO, emitTelemetry, emitAlert, emitCommand };
