// services/mqttService.js
const mqtt = require('mqtt');
const { saveTelemetry } = require('./telemetryService');
const { upsertFromIngest } = require('./deviceService');
const { saveEmergency } = require('./emergencyService');
const sockets = require('../sockets');

// ---------- Tunables ----------
const RECONNECT_MS = 2000;
const TRICKLE_MS = Number(process.env.TELEMETRY_TRICKLE_MS || 60_000);      // persist at most 1/min per device
const UPSERT_THROTTLE_MS = Number(process.env.DEVICE_UPSERT_THROTTLE_MS || 5 * 60_000); // upsert at most 1/5min per device
const LOG_VERBOSE = process.env.MQTT_LOG_VERBOSE === '1'; // default: quiet
// ------------------------------

let client;

// per-device cadence control
const lastPersistAt = new Map(); // deviceId -> ts
const lastUpsertAt = new Map();  // deviceId -> ts

function startMqtt() {
  const url = process.env.MQTT_URL || "mqtts://43d915ee13464d378123cf8314cb259b.s1.eu.hivemq.cloud:8883";
const opts = {
  username: process.env.MQTT_USERNAME || "sebah",
  password: process.env.MQTT_PASSWORD || "Ss123456789",
  rejectUnauthorized: false // skip cert check (dev only)
};
client = mqtt.connect(url, { ...opts, reconnectPeriod: RECONNECT_MS });

  client.on('connect', () => {
    console.log('✅ MQTT connected:', url);
    client.subscribe(
      [
        'shega/+/+/+',   // e.g. shega/HOME_01/airnode/data, shega/HOME_01/stovenode/status
        'shega/+/data',  // legacy flat
        'shega/+/status',
        'shega/+/events',// device↔device events (emergencies, interventions, control_denied)
        'shega/alerts',  // downstream-only alerts (from server logic if any)
      ],
      { qos: 0 },
      (err) => {
        if (err) console.error('MQTT subscribe error:', err.message);
        else if (LOG_VERBOSE) console.log('📡 Subscribed: shega/+/+/+, shega/+/data, shega/+/status, shega/+/events, shega/alerts');
      }
    );
  });

  client.on('reconnect', () => LOG_VERBOSE && console.log('… MQTT reconnecting …'));
  client.on('error', (err) => console.error('MQTT error:', err.message));

  client.on('message', async (topic, buf) => {
    let raw;
    console.log(raw)
    try {
      raw = JSON.parse(buf.toString());
    
    } catch(e){
      console.log("error",e)
      if (LOG_VERBOSE) console.warn(`[MQTT] Non-JSON on ${topic}:`, buf.toString().slice(0, 200));
      return;
    }

    // Alerts side-channel → fan out only
    if (topic === 'shega/alerts') {
      try { sockets.emitAlert(raw); } catch {}
      return;
    }

    // Handle device EVENTS (emergencies/interventions/etc.)
    if (isEventsTopic(topic)) {
      try {
        const evt = normalizeEvent(topic, raw);
        if (!evt.homeId || !evt.deviceId || !evt.type) {
          if (LOG_VERBOSE) console.warn('[MQTT] Invalid event:', raw);
          return;
        }

        // Live fan-out to dashboard
        try { 
          console.log("evt:   "+evt)
          sockets.emitEvent(evt);
         } catch {}

        // Persist only EMERGENCY/critical events
        const emerg = eventToEmergency(evt);
        if (emerg) {
          const saved = await saveEmergency(emerg);
          // Also push a high-visibility alert channel if you like
          try { sockets.emitAlert({ ...emerg, _id: saved._id }); } catch {}
        }
      } catch (e) {
        console.error('EVENT handling error:', e.message);
      }
      return; // events do not fall through to telemetry handler
    }

    // TELEMETRY / STATUS flow
    const msg = normalizeMessage(topic, raw);
    if (LOG_VERBOSE) {
      console.log(`📥 ${topic} :: ${msg.homeId || '-'} / ${msg.deviceId || '-'} [${msg.stream || '-'}] @ ${msg.ts}`);
    }

    // Guards
    if (!msg.homeId || !msg.deviceId) {
      if (LOG_VERBOSE) console.warn('[MQTT] Missing homeId/deviceId, skipping:', raw);
      return;
    }
    if (!msg.stream) {
      if (LOG_VERBOSE) console.warn('[MQTT] Could not derive stream (AIR/STOVE), skipping:', raw);
      return;
    }

    try {
      // --- Upsert device (throttled) ---
      throttleUpsert(msg.homeId, msg.deviceId, msg.stream);

      // --- Decide persistence policy (alert or trickle) ---
      const alertList = computeAlertsForDecision(msg.payload);
      const shouldPersist = alertList.length > 0 || shouldTrickle(msg.deviceId, TRICKLE_MS);

      let doc = {
        homeId: msg.homeId,
        deviceId: msg.deviceId,
        stream: msg.stream,
        payload: msg.payload,
        ts: msg.ts,
      };

      if (shouldPersist) {
        // Persist and link to device
        const deviceRef = await safeUpsertForPersist(msg.homeId, msg.deviceId, msg.stream);
        doc.deviceRef = deviceRef?._id;

        const saved = await saveTelemetry(doc);
        doc = saved?.toObject ? saved.toObject() : saved;
        if (LOG_VERBOSE) {
          console.log(`💾 Telemetry saved: ${msg.deviceId} (${msg.stream}) ${alertList.length ? '[ALERT]' : '[TRICKLE]'}`);
        }
      }

      // --- Live push (every message) ---
      try { 
        console.log("here")
        
        sockets.emitTelemetry(doc); } catch {}

      // --- Publish + emit alerts if any ---
      if (alertList.length) maybePublishAlerts({ ...msg, alerts: alertList });
    } catch (e) {
      console.error('MQTT message error:', e.message);
    }
  });

  return client;
}

