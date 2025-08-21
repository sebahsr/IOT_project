const Telemetry = require('../models/Telemetry');

async function saveTelemetry({ homeId, deviceId, stream, payload, ts, deviceRef }) {
  if (!homeId || !deviceId || !stream || !payload) {
    const err = new Error('Missing telemetry fields (homeId, deviceId, stream, payload)');
    err.status = 400;
    throw err;
  }

  const doc = await Telemetry.create({
    homeId,
    deviceId,
    stream,
    payload,
    ts: ts ? new Date(ts) : new Date(),
    device: deviceRef || undefined
  });

  return doc;
}

async function listTelemetry({ user, q = {} , limit = 100, since, page = 1, pageSize = 10 }) {
  // per-user filtering: admin sees all, user limited to their homes
  const query = { ...q };
  if (user?.role !== 'admin') {
    query.homeId = { $in: user?.homes || [] };
  }
  if (since) {
    query.ts = { $gte: new Date(since) };
  }

  // pagination
  const ps = Math.max(1, Math.min(1000, Number(pageSize || limit) || 100));
  const pg = Math.max(1, Number(page) || 1);
  const skip = (pg - 1) * ps;

  const docs = await Telemetry.find(query)
    .sort({ ts: -1 })
    .skip(skip)
    .limit(ps)
    .lean();

  return { docs, page: pg, pageSize: ps };
}

module.exports = { saveTelemetry, listTelemetry };
