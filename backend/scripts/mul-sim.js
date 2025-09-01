// SHEGA multi-home, multi-device simulator
// - Per home: AIRNODE_01 + STOVENODE_01
// - Publishes telemetry, listens for control, emits alerts on thresholds

const mqtt = require('mqtt');

// ---------- Config ----------
const MQTT_URL = process.env.MQTT_URL ||'43d915ee13464d378123cf8314cb259b.s1.eu.hivemq.cloud';
const MQTT_USER = process.env.MQTT_USER || undefined;
const MQTT_PASS = process.env.MQTT_PASS || undefined;

// Default uses the three homes you asked for (note the duplicated HOME_02)
const HOMES = (process.env.HOMES || 'HOME_01,HOME_02,HOME_02')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Publish intervals (ms)
const AIRNODE_MS = Number(process.env.AIRNODE_MS || 3000);
const STOVE_MS   = Number(process.env.STOVE_MS   || 3000);

// Topic templates
const tAirData   = (homeId, devId) => `shega/airnode/data/${homeId}/${devId}`;
const tStvStatus = (homeId, devId) => `shega/stovenode/status/${homeId}/${devId}`;
const tStvCtrl   = (homeId, devId) => `shega/stovenode/control/${homeId}/${devId}`;
const tAlerts    = (homeId)        => `shega/alerts/${homeId}`;

// Safety thresholds (tune as needed)
const LIMITS = {
  CO2: 1200,   // ppm
  CO:  30,     // ppm (short-term)
  PM25: 35,    // µg/m³
  PM10: 50,    // µg/m³
  STOVE_HOT: 180, // °C (thermocouple)
};

// ---------- Helpers ----------
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const jitter = (amt) => (Math.random() * 2 - 1) * amt;
const rnd = (min, max) => min + Math.random() * (max - min);
const nowIso = () => new Date().toISOString();

// Random-walk state per device
const deviceState = new Map(); // key -> object

function ds(key, seedFn) {
  if (!deviceState.has(key)) deviceState.set(key, seedFn());
  return deviceState.get(key);
}

// ---------- Sim models ----------
function simulateAirNode(homeId, devId) {
  // Seed once
  const s = ds(`${homeId}:${devId}`, () => ({
    co2: rnd(450, 800),    // ppm
    co: rnd(0, 5),         // ppm
    pm25: rnd(3, 15),      // µg/m³
    pm10: rnd(5, 25),      // µg/m³
    temp: rnd(20, 27),     // °C
    rh: rnd(30, 55),       // %
    buzzer: false,
  }));

  // Drift
  s.co2  = clamp(s.co2  + jitter(40), 350, 2500);
  s.co   = clamp(s.co   + jitter(2),  0,  200);
  s.pm25 = clamp(s.pm25 + jitter(3),  0,  500);
  s.pm10 = clamp(s.pm10 + jitter(5),  0,  600);
  s.temp = clamp(s.temp + jitter(0.3), 15, 40);
  s.rh   = clamp(s.rh   + jitter(1.2),  15, 90);

  // Alerts -> buzzer on AirNode
  const alerts = [];
  if (s.co2 > LIMITS.CO2)  alerts.push(`High CO₂: ${s.co2.toFixed(0)} ppm`);
  if (s.co > LIMITS.CO)    alerts.push(`High CO: ${s.co.toFixed(1)} ppm`);
  if (s.pm25 > LIMITS.PM25) alerts.push(`High PM2.5: ${s.pm25.toFixed(1)} µg/m³`);
  if (s.pm10 > LIMITS.PM10) alerts.push(`High PM10: ${s.pm10.toFixed(1)} µg/m³`);

  s.buzzer = alerts.length > 0; // emulate buzzer behavior

  const payload = {
    ts: nowIso(),
    homeId,
    deviceId: devId,
    metrics: {
      co2_ppm: Math.round(s.co2),
      co_ppm: Number(s.co.toFixed(1)),
      pm25_ugm3: Number(s.pm25.toFixed(1)),
      pm10_ugm3: Number(s.pm10.toFixed(1)),
      temperature_c: Number(s.temp.toFixed(1)),
      humidity_pct: Math.round(s.rh),
    },
    actuators: {
      buzzer: s.buzzer ? 'on' : 'off',
    },
  };

  return { payload, alerts };
}