/* ----------------- Helpers: device upsert / trickle ----------------- */
async function throttleUpsert(homeId, deviceId, stream) {
  const now = Date.now();
  const last = lastUpsertAt.get(deviceId) || 0;
  if (now - last >= UPSERT_THROTTLE_MS) {
    await upsertFromIngest({ homeId, deviceId, stream });
    lastUpsertAt.set(deviceId, now);
  }
}

// Ensure an upsert right before a persist (rare path)
async function safeUpsertForPersist(homeId, deviceId, stream) {
  try {
    return await upsertFromIngest({ homeId, deviceId, stream });
  } catch {
    return null;
  }
}

function shouldTrickle(deviceId, intervalMs) {
  const now = Date.now();
  const last = lastPersistAt.get(deviceId) || 0;
  if (now - last >= intervalMs) {
    lastPersistAt.set(deviceId, now);
    return true;
  }
  return false;
}

/* ----------------- EVENTS handling ----------------- */
function isEventsTopic(topic) {
  // shega/HOME_01/events
  const parts = topic.split('/');
  return parts.length === 3 && parts[0] === 'shega' && parts[2] === 'events';
}

function normalizeEvent(topic, raw) {
  const ts = toISO(raw.ts);
  const parts = topic.split('/'); // [shega, HOME_XX, events]
  const homeId = raw.homeId || parts[1];
  const deviceId = raw.from || raw.deviceId || 'UNKNOWN';
  const type = String(raw.type || '').toUpperCase();

  // detail is pass-through, but coerce common numbers
  const d = raw.detail || {};
  const detail = {
    ...d,
    stove_temp_c: pickNumber(d.stove_temp_c),
    co: pickNumber(d.co),
    pm25: pickNumber(d.pm25),
    reason: d.reason || d.why || d.action || undefined,
    action: d.action, // keep action if present
  };

  return { ts, homeId, deviceId, type, detail };
}

