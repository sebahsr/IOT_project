// services/deviceControlService.js
// Publishes control commands to MQTT topics based on device type.
// Assumes you already have an MQTT module that exposes `publish(topic, payload)`.
const Device = require('../models/Device');
const User = require('../models/User');
let mqttPublisher;

// Lazy require to avoid circular deps if needed:
function getMqtt() {
  if (mqttPublisher) return mqttPublisher;
  try {
    // Example: your mqtt service exports publish()
    mqttPublisher = require('../mqtt'); // adjust to your actual path/export
  } catch {
    mqttPublisher = null;
  }
  return mqttPublisher;
}

/**
 * Send a control command to a device.
 * For AIRNODE: e.g., set fan, sound buzzer, etc.
 * For STOVENODE: e.g., fan on/off, buzzer on/off, safety cutoff.
 * The topic convention here: "shega/<lowerType>/control".
 */
async function sendDeviceControl(deviceId, command) {
  const device = await Device.findOne({ deviceId }).lean();
  if (!device) {
    const err = new Error('Device not found');
    err.status = 404;
    throw err;
  }

  const mqtt = getMqtt();
  if (!mqtt || typeof mqtt.publish !== 'function') {
    const err = new Error('MQTT publisher not available');
    err.status = 500;
    throw err;
  }

  const lowerType = device.type.toLowerCase(); // 'airnode' | 'stovenode'
  const topic = `shega/${lowerType}/control`;

  const payload = {
    deviceId: device.deviceId,
    homeId: device.homeId,
    command, // e.g. { fan: "on" } or { buzzer: true }
    ts: new Date().toISOString()
  };

  // Fire-and-forget
  await mqtt.publish(topic, JSON.stringify(payload));

  return { ok: true, topic, payload };
}
// services/adminService.js


/**
 * Get a paginated overview of households (grouped by homeId) with device counts and owners.
 * Supports search (by homeId), filter by device status/type, and pagination.
 */
async function getHomesOverview({ search = '', status, type, page = 1, limit = 10 }) {
  const match = {};
  if (search) match.homeId = { $regex: new RegExp(search, 'i') };
  if (status) match.status = status;
  if (type) match.type = type;

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: '$homeId',
        homeId: { $first: '$homeId' },
        totalDevices: { $sum: 1 },
        byType: {
          $push: { type: '$type', status: '$status', deviceId: '$deviceId', name: '$name', owner: '$owner' }
        },
        statusCounts: {
          $push: '$status'
        },
        lastSeenAt: { $max: '$lastSeenAt' }
      }
    },
    // Expand status counts into an object
    {
      $addFields: {
        statusCountObj: {
          $arrayToObject: {
            $map: {
              input: { $setUnion: ['$statusCounts', []] },
              as: 'st',
              in: [
                '$$st',
                {
                  $size: {
                    $filter: { input: '$statusCounts', as: 's', cond: { $eq: ['$$s', '$$st'] } }
                  }
                }
              ]
            }
          }
        }
      }
    },
    { $sort: { homeId: 1 } }
  ];

  const skip = (Number(page) - 1) * Number(limit);

  // Get total distinct homes count for pagination
  const distinctHomes = await Device.distinct('homeId', match);
  const totalHomes = distinctHomes.length;

  const homes = await Device.aggregate(pipeline).skip(skip).limit(Number(limit));

  // Attach owners per home (users whose "homes" contains this homeId)
  const homeIds = homes.map(h => h.homeId);
  const users = await User.find({ homes: { $in: homeIds } }, { password: 0 }).lean();

  const ownersByHome = {};
  users.forEach(u => {
    (u.homes || []).forEach(h => {
      ownersByHome[h] = ownersByHome[h] || [];
      ownersByHome[h].push({ _id: u._id, name: u.name, email: u.email, role: u.role });
    });
  });

  const results = homes.map(h => ({
    homeId: h.homeId,
    totalDevices: h.totalDevices,
    statusCounts: h.statusCountObj || {},
    lastSeenAt: h.lastSeenAt || null,
    devices: h.byType.map(d => ({
      deviceId: d.deviceId,
      name: d.name,
      type: d.type,
      status: d.status
    })),
    owners: ownersByHome[h.homeId] || []
  }));

  return {
    page: Number(page),
    limit: Number(limit),
    total: totalHomes,
    totalPages: Math.ceil(totalHomes / Number(limit)) || 1,
    homes: results
  };
}

/** Get full detail of a specific household (devices + owners). */
async function getHomeDetail(homeId) {
  const devices = await Device.find({ homeId }).lean();
  const owners = await User.find({ homes: homeId }, { password: 0 }).lean();

  // quick counts
  const statusCounts = devices.reduce((acc, d) => {
    acc[d.status] = (acc[d.status] || 0) + 1;
    return acc;
  }, {});

  const byTypeCounts = devices.reduce((acc, d) => {
    acc[d.type] = (acc[d.type] || 0) + 1;
    return acc;
  }, {});

  return {
    homeId,
    totalDevices: devices.length,
    statusCounts,
    byTypeCounts,
    lastSeenAt: devices.reduce((max, d) => (!max || (d.lastSeenAt && d.lastSeenAt > max) ? d.lastSeenAt : max), null),
    devices: devices.map(d => ({
      _id: d._id,
      deviceId: d.deviceId,
      type: d.type,
      name: d.name,
      location: d.location,
      status: d.status,
      lastSeenAt: d.lastSeenAt,
      owner: d.owner,
      firmware: d.firmware,
      metadata: d.metadata
    })),
    owners: owners.map(u => ({ _id: u._id, name: u.name, email: u.email, role: u.role }))
  };
}

/** List devices for a household with optional filters. */
async function getDevicesByHome(homeId, { status, type }) {
  const q = { homeId };
  if (status) q.status = status;
  if (type) q.type = type;
  const devices = await Device.find(q).populate('owner', '-password').lean();
  return devices;
}

/** Device detail with populated owner. */
async function getDeviceDetail(deviceId) {
  const device = await Device.findOne({ deviceId }).populate('owner', '-password').lean();
  if (!device) return null;
  return device;
}

module.exports = {
  getHomesOverview,
  getHomeDetail,
  getDevicesByHome,
  getDeviceDetail,
  sendDeviceControl
};
