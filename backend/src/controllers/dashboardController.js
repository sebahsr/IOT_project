const Device = require('../models/Device');
const Telemetry = require('../models/Telemetry');
// controllers/adminController.js
const { validationResult } = require('express-validator');

const serv = require('../services/deviceControlService');

function handleValidation(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const err = new Error('Validation error');
    err.status = 400;
    err.details = errors.array();
    throw err;
  }
}

async function listHomes(req, res, next) {
  try {
    handleValidation(req);
    const { search, status, type, page, limit } = req.query;
    const result = await serv.getHomesOverview({ search, status, type, page, limit });
    res.json(result);
  } catch (e) {
    next(e);
  }
}

async function getHome(req, res, next) {
  try {
    handleValidation(req);
    const { homeId } = req.params;
    const result = await serv.getHomeDetail(homeId);
    if (!result) return res.status(404).json({ message: 'Home not found' });
    res.json(result);
  } catch (e) {
    next(e);
  }
}

async function listDevicesInHome(req, res, next) {
  try {
    handleValidation(req);
    const { homeId } = req.params;
    const { status, type } = req.query;
    const result = await serv.getDevicesByHome(homeId, { status, type });
    res.json({ homeId, devices: result });
  } catch (e) {
    next(e);
  }
}

async function getDevice(req, res, next) {
  try {
    handleValidation(req);
    const { deviceId } = req.params;
    const device = await serv.getDeviceDetail(deviceId);
    if (!device) return res.status(404).json({ message: 'Device not found' });
    res.json(device);
  } catch (e) {
    next(e);
  }
}

async function controlDevice(req, res, next) {
  try {
    console.log('controlDevice called');
    handleValidation(req);
    const { deviceId } = req.params;
    const command = req.body.actions|| {};

  
    const issuedBy = req.user ? { _id: req.user._id, email: req.user.email } : undefined;
    console.log('Issued by:', issuedBy);
    console.log('Control command:', command);
    const result = await serv.sendDeviceControl(deviceId, command, issuedBy);
    res.json(result);
  } catch (e) {
    console.error('Error controlling device:', e);
    next(e);
  }
}


/**
 * GET /api/dashboard/summary
 * User-scoped: aggregates devices the user can see (their homes or all if admin)
 * Returns counts by status/type + total devices + distinct homes
 */
const summary = async (req, res, next) => {
  try {
    const match = {};
    if (req.user?.role !== 'admin') {
      match.homeId = { $in: req.user?.homes || [] };
    }

    const agg = await Device.aggregate([
      { $match: match },
      {
        $facet: {
          totalDevices: [{ $count: 'count' }],
          devicesByStatus: [
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
          ],
          devicesByType: [
            { $group: { _id: '$type', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
          ],
          homes: [
            { $group: { _id: '$homeId', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
          ]
        }
      }
    ]);

    const first = agg[0] || {};
    const total = first.totalDevices?.[0]?.count || 0;
    res.status(200).json({
      ok: true,
      totalDevices: total,
      devicesByStatus: first.devicesByStatus || [],
      devicesByType: first.devicesByType || [],
      homes: (first.homes || []).map(h => ({ homeId: h._id, deviceCount: h.count }))
    });
  } catch (e) { next(e); }
};

/**
 * GET /api/dashboard/my-latest
 * Latest telemetry per device the user can access
 * Optional query: stream=AIR|STOVE, homeId=HOME123, limit=100
 */
const myLatestPerDevice = async (req, res, next) => {
  try {
    const { stream, homeId, limit } = req.query;

    const match = {};
    if (stream) match.stream = stream;

    // Per-home scoping
    if (req.user?.role !== 'admin') {
      match.homeId = { $in: req.user?.homes || [] };
    }
    if (homeId) {
      // Narrow further (still respects user homes)
      match.homeId = match.homeId ? { $all: [match.homeId, homeId] } : homeId;
    }

    const pipeline = [
      { $match: match },
      { $sort: { ts: -1 } },
      { $group: { _id: '$deviceId', doc: { $first: '$$ROOT' } } },
      {
        $lookup: {
          from: 'devices',
          localField: 'doc.deviceId',
          foreignField: 'deviceId',
          as: 'device'
        }
      },
      { $unwind: { path: '$device', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          deviceId: '$doc.deviceId',
          homeId: '$doc.homeId',
          stream: '$doc.stream',
          ts: '$doc.ts',
          payload: '$doc.payload',
          device: {
            deviceId: '$device.deviceId',
            type: '$device.type',
            status: '$device.status',
            name: '$device.name',
            location: '$device.location',
            lastSeenAt: '$device.lastSeenAt'
          }
        }
      },
      { $sort: { deviceId: 1 } }
    ];
    if (limit) pipeline.push({ $limit: Math.max(1, Math.min(1000, Number(limit))) });

    const data = await Telemetry.aggregate(pipeline);
    res.status(200).json({ ok: true, count: data.length, data });
  } catch (e) { next(e); }
};
module.exports = {
  listHomes,
  getHome,
  listDevicesInHome,
  getDevice,
  controlDevice,
  myLatestPerDevice,
  summary
};