function eventToEmergency(evt) {
  // decide what to persist as an emergency
  const { homeId, deviceId, type, detail, ts } = evt;

  // STOVE_EMERGENCY: always danger
  if (type === 'STOVE_EMERGENCY') {
    return { homeId, deviceId, type, severity: 'danger', detail, ts };
  }

  // AIR_INTERVENTION with CO_DANGER -> danger
  if (type === 'AIR_INTERVENTION' && (detail?.action === 'CO_DANGER' || detail?.reason === 'CO_DANGER')) {
    return { homeId, deviceId, type: 'CO_DANGER', severity: 'danger', detail, ts };
  }

  // CONTROL_DENIED -> warn (useful audit)
  if (type === 'CONTROL_DENIED') {
    return { homeId, deviceId, type, severity: 'warn', detail, ts };
  }

  // You can add more here (VALVE_CLOSED, SENSOR_FAULT, etc.)
  return null; // non-emergency events are not persisted
}

/* ----------------- TELEMETRY normalization ----------------- */
/**
 * Normalize incoming messages to:
 * {
 *   ts: ISO string,
 *   homeId: string,
 *   deviceId: string,
 *   stream: 'AIR' | 'STOVE',
 *   payload: {
 *     co2, co, pm25, pm10, temperature_c, humidity_pct, pressure_hpa?,
 *     stove_temp_c, fanOn, buzzerOn, windowOpen, profile
 *   }
 * }
 */
function normalizeMessage(topic, raw) {
  const ts = toISO(raw.ts);

  // Parse topic parts
  // Accept:
  // shega/HOME_01/airnode/data
  // shega/HOME_01/stovenode/status
  // shega/HOME_01/data   (legacy)
  // shega/HOME_01/status (legacy)
  const parts = topic.split('/'); // [shega, HOME_01, airnode|stovenode|data|status, data|status?]
  const maybeHome = parts[1];

  const homeId =
    raw.homeId ||
    raw.home ||
    raw.h ||
    (isLikelyHomeId(maybeHome) ? maybeHome : extractHomeFromDevice(raw.deviceId));

  // Prefer explicit deviceId; else derive from stream+home
  let deviceId = raw.deviceId || raw.device;
  let stream = (raw.stream && String(raw.stream).toUpperCase()) || inferStream(parts, raw);

  if (!deviceId && homeId && stream) {
    deviceId = (stream === 'STOVE' ? 'STOVE_' : 'AIR_') + homeId;
  }

  // Accept nested payload or flat fields
  const src = (raw.payload && typeof raw.payload === 'object') ? raw.payload : raw;

  // Canonical payload fields
  const payload = {
    // Air
    co2: pickNumber(src.co2, src.co2_ppm),
    co: pickNumber(src.co, src.co_ppm),
    pm25: pickNumber(src.pm25, src.pm25_ugm3, src.pm2_5, src.pm2_5_ugm3),
    pm10: pickNumber(src.pm10, src.pm10_ugm3),
    temperature_c: pickNumber(src.temperature_c, src.temp_c, src.temperature),
    humidity_pct: pickNumber(src.humidity_pct, src.humidity),
    pressure_hpa: pickNumber(src.pressure_hpa, src.pressure, src.pressure_hPa),
    
    // Stove
    stove_temp_c: pickNumber(src.stove_temp_c, src.stove_temp),
    fanOn: typeof src.fanOn === 'boolean' ? src.fanOn : undefined,
    buzzerOn: typeof src.buzzerOn === 'boolean' ? src.buzzerOn : undefined,
    valveClosed: typeof src.valveClosed==='boolean'? src.valveClosed:undefined,

    // Misc
    profile: src.profile,
    windowOpen: typeof src.windowOpen === 'boolean' ? src.windowOpen : undefined,
  };

  if (!stream) {
    if (isFiniteNumber(payload.stove_temp_c)) stream = 'STOVE';
    else if (
      isFiniteNumber(payload.co2) ||
      isFiniteNumber(payload.co) ||
      isFiniteNumber(payload.pm25) ||
      isFiniteNumber(payload.pm10) ||
      isFiniteNumber(payload.temperature_c) ||
      isFiniteNumber(payload.humidity_pct)
    ) stream = 'AIR';
  }

  return { ts, homeId, deviceId, stream, payload };
}

