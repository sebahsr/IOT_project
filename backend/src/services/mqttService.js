// services/mqttService.js
const mqtt = require('mqtt');
const { saveTelemetry } = require('./telemetryService');
const { upsertFromIngest } = require('./deviceService');
const sockets = require('../sockets');

let client;

function startMqtt() {
  const url = process.env.MQTT_URL || 'mqtt://localhost:1883';
  const opts = {};
  if (process.env.MQTT_USERNAME) opts.username = process.env.MQTT_USERNAME;
  if (process.env.MQTT_PASSWORD) opts.password = process.env.MQTT_PASSWORD;

  client = mqtt.connect(url, { ...opts, reconnectPeriod: 2000 });

  client.on('connect', () => {
    console.log('✅ MQTT connected:', url);
    client.subscribe(
      [
        'shega/+/data',     // airnode data
        'shega/+/status',   // stovenode status
        'shega/alerts'      // alerts channel
      ],
      { qos: 0 },
      (err) => {
        if (err) console.error('MQTT subscribe error:', err.message);
        else console.log('📡 Subscribed: shega/+/data, shega/+/status, shega/alerts');
      }
    );
  });

  client.on('reconnect', () => console.log('… MQTT reconnecting …'));
  client.on('error', (err) => console.error('MQTT error:', err.message));

  client.on('message', async (topic, buf) => {
    let raw;
    try {
      raw = JSON.parse(buf.toString());
    } catch (e) {
      console.warn(`[MQTT] Non-JSON on ${topic}:`, buf.toString().slice(0, 200));
      return;
    }

    // Normalize to canonical shape
    const msg = normalizeMessage(topic, raw);
    // Log a concise line for triage
    console.log(`📥 ${topic} :: ${msg.homeId}/${msg.deviceId} [${msg.stream}] @ ${msg.ts}`);

    // Ignore control & alerts here (alerts are side-channel only)
    if (topic === 'shega/alerts') {
      try { sockets.emitAlert(raw); } catch {}
      return;
    }

    // Basic guards
    if (!msg.homeId || !msg.deviceId) {
      console.warn('[MQTT] Missing homeId/deviceId, skipping:', raw);
      return;
    }
    if (!msg.stream) {
      console.warn('[MQTT] Could not derive stream (AIR/STOVE), skipping:', raw);
      return;
    }

    try {
      // Ensure the device exists (or create/update)
      const device = await upsertFromIngest({
        homeId: msg.homeId,
        deviceId: msg.deviceId,
        stream: msg.stream
      });

      // Persist telemetry
      const doc = await saveTelemetry({
        homeId: msg.homeId,
        deviceId: msg.deviceId,
        stream: msg.stream,
        payload: msg.payload, // guaranteed object by normalizeMessage
        ts: msg.ts,
        deviceRef: device?._id
      });

      console.log(`💾 Telemetry saved: ${msg.deviceId} (${msg.stream})`);

      // Live push to sockets
      try { sockets.emitTelemetry(doc.toObject ? doc.toObject() : doc); } catch {}

      // After persist, compute alerts from normalized payload
      maybePublishAlerts(msg); // uses normalized fields
    } catch (e) {
      console.error('MQTT message error:', e.message);
    }
  });

  return client;
}

/**
 * Normalize incoming messages to:
 * {
 *   ts: ISO string,
 *   homeId: string,
 *   deviceId: string,
 *   stream: 'AIR' | 'STOVE',
 *   payload: { co2, co, pm25, pm10, temperature_c, humidity_pct, stove_temp_c, windowOpen, ... }
 * }
 */