function simulateStoveNode(homeId, devId) {
  const s = ds(`${homeId}:${devId}`, () => ({
    tC: rnd(35, 60),        // Thermocouple temp °C (idle)
    fan: false,             // controlled via MQTT
    manualFanOverride: false, // if true, user keeps fan on regardless of temp
  }));

  // drift temp towards occasional cooking peaks
  const cooking = Math.random() < 0.25; // 25% chance we are "cooking"
  if (cooking) {
    // spike up to 220–320°C
    s.tC = clamp(s.tC + rnd(15, 45), 25, 320);
  } else {
    // cool down
    s.tC = clamp(s.tC - rnd(5, 12), 20, 320);
  }

  // auto fan rule (unless manual override)
  if (!s.manualFanOverride) {
    s.fan = s.tC >= LIMITS.STOVE_HOT;
  }

  const payload = {
    ts: nowIso(),
    homeId,
    deviceId: devId,
    metrics: {
      stove_temp_c: Math.round(s.tC),
    },
    actuators: {
      fan: s.fan ? 'on' : 'off',
      manualFanOverride: s.manualFanOverride,
    },
  };

  const alerts = [];
  if (s.tC >= LIMITS.STOVE_HOT) {
    alerts.push(`Stove hot: ${Math.round(s.tC)} °C`);
  }

  return { payload, alerts };
}

// ---------- MQTT ----------
const mqttOpts = {
  username: MQTT_USER,
  password: MQTT_PASS,
  reconnectPeriod: 2000,
  // For ws/wss/tls, provide proper URL & certs as needed
};

const client = mqtt.connect(MQTT_URL, mqttOpts);

client.on('connect', () => {
  console.log(`[MQTT] connected to ${MQTT_URL}`);

  // Subscribe to all stove control topics
  HOMES.forEach(homeId => {
    const devId = 'STOVENODE_01';
    const topic = tStvCtrl(homeId, devId);
    client.subscribe(topic, err => {
      if (err) console.error('[MQTT] subscribe error:', topic, err.message);
      else console.log('[MQTT] subscribed:', topic);
    });
  });
});

client.on('message', (topic, buf) => {
  try {
    const msg = JSON.parse(buf.toString());
    // topic: shega/stovenode/control/{homeId}/{deviceId}
    const parts = topic.split('/');
    const homeId = parts[3];
    const devId = parts[4];
    const key = `${homeId}:${devId}`;
    const s = ds(key, () => ({ tC: 25, fan: false, manualFanOverride: false }));

    // controls: { fan: "on"|"off", manualFanOverride: true|false }
    if (typeof msg.fan !== 'undefined') {
      s.fan = msg.fan === 'on';
      s.manualFanOverride = true; // user touched it -> override on
      console.log(`[CTRL] ${homeId}/${devId} fan=${msg.fan}`);
    }
    if (typeof msg.manualFanOverride !== 'undefined') {
      s.manualFanOverride = !!msg.manualFanOverride;
      console.log(`[CTRL] ${homeId}/${devId} manualFanOverride=${s.manualFanOverride}`);
    }
  } catch (e) {
    console.error('[CTRL] bad message:', topic, e.message);
  }
});

client.on('error', err => console.error('[MQTT] error:', err.message));
client.on('reconnect', () => console.log('[MQTT] reconnecting…'));

// ---------- Loops ----------
function startPerHomeLoops(homeId) {
  const airDev = 'AIRNODE_01';
  const stvDev = 'STOVENODE_01';

  // AirNode loop
  setInterval(() => {
    const { payload, alerts } = simulateAirNode(homeId, airDev);
    client.publish(tAirData(homeId, airDev), JSON.stringify(payload), { qos: 0 });
    console.log(`[PUB] ${tAirData(homeId, airDev)} →`, payload.metrics);

    if (alerts.length) {
      const alertMsg = {
        ts: payload.ts,
        homeId,
        source: airDev,
        type: 'air_quality',
        alerts,
      };
      client.publish(tAlerts(homeId), JSON.stringify(alertMsg), { qos: 0 });
      console.log(`[ALERT] ${homeId} (AirNode):`, alerts.join(' | '));
    }
  }, AIRNODE_MS);

  // StoveNode loop
  setInterval(() => {
    const { payload, alerts } = simulateStoveNode(homeId, stvDev);
    client.publish(tStvStatus(homeId, stvDev), JSON.stringify(payload), { qos: 0 });
    console.log(`[PUB] ${tStvStatus(homeId, stvDev)} →`, payload.metrics, payload.actuators);

    if (alerts.length) {
      const alertMsg = {
        ts: payload.ts,
        homeId,
        source: stvDev,
        type: 'stove_safety',
        alerts,
      };
      client.publish(tAlerts(homeId), JSON.stringify(alertMsg), { qos: 0 });
      console.log(`[ALERT] ${homeId} (StoveNode):`, alerts.join(' | '));
    }
  }, STOVE_MS);
}

// Kickoff all homes
HOMES.forEach(startPerHomeLoops);

// Graceful exit
process.on('SIGINT', () => {
  console.log('\nShutting down…');
  client.end(true, () => process.exit(0));
});
