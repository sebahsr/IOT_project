// Simple per-home volatile state for the *latest* sample per device
// and quick status counts for  StatusDonut.

const homes = new Map(); // homeId -> { devices: Map, statusCounts, updatedAt }

function getOrInitHome(homeId) {
  if (!homes.has(homeId)) {
    homes.set(homeId, { devices: new Map(), statusCounts: { OK: 0, WARN: 0, DANGER: 0, UNKNOWN: 0 }, updatedAt: Date.now() });
  }
  return homes.get(homeId);
}

function classifyStatus(p = {}) {
  // Mirror  alert thresholds; keep consistent with maybePublishAlerts()
  // Return 'OK'|'WARN'|'DANGER'|'UNKNOWN'
  let worst = 'OK';
  const bump = (lvl) => {
    const order = { OK: 0, WARN: 1, DANGER: 2, UNKNOWN: 0 };
    if (order[lvl] > order[worst]) worst = lvl;
  };

  if (isNum(p.co2)) {
    if (p.co2 > 1500) bump('DANGER'); else if (p.co2 > 1000) bump('WARN');
  }
  if (isNum(p.co)) {
    if (p.co > 35) bump('DANGER'); // CO is danger-only above 35 in  logic
  }
  if (isNum(p.pm25)) {
    if (p.pm25 > 100) bump('DANGER'); else if (p.pm25 > 35) bump('WARN');
  }
  if (isNum(p.stove_temp_c)) {
    if (p.stove_temp_c > 250) bump('DANGER');
  }

  // If nothing present, unknown
  if (!isNum(p.co2) && !isNum(p.co) && !isNum(p.pm25) && !isNum(p.pm10) && !isNum(p.stove_temp_c)) {
    bump('UNKNOWN');
  }
  return worst;
}

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

// Map normalized payload → Device.metadata keys  gauges expect
function payloadToMetadata(p = {}) {
  return {
    co2: isNum(p.co2) ? p.co2 : undefined,
    co: isNum(p.co) ? p.co : undefined,
    pm25: isNum(p.pm25) ? p.pm25 : undefined,
    pm10: isNum(p.pm10) ? p.pm10 : undefined,
    temp: isNum(p.temperature_c) ? p.temperature_c : undefined,
    humidity: isNum(p.humidity_pct) ? p.humidity_pct : undefined,
    pressure: isNum(p.pressure_hpa) ? p.pressure_hpa : undefined, // optional
  };
}

function recomputeCounts(home) {
  const counts = { OK: 0, WARN: 0, DANGER: 0, UNKNOWN: 0 };
  for (const d of home.devices.values()) counts[d.status] = (counts[d.status] || 0) + 1;
  home.statusCounts = counts;
}

function setTelemetry(doc) {
  // doc: { homeId, deviceId, stream, ts, payload }
  const home = getOrInitHome(doc.homeId);
  const d = home.devices.get(doc.deviceId) || {
    deviceId: doc.deviceId,
    type: doc.stream === 'STOVE' ? 'STOVENODE' : 'AIRNODE',
    metadata: {},
    lastTs: null,
    status: 'UNKNOWN',
  };

  // Update metadata and classify
  const mdPatch = payloadToMetadata(doc.payload);
  d.metadata = { ...d.metadata, ...mdPatch };

  d.lastTs = new Date().toISOString();
    console.log("time",d.lastTs,doc.ts)
  d.type = doc.stream === 'STOVE' ? 'STOVENODE' : 'AIRNODE';
  d.status = classifyStatus(doc.payload);

  home.devices.set(doc.deviceId, d);
  home.updatedAt = Date.now();
  recomputeCounts(home);

  return { device: d, statusCounts: home.statusCounts };
}

// Snapshot shape compatible with  HomeDetailClient expectation
function getHomeSnapshot(homeId) {
  const home = getOrInitHome(homeId);
  const devices = Array.from(home.devices.values());
  const byTypeCounts = {
    AIRNODE: devices.filter(d => d.type === 'AIRNODE').length,
    STOVENODE: devices.filter(d => d.type === 'STOVENODE').length,
  };
  return {
    homeId,
    totalDevices: devices.length,
    devices,
    byTypeCounts,
    statusCounts: home.statusCounts,
    owners: [], // up to you to populate elsewhere
    updatedAt: home.updatedAt,
  };
}

function getAdminSnapshot() {
  const allHomes = [];
  for (const [homeId] of homes) allHomes.push(getHomeSnapshot(homeId));
  return allHomes;
}

module.exports = { setTelemetry, getHomeSnapshot, getAdminSnapshot };
