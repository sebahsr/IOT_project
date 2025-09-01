// sim_devices.js
// Node.js simulator for SHEGA AirNode + StoveNode
// - Publishes:
//   * AirNode telemetry → shega/<HOME_ID>/airnode/data  (1s)
//   * StoveNode status  → shega/<HOME_ID>/stovenode/status (3s)
//   * Events            → shega/<HOME_ID>/events
// - Subscribes:
//   * Control           → shega/<HOME_ID>/control
// - Behaviors:
//   * AirNode buzzer/alarm w/ manual ON/OFF + mute window
//   * StoveNode fan + valve open/close + overheat lockout
//   * Stove requests Air alarm on overheat; clears on cool
//
// Requires: npm i mqtt

const mqtt = require('mqtt');

// ---------- CONFIG ----------
const CONFIG = {
  WIFI_SSID: process.env.WIFI_SSID || 'Wokwi-GUEST', // not actually used, just for parity
  WIFI_PASS: process.env.WIFI_PASS || '',
  MQTT_SERVER: process.env.MQTT_SERVER || '43d915ee13464d378123cf8314cb259b.s1.eu.hivemq.cloud',
  MQTT_PORT: Number(process.env.MQTT_PORT || 8883),
  MQTT_USER: process.env.MQTT_USERNAME || 'sebah',
  MQTT_PASS: process.env.MQTT_PASSWORD || 'Ss123456789',
  HOME_ID: process.env.HOME_ID || 'HOME_01',
  AIR_DEVICE_ID: process.env.AIR_DEVICE_ID || 'AIRNODE_01',
  STOVE_DEVICE_ID: process.env.STOVE_DEVICE_ID || 'STOVENODE_01',
  LOG_VERBOSE: process.env.SIM_LOG_VERBOSE === '1',

  // Thresholds (keep consistent with  firmware + server)
  TH: {
    CO2_DANGER: 1500,     // ppm
    CO_DANGER: 50,        // ppm
    PM25_DANGER: 100,     // µg/m³
    PM10_DANGER: 150,     // µg/m³
    TEMP_DANGER: 40.0,    // °C (room temp for AirNode)
    STOVE_OVERHEAT: 250.0,// °C
    STOVE_CLEAR: 220.0,   // °C
  },

  AIR_TELEMETRY_MS: 1000,
  STOVE_STATUS_MS: 3000,
  CONTROL_COOLDOWN_MS: 5000, // throttle publishControl from stove
};
// ---------------------------

const tNowISO = () => new Date().toISOString();
const jitter = (v, step, min, max) => Math.max(min, Math.min(max, v + (Math.random() * 2 - 1) * step));

const client = mqtt.connect(`mqtts://${CONFIG.MQTT_SERVER}:${CONFIG.MQTT_PORT}`, {
  username: CONFIG.MQTT_USER,
  password: CONFIG.MQTT_PASS,
  reconnectPeriod: 2000,
  rejectUnauthorized: false, // dev only
  keepalive: 60,
});

const topic = {
  control: `shega/${CONFIG.HOME_ID}/control`,
  events:  `shega/${CONFIG.HOME_ID}/events`,
  airTele: `shega/${CONFIG.HOME_ID}/airnode/data`,
  stoveSt: `shega/${CONFIG.HOME_ID}/stovenode/status`,
  status:  `shega/STATUS`,
};

// ---------------- AirNode State ----------------
const Air = {
  deviceId: CONFIG.AIR_DEVICE_ID,
  co2: 600,  // ppm
  co:  5,    // ppm
  pm25: 10,  // µg/m³
  pm10: 12,  // µg/m³
  tC:  26.0, // °C
  rh:  45.0, // %

  // Alarm/buzzer state machine (parity with firmware)
  buzzerAuto: false,
  buzzerManualOn: false,
  buzzerManualOff: false,
  muteMs: 120000, // default 2 min
  muteUntil: 0,   // epoch ms
  alarmOn: false, // derived (manualOn || (!manualOff && auto))
  danger: false,
  lastDanger: false,
};

