#!/usr/bin/env node
/**
 * SHEGA multi-home simulator
 * - Simulates N homes, each with AirNode + StoveNode
 * - Publishes every minute (configurable) realistic Ethiopian cooking profiles
 * - Reacts to fan control messages on shega/stovenode/control/<deviceId>
 */
const mqtt = require("mqtt");
const { v4: uuidv4 } = require("uuid");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

// -------------------- CLI --------------------
const argv = yargs(hideBin(process.argv))
  .option("broker", { type: "string", default: "mqtt://localhost:1883", describe: "MQTT broker URL" })
  .option("homes", { type: "number", default: 3, describe: "Number of homes to simulate" })
  .option("interval", { type: "number", default: 60000, describe: "Publish interval in ms (60000 = 1 min)" })
  .option("qos", { type: "number", default: 0, describe: "MQTT QoS for publishes" })
  .option("retain", { type: "boolean", default: false, describe: "Retain messages" })
  .option("fast", { type: "boolean", default: false, describe: "Accelerate time (5s interval override)" })
  .strict()
  .help()
  .argv;

const INTERVAL_MS = argv.fast ? 5000 : argv.interval;
const BROKER_URL  = argv.broker;
const HOUSES      = argv.homes;
const PUB_OPTS    = { qos: argv.qos, retain: argv.retain };

// -------------------- Topics --------------------
const TOPIC_AIRDATA   = "shega/airnode/data";
const TOPIC_STOVE     = "shega/stovenode/status";
const TOPIC_CTRL_BASE = "shega/stovenode/control"; // control/<deviceId>
const TOPIC_ALERTS    = "shega/alerts";
const TOPIC_LWT       = "shega/device/availability"; // availability <deviceId>

// -------------------- Thresholds (example) --------------------
const THRESH = {
  CO2_PPM: { warn: 1000, danger: 1500 },
  CO_PPM:  { warn: 15,   danger: 35   },   // OSHA-ish short exposure
  PM25:    { warn: 35,   danger: 100  },   // µg/m3
  STOVE_C: { warn: 180,  danger: 250  },
};

// -------------------- Cooking Profiles --------------------
// Each profile returns deltas/targets over one tick; we also include durations to auto-rotate.
const PROFILES = {
  idle: {
    label: "Idle / No cooking",
    minMins: 15, maxMins: 45,
    effect: (s) => ({
      // drift back to baseline
      co2: approach(s.env.co2, s.baseline.co2, 0.1) - s.env.co2,
      co:  approach(s.env.co,  s.baseline.co,  0.2) - s.env.co,
      pm25: approach(s.env.pm25, s.baseline.pm25, 0.25) - s.env.pm25,
      pm10: approach(s.env.pm10, s.baseline.pm10, 0.25) - s.env.pm10,
      temp: approach(s.env.temp, s.baseline.temp, 0.15) - s.env.temp,
      hum:  approach(s.env.hum,  s.baseline.hum,  0.10) - s.env.hum,
      stove: approach(s.stove.tempC, 35, 0.2) - s.stove.tempC
    })
  },
  injera: {
    label: "Injera baking (mitad)",
    minMins: 20, maxMins: 35,
    effect: (s) => spikeEffect(s, {
      stoveTarget: 240,  // surface plate
      co2Boost: [80, 140],
      coBoost:  [2, 6],
      pm25Boost:[30, 80],
      pm10Boost:[40, 120],
      tempBoost:[0.3, 0.8],
      humBoost: [-0.3, 0.2],
    })
  },
  coffee: {
    label: "Coffee ceremony (roasting + brewing)",
    minMins: 12, maxMins: 25,
    effect: (s) => spikeEffect(s, {
      stoveTarget: 180,
      co2Boost: [30, 60],
      coBoost:  [4, 10],
      pm25Boost:[60, 120], // roasting smoke spike
      pm10Boost:[30, 60],
      tempBoost:[0.2, 0.5],
      humBoost: [0.2, 0.7],
    })
  },
  wat: {
    label: "Wat simmer (stew)",
    minMins: 30, maxMins: 60,
    effect: (s) => spikeEffect(s, {
      stoveTarget: 120,
      co2Boost: [50, 90],
      coBoost:  [1, 3],
      pm25Boost:[10, 25],
      pm10Boost:[8, 18],
      tempBoost:[0.1, 0.3],
      humBoost: [0.6, 1.4],
    })
  },
  tibs: {
    label: "Tibs / frying",
    minMins: 10, maxMins: 25,
    effect: (s) => spikeEffect(s, {
      stoveTarget: 200,
      co2Boost: [40, 80],
      coBoost:  [2, 5],
      pm25Boost:[40, 100],
      pm10Boost:[30, 70],
      tempBoost:[0.2, 0.5],
      humBoost: [-0.2, 0.2],
    })
  }
};