function inferStream(parts, raw) {
  const p2 = (parts[2] || '').toLowerCase();
  if (p2.includes('airnode')) return 'AIR';
  if (p2.includes('stovenode')) return 'STOVE';
  return (raw.stream && String(raw.stream).toUpperCase()) || undefined;
}

function isLikelyHomeId(s) {
  return typeof s === 'string' && /^HOME_\d{2,}$/.test(s);
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
  const m = String(deviceId).match(/HOME_\d{2,}/);
  return m ? m[0] : undefined;
}

/* ----------------- Alerts publishing (server-origin) ----------------- */
function maybePublishAlerts(msgWithAlerts) {
  if (!client) return;
  const p = msgWithAlerts.payload || {};
  const alerts = msgWithAlerts.alerts || [];
  if (!alerts.length) return;

  const payload = {
    homeId: msgWithAlerts.homeId,
    deviceId: msgWithAlerts.deviceId,
    stream: msgWithAlerts.stream,
    ts: new Date().toISOString(),
    alerts: alerts.map((a) => (typeof a === 'string' ? inflateAlert(a, p) : a)).filter(Boolean),
  };

  const str = JSON.stringify(payload);
  client.publish('shega/alerts', str, { qos: 0, retain: false });
  if (LOG_VERBOSE) console.log('🚨 Alert published → shega/alerts', str);
  try { sockets.emitAlert(payload); } catch {}
}

function computeAlertsForDecision(p = {}) {
  const out = [];
  if (isFiniteNumber(p.co2) && p.co2 > 1000) out.push('CO2');
  if (isFiniteNumber(p.co) && p.co > 35) out.push('CO');
  if (isFiniteNumber(p.pm25) && p.pm25 > 35) out.push('PM2_5');
  if (isFiniteNumber(p.stove_temp_c) && p.stove_temp_c > 250) out.push('STOVE_TEMP');
  return out;
}

function inflateAlert(type, p) {
  switch (type) {
    case 'CO2': return { type: 'CO2', level: p.co2 > 1500 ? 'danger' : 'warn', value: p.co2, limit: 1000 };
    case 'CO': return { type: 'CO', level: 'danger', value: p.co, limit: 35 };
    case 'PM2_5': return { type: 'PM2_5', level: p.pm25 > 100 ? 'danger' : 'warn', value: p.pm25, limit: 35 };
    case 'STOVE_TEMP': return { type: 'STOVE_TEMP', level: 'danger', value: p.stove_temp_c, limit: 250 };
    default: return null;
  }
}

/* ----------------- Command-focused publish helpers ----------------- */
function emitCommandSent(homeId, payload) {
  // Lightweight event  UI can listen for
  const evt = {
    ts: new Date().toISOString(),
    homeId,
    deviceId: 'SERVER',
    type: 'COMMAND_SENT',
    detail: {
      target: (payload && payload.target) || 'ALL',
      actions: (payload && payload.actions) || {},
      actor: payload && payload.meta && payload.meta.actor ? payload.meta.actor : undefined
    }
  };
  try { sockets.emitEvent && sockets.emitEvent(evt); } catch {}
}

// Convenience helper for dashboard routes to send control cleanly
function publishControl(homeId, actions, target = 'ALL', meta = {}) {
  const payload = { target, actions, meta };
  publish(`shega/${homeId}/control`, payload);
}

// Generic publish; detects control topics and logs concisely
function publish(topic, json) {
  if (!client) throw new Error('MQTT not started');

  let obj = json;
  try { if (typeof obj === 'string') obj = JSON.parse(obj); } catch {}

  // If this is a control topic → log a single focused line + socket event
  if (/^shega\/[^/]+\/control$/.test(topic)) {
    const homeId = topic.split('/')[1];
    const target = (obj && obj.target) || 'ALL';
    const actions = (obj && obj.actions) || {};
    console.log(`🛰️ CONTROL → home=${homeId} target=${target} actions=${JSON.stringify(actions)}`);
    emitCommandSent(homeId, obj);
  }

  const payload = typeof json === 'string' ? json : JSON.stringify(json);
  client.publish(topic, payload, { qos: 0, retain: false });
}

module.exports = { startMqtt, publish, publishControl };