function normalizeMessage(topic, raw) {
  const ts = toISO(raw.ts);
  const homeId = raw.homeId || raw.home || raw.h || extractHomeFromDevice(raw.deviceId);
  const deviceId = raw.deviceId || raw.device;
  // Prefer explicit stream, else infer from topic/content
  let stream = (raw.stream && String(raw.stream).toUpperCase()) || inferStream(topic, raw);

  // Accept both nested payload and flat fields
  const src = (raw.payload && typeof raw.payload === 'object') ? raw.payload : raw;

  // Canonical payload fields (map variants → normalized keys)
  const payload = {
    // Air
    co2: pickNumber(src.co2, src.co2_ppm),
    co: pickNumber(src.co, src.co_ppm),
    pm25: pickNumber(src.pm25, src.pm25_ugm3, src.pm2_5, src.pm2_5_ugm3),
    pm10: pickNumber(src.pm10, src.pm10_ugm3),
    temperature_c: pickNumber(src.temperature_c, src.temp_c, src.temperature),
    humidity_pct: pickNumber(src.humidity_pct, src.humidity),

    // Stove
    stove_temp_c: pickNumber(src.stove_temp_c, src.stove_temp),
    fanOn: typeof src.fanOn === 'boolean' ? src.fanOn : undefined,
    buzzerOn: typeof src.buzzerOn === 'boolean' ? src.buzzerOn : undefined,

    // Misc
    profile: src.profile,
    windowOpen: typeof src.windowOpen === 'boolean' ? src.windowOpen : undefined
  };

  // If stream still unknown, infer by presence of stove vs air keys
  if (!stream) {
    if (isFiniteNumber(payload.stove_temp_c)) stream = 'STOVE';
    else if (
      isFiniteNumber(payload.co2) ||
      isFiniteNumber(payload.co) ||
      isFiniteNumber(payload.pm25) ||
      isFiniteNumber(payload.pm10)
    ) stream = 'AIR';
  }

  return { ts, homeId, deviceId, stream, payload };
}

function inferStream(topic, raw) {
  const t = topic.toLowerCase();
  if (t.includes('/airnode/')) return 'AIR';
  if (t.includes('/stovenode/')) return 'STOVE';
  return (raw.stream && String(raw.stream).toUpperCase()) || undefined;
}

function pickNumber(...candidates) {
  for (const v of candidates) {
    if (isFiniteNumber(v)) return Number(v);
  }
  return undefined;
}
function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

function toISO(v) {
  if (!v) return new Date().toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function extractHomeFromDevice(deviceId) {
  if (!deviceId) return undefined;
  // e.g., AIR_HOME_01 → HOME_01 ; STOVE_HOME_03 → HOME_03
  const m = String(deviceId).match(/HOME_\d{2}/);
  return m ? m[0] : undefined;
}

/**
 * Alerting logic based on normalized payload
 */
function maybePublishAlerts(msg) {
  if (!client) return;

  const p = msg.payload || {};
  const alerts = [];

  if (isFiniteNumber(p.co2) && p.co2 > 1000) {
    alerts.push({ type: 'CO2', level: p.co2 > 1500 ? 'danger' : 'warn', value: p.co2, limit: 1000 });
  }
  if (isFiniteNumber(p.co) && p.co > 35) {
    alerts.push({ type: 'CO', level: 'danger', value: p.co, limit: 35 });
  }
  if (isFiniteNumber(p.pm25) && p.pm25 > 35) {
    alerts.push({ type: 'PM2_5', level: p.pm25 > 100 ? 'danger' : 'warn', value: p.pm25, limit: 35 });
  }
  if (isFiniteNumber(p.stove_temp_c) && p.stove_temp_c > 250) {
    alerts.push({ type: 'STOVE_TEMP', level: 'danger', value: p.stove_temp_c, limit: 250 });
  }

  if (alerts.length) {
    const payload = {
      homeId: msg.homeId,
      deviceId: msg.deviceId,
      stream: msg.stream,
      ts: new Date().toISOString(),
      alerts
    };
    const str = JSON.stringify(payload);
    client.publish('shega/alerts', str, { qos: 0, retain: false });
    console.log('🚨 Alert published → shega/alerts', str);
    try { sockets.emitAlert(payload); } catch {}
  }
}

function publish(topic, json) {
  if (!client) throw new Error('MQTT not started');
  const payload = typeof json === 'string' ? json : JSON.stringify(json);
  client.publish(topic, payload, { qos: 0, retain: false });
}

module.exports = { startMqtt, publish };