// Helper for profile effect
function spikeEffect(state, cfg) {
  const v = (min, max) => min + Math.random() * (max - min);
  const vent = state.stove.fanOn ? 0.5 : 1.0; // fan reduces pollutants
  const windowFactor = state.env.windowOpen ? 0.7 : 1.0;
  const loss = vent * windowFactor;

  return {
    co2: v(cfg.co2Boost[0], cfg.co2Boost[1]) * loss - decayToward(state.env.co2, state.baseline.co2, 0.05),
    co:  v(cfg.coBoost[0],  cfg.coBoost[1])  * loss - decayToward(state.env.co,  state.baseline.co,  0.08),
    pm25:v(cfg.pm25Boost[0],cfg.pm25Boost[1])* loss - decayToward(state.env.pm25,state.baseline.pm25,0.1),
    pm10:v(cfg.pm10Boost[0],cfg.pm10Boost[1])* loss - decayToward(state.env.pm10,state.baseline.pm10,0.1),
    temp:v(cfg.tempBoost[0],cfg.tempBoost[1]) - decayToward(state.env.temp,state.baseline.temp,0.05),
    hum: v(cfg.humBoost[0], cfg.humBoost[1])  - decayToward(state.env.hum, state.baseline.hum, 0.05),
    stove: approach(state.stove.tempC, cfg.stoveTarget, 0.25) - state.stove.tempC
  };
}

// -------------------- Utilities --------------------
function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)); }
function rndn(mean, std){ return mean + std * (Math.random()*2 - 1); }
function approach(current, target, rate){
  // move a fraction toward target
  return current + (target - current) * clamp(rate, 0, 1);
}
function decayToward(current, baseline, rate){
  return (current - baseline) * rate;
}
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function minsToMs(m){ return m*60000; }

// -------------------- Device Model --------------------
class Home {
  constructor(idx){
    this.homeId = `HOME_${String(idx+1).padStart(2,"0")}`;
    // Baseline indoor conditions per home (slight variation)
    this.baseline = {
      co2: rndn(700, 80), // ppm
      co:  rndn(1.2, 0.8),// ppm
      pm25:rndn(8, 5),    // µg/m3
      pm10:rndn(12, 6),   // µg/m3
      temp:rndn(23, 2),   // °C
      hum: rndn(45, 8)    // %
    };
    this.env = {...this.baseline, windowOpen: Math.random()<0.2};
    this.airNode = new AirNode(this);
    this.stoveNode = new StoveNode(this);
    this.currentProfile = null;
    this.profileEndsAt = 0;
  }
  tick(now){
    // Rotate cooking profiles smartly
    if (!this.currentProfile || now >= this.profileEndsAt){
      const choices = [
        PROFILES.idle, PROFILES.idle,
        PROFILES.injera, PROFILES.coffee, PROFILES.wat, PROFILES.tibs
      ];
      this.currentProfile = pick(choices);
      const durMin = randInt(this.currentProfile.minMins, this.currentProfile.maxMins);
      this.profileEndsAt = now + minsToMs(durMin);
    }

    // Randomly toggle window sometimes
    if (Math.random() < 0.02){ this.env.windowOpen = !this.env.windowOpen; }

    // Apply profile effect
    const eff = this.currentProfile.effect(this.getState());
    this.env.co2  = clamp(this.env.co2  + eff.co2  + rndn(0,2), 400, 5000);
    this.env.co   = clamp(this.env.co   + eff.co   + rndn(0,0.5), 0, 200);
    this.env.pm25 = clamp(this.env.pm25 + eff.pm25 + rndn(0,2), 0, 1000);
    this.env.pm10 = clamp(this.env.pm10 + eff.pm10 + rndn(0,3), 0, 1500);
    this.env.temp = clamp(this.env.temp + eff.temp + rndn(0,0.2), 10, 45);
    this.env.hum  = clamp(this.env.hum  + eff.hum  + rndn(0,0.4), 15, 90);

    this.stoveNode.tempC = clamp(this.stoveNode.tempC + eff.stove + rndn(0,0.7), 20, 350);

    // Safety: if stove too hot for long, auto-enable fan occasionally
    if (this.stoveNode.tempC > THRESH.STOVE_C.warn && Math.random()<0.1){ this.stoveNode.fanOn = true; }

    this.airNode.tick(now);
    this.stoveNode.tick(now);
  }
  getState(){
    return {
      baseline: this.baseline,
      env: this.env,
      stove: { tempC: this.stoveNode.tempC, fanOn: this.stoveNode.fanOn }
    };
  }
}

