const mongoose = require('mongoose');

function readyStateText(state) {
  return ['disconnected', 'connected', 'connecting', 'disconnecting'][state] || 'unknown';
}

async function connectMongo(uri = process.env.MONGO_URI) {
  if (!uri) throw new Error('MONGO_URI is not set in environment');
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { autoIndex: true });

  const state = readyStateText(mongoose.connection.readyState);
  console.log(`✅ MongoDB connected: ${state} → ${uri}`);

  // Optional TTL for telemetry
  const days = Number(process.env.TELEMETRY_TTL_DAYS || 0);
  if (days > 0) {
    const seconds = Math.max(60, Math.floor(days * 86400));
    try {
      await mongoose.connection.db.collection('telemetry')
        .createIndex({ ts: 1 }, { expireAfterSeconds: seconds });
      console.log(`🧹 Telemetry TTL enabled: ${days} days (${seconds}s)`);
    } catch (e) {
      console.warn('TTL index creation failed (telemetry.ts):', e.message);
    }
  }

  mongoose.connection.on('error', (err) => console.error('❌ MongoDB error:', err.message));
  mongoose.connection.on('disconnected', () => console.warn('⚠️  MongoDB disconnected'));
  return mongoose.connection;
}

function getMongoState() {
  return readyStateText(mongoose.connection.readyState);
}

module.exports = { connectMongo, getMongoState };