function airComputeDanger() {
  if (Air.co2 >= CONFIG.TH.CO2_DANGER) return true;
  if (Air.co   >= CONFIG.TH.CO_DANGER) return true;
  if (Air.pm25 >= CONFIG.TH.PM25_DANGER) return true;
  if (Air.pm10 >= CONFIG.TH.PM10_DANGER) return true;
  if (Air.tC   >= CONFIG.TH.TEMP_DANGER) return true;
  return false;
}
function airUpdateAlarmFromDanger() {
  const prev = Air.danger;
  Air.danger = airComputeDanger();
  const now = Date.now();
  const muted = now <= Air.muteUntil;
  Air.buzzerAuto = Air.danger && !muted;
  Air.alarmOn = Air.buzzerManualOn || (!Air.buzzerManualOff && Air.buzzerAuto);

  if (Air.danger !== prev && CONFIG.LOG_VERBOSE) {
    console.log(`[AIR] danger=${Air.danger} (muted=${muted}) co2=${Air.co2} co=${Air.co} pm25=${Air.pm25} pm10=${Air.pm10} t=${Air.tC.toFixed(1)}`);
  }

  if (Air.danger !== Air.lastDanger) {
    Air.lastDanger = Air.danger;
    if (Air.danger) {
      let why = 'GENERAL_DANGER';
      if (Air.co2 >= CONFIG.TH.CO2_DANGER)      why = 'CO2_DANGER';
      else if (Air.co >= CONFIG.TH.CO_DANGER)   why = 'CO_DANGER';
      else if (Air.pm25 >= CONFIG.TH.PM25_DANGER) why = 'PM25_DANGER';
      else if (Air.pm10 >= CONFIG.TH.PM10_DANGER) why = 'PM10_DANGER';
      else if (Air.tC >= CONFIG.TH.TEMP_DANGER) why = 'TEMP_DANGER';
      simPublishEvent({
        ts: tNowISO(),
        homeId: CONFIG.HOME_ID,
        deviceId: Air.deviceId,
        type: 'AIR_INTERVENTION',
        detail: { reason: why, co: Air.co, pm25: Air.pm25, co2: Air.co2, temp_c: Air.tC },
      });
    } else {
      simPublishEvent({
        ts: tNowISO(),
        homeId: CONFIG.HOME_ID,
        deviceId: Air.deviceId,
        type: 'AIR_SAFE',
        detail: { reason: 'CLEAR' },
      });
    }
  }
}

function airPublishTelemetry() {
  const payload = {
    ts: tNowISO(),
    homeId: CONFIG.HOME_ID,
    deviceId: Air.deviceId,
    stream: 'AIR',
    payload: {
      co2: Math.round(Air.co2),
      co: Math.round(Air.co),
      pm25: Math.round(Air.pm25),
      pm10: Math.round(Air.pm10),
      temperature_c: Number(Air.tC.toFixed(1)),
      humidity_pct: Number(Air.rh.toFixed(1)),
      alarmOn: !!Air.alarmOn,
    },
  };
  client.publish(topic.airTele, JSON.stringify(payload));
  if (CONFIG.LOG_VERBOSE) console.log('→ AIR tele', payload);
}

function airApplyControl(json) {
  // match target ALL or AIRNODE or deviceId
  const target = json.target;
  if (target && !(target === 'ALL' || target === 'AIRNODE' || target === Air.deviceId)) return;

  if (typeof json.mute_ms === 'number' && json.mute_ms > 0 && json.mute_ms <= 15 * 60 * 1000) {
    Air.muteMs = json.mute_ms;
    if (CONFIG.LOG_VERBOSE) console.log(`[AIR] set muteMs=${Air.muteMs}`);
  }

  if (json.buzzer === 'on') {
    Air.buzzerManualOn = true;
    Air.buzzerManualOff = false;
    Air.muteUntil = 0;
  }
  if (json.buzzer === 'off') {
    Air.buzzerManualOff = true;
    Air.buzzerManualOn = false;
    Air.muteUntil = Date.now() + Air.muteMs;
  }

  if (json.alarm === 'on') {
    Air.buzzerManualOn = true;
    Air.buzzerManualOff = false;
    Air.muteUntil = 0;
  }
  if (json.alarm === 'off') {
    Air.buzzerManualOff = true;
    Air.buzzerManualOn = false;
    Air.muteUntil = Date.now() + Air.muteMs;
  }

  // LED hints ignored in sim; you could print if you want
  Air.alarmOn = Air.buzzerManualOn || (!Air.buzzerManualOff && Air.buzzerAuto);
}

// ---------------- StoveNode State ----------------
const Stove = {
  deviceId: CONFIG.STOVE_DEVICE_ID,
  tempC: 100, // °C
  fanOn: false,
  valveClosed: false,  // true if angle 90, we simulate boolean only
  valveLockout: false,
  lastSent: 0,
  airAlarmRequested: false,
  lastAlarmSendMs: 0,
};