class AirNode {
  constructor(home){
    this.home = home;
    this.deviceId = `AIR_${home.homeId}`;
    this.lastSent = 0;
  }
  payload(now){
    const e = this.home.env;
    return {
      ts: new Date(now).toISOString(),
      homeId: this.home.homeId,
      deviceId: this.deviceId,
      profile: this.home.currentProfile?.label || "Unknown",
      temperature_c: round2(e.temp),
      humidity_pct: round2(e.hum),
      co2_ppm: Math.round(e.co2),
      co_ppm: round2(e.co),
      pm25_ugm3: Math.round(e.pm25),
      pm10_ugm3: Math.round(e.pm10),
      windowOpen: !!e.windowOpen
    };
  }
  tick(now){
    if (now - this.lastSent >= INTERVAL_MS){
      this.lastSent = now;
      publishJSON(TOPIC_AIRDATA, this.payload(now));
      // Alerts
      const e = this.home.env;
      if (e.co2 >= THRESH.CO2_PPM.danger) alert(this.home, "CO₂_DANGER", `CO₂ ${Math.round(e.co2)} ppm`);
      else if (e.co2 >= THRESH.CO2_PPM.warn) alert(this.home, "CO₂_WARN", `CO₂ ${Math.round(e.co2)} ppm`);

      if (e.co >= THRESH.CO_PPM.danger) alert(this.home, "CO_DANGER", `CO ${round2(e.co)} ppm`);
      else if (e.co >= THRESH.CO_PPM.warn) alert(this.home, "CO_WARN", `CO ${round2(e.co)} ppm`);

      if (e.pm25 >= THRESH.PM25.danger) alert(this.home, "SMOKE_DANGER", `PM2.5 ${Math.round(e.pm25)} µg/m³`);
      else if (e.pm25 >= THRESH.PM25.warn) alert(this.home, "SMOKE_WARN", `PM2.5 ${Math.round(e.pm25)} µg/m³`);
    }
  }
}

class StoveNode {
  constructor(home){
    this.home = home;
    this.deviceId = `STOVE_${home.homeId}`;
    this.tempC = rndn(35, 3);
    this.fanOn = Math.random() < 0.1;
    this.buzzerOn = false;
    this.lastSent = 0;
  }
  payload(now){
    return {
      ts: new Date(now).toISOString(),
      homeId: this.home.homeId,
      deviceId: this.deviceId,
      profile: this.home.currentProfile?.label || "Unknown",
      stove_temp_c: round1(this.tempC),
      fanOn: this.fanOn,
      buzzerOn: this.buzzerOn
    };
  }
  tick(now){
    // Simple safety logic: trigger buzzer if too hot or CO danger
    const tooHot = this.tempC >= THRESH.STOVE_C.danger;
    const highCO = this.home.env.co >= THRESH.CO_PPM.danger;
    this.buzzerOn = tooHot || highCO;

    // When fan is on, accelerate pollutant decay a bit (handled in profile via loss factor)

    if (now - this.lastSent >= INTERVAL_MS){
      this.lastSent = now;
      publishJSON(TOPIC_STOVE, this.payload(now));
    }
  }
}

