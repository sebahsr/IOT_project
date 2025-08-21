function csvToArray(s) {
  return (s || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

function bool(s, def = false) {
  if (s === undefined) return def;
  return /^(1|true|yes|on)$/i.test(String(s));
}

const config = {
  port: Number(process.env.PORT || 3000),
  corsOrigins: csvToArray(process.env.CORS_ORIGINS),
  jwtSecret: process.env.JWT_SECRET,
  mongoUri: process.env.MONGO_URI,
  mqttUrl: process.env.MQTT_URL || 'mqtt://test.mosquitto.org:1883',
  telemetryTtlDays: Number(process.env.TELEMETRY_TTL_DAYS || 0),
  isProd: process.env.NODE_ENV === 'production',
};

function assertConfig() {
  const missing = [];
  if (!config.mongoUri) missing.push('MONGO_URI');
  if (!config.jwtSecret) missing.push('JWT_SECRET');
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

module.exports = { config, assertConfig, csvToArray, bool };