function stoveOverheated() { return Stove.tempC >= CONFIG.TH.STOVE_OVERHEAT; }
function stoveCooled() { return Stove.tempC <= CONFIG.TH.STOVE_CLEAR; }

function stoveSendStatus() {
  const payload = {
    homeId: CONFIG.HOME_ID,
    deviceId: Stove.deviceId,
    stream: 'STOVE',
    ts: tNowISO(),
    payload: {
      stove_temp_c: Number(Stove.tempC.toFixed(2)),
      fanOn: !!Stove.fanOn,
      valveClosed: !!Stove.valveClosed || !!Stove.valveLockout,
    },
  };
  client.publish(topic.stoveSt, JSON.stringify(payload));
  if (CONFIG.LOG_VERBOSE) console.log('→ STOVE status', payload);
}
function stovePublishEvent(type, action, reason) {
  const ev = {
    ts: tNowISO(),
    homeId: CONFIG.HOME_ID,
    from: Stove.deviceId,
    type,
    detail: { action, ...(reason ? { reason } : {}) },
  };
  client.publish(topic.events, JSON.stringify(ev));
  if (CONFIG.LOG_VERBOSE) console.log('📰 EVENT→', ev);
}

function stoveTryOpenValve() {
  if (stoveCooled()) {
    Stove.valveClosed = false;
    Stove.valveLockout = false;
  } else {
    Stove.valveClosed = true;
    Stove.valveLockout = true;
  }
}
function stoveCloseValveLock() {
  Stove.valveClosed = true;
  Stove.valveLockout = true;
}

function publishAirAlarm(on, mute_ms = 0, reason) {
  const now = Date.now();
  if (now - Stove.lastAlarmSendMs < CONFIG.CONTROL_COOLDOWN_MS) {
    if (CONFIG.LOG_VERBOSE) console.log('⏳ Air alarm control throttled');
    return false;
  }
  Stove.lastAlarmSendMs = now;

  const j = {
    homeId: CONFIG.HOME_ID,
    target: 'AIRNODE',
    alarm: on ? 'on' : 'off',
  };
  if (mute_ms > 0) j.mute_ms = mute_ms;
  if (reason) j.reason = reason;

  client.publish(topic.control, JSON.stringify(j));
  if (CONFIG.LOG_VERBOSE) console.log('📣 CTRL→', topic.control, j);
  return true;
}

function stoveApplyControl(json) {
  // match target STOVENODE or deviceId (or ALL)
  const target = json.target;
  if (target && !(target === 'ALL' || target === 'STOVENODE' || target === Stove.deviceId)) return;

  let any = false;

  // Fan
  if (json.actions && typeof json.actions.fan === 'string') {
    const wantOn = json.actions.fan === 'on';
    any = true;
    if (stoveOverheated() && !wantOn) {
      Stove.fanOn = true;
      stovePublishEvent('FAN_REMOTE_DENIED', 'off', 'unsafe_overheat');
    } else {
      Stove.fanOn = wantOn;
      stovePublishEvent('FAN_REMOTE', wantOn ? 'on' : 'off');
    }
  }
  if (typeof json.fanOn === 'boolean') {
    const wantOn = json.fanOn;
    any = true;
    if (stoveOverheated() && !wantOn) {
      Stove.fanOn = true;
      stovePublishEvent('FAN_REMOTE_DENIED', 'off', 'unsafe_overheat');
    } else {
      Stove.fanOn = wantOn;
      stovePublishEvent('FAN_REMOTE', wantOn ? 'on' : 'off');
    }
  }

  // Valve
  if (json.actions && (json.actions.valve === 'open' || json.actions.valve === 'close')) {
    any = true;
    if (json.actions.valve === 'open') {
      if (stoveCooled()) {
        Stove.fanOn = false;
        stoveTryOpenValve();
        stovePublishEvent('VALVE_REMOTE', 'open');
      } else {
        stoveCloseValveLock();
        stovePublishEvent('VALVE_REMOTE_DENIED', 'open', 'unsafe_overheat');
        // nudge Air alarm ON
        publishAirAlarm(true, 0, 'REMOTE_OPEN_DENIED_OVERHEAT');
      }
    } else {
      stoveCloseValveLock();
      stovePublishEvent('VALVE_REMOTE', 'close');
    }
  }

  // Convenience direct flags (open/close)
  if (json.open === true) {
    any = true;
    if (stoveCooled()) {
      Stove.fanOn = false;
      stoveTryOpenValve();
      stovePublishEvent('VALVE_REMOTE', 'open');
    } else {
      stoveCloseValveLock();
      stovePublishEvent('VALVE_REMOTE_DENIED', 'open', 'unsafe_overheat');
      publishAirAlarm(true, 0, 'REMOTE_OPEN_DENIED_OVERHEAT');
    }
  }
  if (json.close === true) {
    any = true;
    stoveCloseValveLock();
    stovePublishEvent('VALVE_REMOTE', 'close');
  }

  if (any) stoveSendStatus();
}