// -------------------- MQTT Connection --------------------
const clientId = `shega-sim-${uuidv4().slice(0,8)}`;
const mqttClient = mqtt.connect(BROKER_URL, {
  clientId,
  will: { topic: TOPIC_LWT, qos: 0, retain: false, payload: JSON.stringify({ clientId, status: "offline" }) }
});

mqttClient.on("connect", () => {
  console.log(`[MQTT] Connected: ${BROKER_URL} as ${clientId}`);
  mqttClient.publish(TOPIC_LWT, JSON.stringify({ clientId, status: "online" }), { qos: 0, retain: false });
  // Subscribe to all stove control topics
  mqttClient.subscribe(`${TOPIC_CTRL_BASE}/+`, { qos: 0 });
});

mqttClient.on("message", (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    const parts = topic.split("/");
    const targetId = parts[parts.length - 1]; // control/<deviceId>
    if (!targetId) return;

    const stove = ST.populatedStoves.get(targetId);
    if (!stove) return;

    if (typeof payload.fanOn === "boolean") {
      stove.fanOn = payload.fanOn;
      console.log(`[CTRL] ${targetId} fan => ${stove.fanOn}`);
    }
    if (typeof payload.buzzerOn === "boolean") {
      stove.buzzerOn = payload.buzzerOn;
      console.log(`[CTRL] ${targetId} buzzer => ${stove.buzzerOn}`);
    }
  } catch(e){
    console.warn("[CTRL] Bad control payload:", e.message);
  }
});

mqttClient.on("error", (err) => console.error("[MQTT] Error:", err?.message || err));
mqttClient.on("reconnect", () => console.log("[MQTT] Reconnecting..."));

// Publish helper
function publishJSON(topic, obj){
  mqttClient.publish(topic, JSON.stringify(obj), PUB_OPTS);
  // Tiny console trace:
  console.log(`${new Date().toISOString()} → ${topic} :: ${summ(obj)}`);
}

function alert(home, type, message){
  const payload = {
    ts: new Date().toISOString(),
    homeId: home.homeId,
    type,
    message
  };
  mqttClient.publish(TOPIC_ALERTS, JSON.stringify(payload), { qos: 0, retain: false });
  console.log(`ALERT [${type}] ${home.homeId}: ${message}`);
}

function round1(x){ return Math.round(x*10)/10; }
function round2(x){ return Math.round(x*100)/100; }
function randInt(a,b){ return a + Math.floor(Math.random()*(b-a+1)); }
function summ(o){
  // compact one-liner for logs
  if (o.co2_ppm) return `${o.homeId}/${o.deviceId} CO2:${o.co2_ppm}ppm CO:${o.co_ppm}ppm PM2.5:${o.pm25_ugm3}µg/m³ Temp:${o.temperature_c}°C`;
  if (o.stove_temp_c!==undefined) return `${o.homeId}/${o.deviceId} Stove:${o.stove_temp_c}°C Fan:${o.fanOn?"on":"off"} Buzz:${o.buzzerOn?"on":"off"}`;
  return `${o.homeId} ${o.deviceId||""}`;
}

// -------------------- Orchestrator --------------------
const ST = {
  homes: [],
  populatedStoves: new Map(),
};

function buildHomes(){
  for (let i=0;i<HOUSES;i++){
    const h = new Home(i);
    ST.homes.push(h);
    ST.populatedStoves.set(h.stoveNode.deviceId, h.stoveNode);
  }
}

function loop(){
  const now = Date.now();
  ST.homes.forEach(h => h.tick(now));
}

// Kickoff
buildHomes();
console.log(`Simulating ${HOUSES} homes (each with AirNode + StoveNode), interval=${INTERVAL_MS}ms`);
setInterval(loop, 1000); // internal physics tick @1s for smoother dynamics
