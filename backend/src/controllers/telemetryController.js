const Telemetry = require('../models/Telemetry');
const { listTelemetry } = require('../services/telemetryService');
const { toCSV } = require("../utils/cvs.js");

exports.list = async (req, res, next) => {
  try {
    const { deviceId, homeId, stream, start, end, limit, page, pageSize, includeTotal } = req.query;
    const q = {};
    if (deviceId) q.deviceId = deviceId;
    if (homeId) q.homeId = homeId;
    if (stream) q.stream = stream;
    if (start || end) {
      q.ts = {};
      if (start) q.ts.$gte = new Date(start);
      if (end)   q.ts.$lte = new Date(end);
    }

    const { docs, page: pg, pageSize: ps } = await listTelemetry({
      user: req.user, q, limit, page, pageSize
    });

    // Optional total count (expensive on big collections)
    let total;
    if (includeTotal === '1' || includeTotal === 'true') {
      total = await Telemetry.countDocuments({
        ...q,
        ...(req.user?.role !== 'admin' ? { homeId: { $in: req.user?.homes || [] } } : {})
      });
      res.setHeader('X-Total-Count', String(total));
    }

    res.status(200).json({
      ok: true,
      count: docs.length,
      page: pg,
      pageSize: ps,
      total,
      data: docs
    });
  } catch (e) { next(e); }
};
exports.exportCSV = async (req, res, next) => {
  try {
    const { deviceId, homeId, stream, start, end, limit } = req.query;
    const q = {};
    if (deviceId) q.deviceId = deviceId;
    if (homeId) q.homeId = homeId;
    if (stream) q.stream = stream;

    if (start || end) {
      q.ts = {};
      if (start) q.ts.$gte = new Date(start);
      if (end)   q.ts.$lte = new Date(end);
    }

    const data = await listTelemetry({
      user: req.user,
      q,
      limit: limit || 1000
    });

    const csv = toCSV(data);
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="telemetry_${stamp}.csv"`);
    res.status(200).send(csv);
  } catch (e) { next(e); }
};
// GET /api/telemetry/latest/:deviceId
exports.latestForDevice = async (req, res, next) => {
  try {
    const { deviceId } = req.params;

    // Per-home scope: if not admin, restrict to user's homes
    const match = { deviceId };
    if (req.user?.role !== 'admin') {
      match.homeId = { $in: req.user?.homes || [] };
    }

    const doc = await Telemetry.findOne(match).sort({ ts: -1 }).lean();
    if (!doc) return res.status(404).json({ ok: false, message: 'No telemetry found' });
    res.status(200).json({ ok: true, data: doc });
  } catch (e) { next(e); }
};

// GET /api/telemetry/latest-per-device?stream=AIR&homeId=HOME123
exports.latestPerDevice = async (req, res, next) => {
  try {
    const { stream, homeId, limit } = req.query;

    const match = {};
    if (stream) match.stream = stream;
    if (homeId) match.homeId = homeId;

    // Per-home scope for non-admin
    if (req.user?.role !== 'admin') {
      match.homeId = { $in: req.user?.homes || [] };
    }

    const pipeline = [
      { $match: match },
      { $sort: { ts: -1 } },
      { $group: { _id: '$deviceId', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { deviceId: 1 } }
    ];
    if (limit) pipeline.push({ $limit: Math.max(1, Math.min(1000, Number(limit))) });

    const agg = await Telemetry.aggregate(pipeline);
    res.status(200).json({ ok: true, count: agg.length, data: agg });
  } catch (e) { next(e); }
};