// ---------------- MQTT wiring ----------------
client.on('connect', () => {
  console.log('✅ MQTT connected', CONFIG.MQTT_SERVER);
  client.subscribe(topic.control, { qos: 0 }, (err) => {
    if (err) console.error('subscribe error:', err.message);
    else if (CONFIG.LOG_VERBOSE) console.log('📡 subscribed', topic.control);
  });

  // BOOT events
  simPublishEvent({
    ts: tNowISO(),
    homeId: CONFIG.HOME_ID,
    deviceId: Air.deviceId,
    type: 'BOOT',
    detail: { fw: 'airnode-sim-1.0', tls: 'insecure' },
  });
  simPublishEvent({
    ts: tNowISO(),
    homeId: CONFIG.HOME_ID,
    from: Stove.deviceId,
    type: 'BOOT',
    detail: { fw: 'stovenode-sim-1.0', tls: 'insecure' },
  });

  client.publish(topic.status, JSON.stringify({ device: Stove.deviceId, status: 'online' }));
});

client.on('message', (t, buf) => {
  if (t !== topic.control) return;
  let json;
  try { json = JSON.parse(buf.toString()); }
  catch { if (CONFIG.LOG_VERBOSE) console.warn('non-JSON control:', buf.toString()); return; }

  // Route control to both; each checks target/deviceId
  airApplyControl(json);
  stoveApplyControl(json);
});

client.on('error', (e) => console.error('MQTT error:', e.message));
client.on('reconnect', () => CONFIG.LOG_VERBOSE && console.log('… reconnecting …'));

// ---------------- Periodic loops ----------------
// Air telemetry loop
setInterval(() => {
  // Random walk around plausible ranges; you can force danger by bumping vars
  Air.co2 = jitter(Air.co2, 20, 400, 2500);
  Air.co  = jitter(Air.co,  2,  0, 150);
  Air.pm25 = jitter(Air.pm25, 3,  1, 300);
  Air.pm10 = jitter(Air.pm10, 3,  1, 400);
  Air.tC   = jitter(Air.tC, 0.2, 18, 50);
  Air.rh   = jitter(Air.rh, 0.5, 20, 80);

  // Update alarm state based on danger
  // airUpdateAlarmFromDanger();

  // Publish telemetry (includes alarmOn)
  airPublishTelemetry();
}, CONFIG.AIR_TELEMETRY_MS);

// Stove status + safety loop
setInterval(() => {
  // Simulate stove temp: drift slowly; if fanOn, cool faster
  const coolFactor = Stove.fanOn ? 3.0 : 1.0;
  Stove.tempC = jitter(Stove.tempC, 2.5 / coolFactor, 20, 500);

  const overheated = stoveOverheated();
  const cooled = stoveCooled();

  if (overheated) {
    Stove.valveClosed = true;
    Stove.valveLockout = true;
    Stove.fanOn = true;
    // trigger air alarm ON once
    if (!Stove.airAlarmRequested) {
      if (publishAirAlarm(true, 0, 'STOVE_OVERHEAT')) {
        Stove.airAlarmRequested = true;
        stovePublishEvent('AIRNODE_ALARM', 'on', 'stove_overheat');
      }
    }
  } else {
    // cooled side
    if (Stove.airAlarmRequested && cooled) {
      if (publishAirAlarm(false, 0, 'STOVE_COOL')) {
        Stove.airAlarmRequested = false;
        stovePublishEvent('AIRNODE_ALARM', 'off', 'stove_cooled');
      }
    }
  }

  stoveSendStatus();
}, CONFIG.STOVE_STATUS_MS);

// --------------- Helpers ---------------
function simPublishEvent(ev) {
  client.publish(topic.events, JSON.stringify(ev));
  if (CONFIG.LOG_VERBOSE) console.log('📰 EVENT→', ev);
}

// Graceful exit
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  client.publish(topic.status, JSON.stringify({ device: Stove.deviceId, status: 'offline' }));
  client.end(true, () => process.exit(0));
});
