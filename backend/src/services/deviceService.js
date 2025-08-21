const Device = require('../models/Device');
const User = require('../models/User');

function inferTypeFromStream(stream) {
  if (stream === 'AIR') return 'AIRNODE';
  if (stream === 'STOVE') return 'STOVENODE';
  return undefined;
}

async function upsertFromIngest({ homeId, deviceId, stream, metadata }) {
  const type = inferTypeFromStream(stream);
  const update = {
    homeId,
    type,
    status: 'online',
    lastSeenAt: new Date(),
  };
  if (metadata) update.$set = { metadata };

  const device = await Device.findOneAndUpdate(
    { deviceId },
    update,
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return device;
}

async function listForUser(user) {
  const q = {};
  if (user?.role !== 'admin') {
    q.homeId = { $in: user?.homes || [] };
  }
  return Device.find(q).sort({ updatedAt: -1 }).lean();
}

async function getByDeviceIdForUser(deviceId, user) {
  const q = { deviceId };
  if (user?.role !== 'admin') {
    q.homeId = { $in: user?.homes || [] };
  }
  return Device.findOne(q).lean();
}
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
  upsertFromIngest, listForUser, getByDeviceIdForUser };
