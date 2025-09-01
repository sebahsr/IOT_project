// services/deviceControlService.js
// Publishes control commands to MQTT topics that the SIM listens to:
// -> shega/<HOME_ID>/control with { target, actions }.
//
// Mapping rules:
// - STOVENODE:
//    { fan: true|'on'|'off' }   -> actions.fan 'on'|'off'
//    { valve: 'open'|'close' }  -> actions.valve 'open'|'close'   (device enforces safe-open guards)
//    { cutoff: true }           -> actions.fan='on', actions.valve='close'
//    { durationSec: number }    -> pass-through (e.g., timed ventilation)
// - AIRNODE:
//    { buzzer: boolean }        -> actions.alarm 'on'|'off'
//    { alarm: 'on'|'off'|'auto' } -> pass-through
//
// NOTE: We publish per home: shega/<homeId>/control
//       The device will reject unsafe commands and emit CONTROL_DENIED events.

const Device = require('../models/Device');
const User = require('../models/User'); // used elsewhere in this file
const crypto = require('crypto');

// Lazy-load MQTT publisher from our mqttService (exports publish())
let mqttSvc;
function getMqtt() {
  if (mqttSvc) return mqttSvc;
  try {
    mqttSvc = require('./mqttService'); // <-- correct local path
  } catch {
    mqttSvc = null;
  }
  return mqttSvc;
}

function toOnOff(v) {
  if (typeof v === 'string') return v.toLowerCase() === 'on' ? 'on' : 'off';
  return v ? 'on' : 'off';
}

function buildActionsForStove(command = {}, lastCOppm /* optional if you add server guards */) {
  const actions = {};
  // cutoff -> immediate safe state
  if (command.cutoff) {
    actions.fan = 'on';
    actions.valve = 'close';
  }
  if (command.fan !== undefined) {
    actions.fan = toOnOff(command.fan);
  }
  if (command.valve !== undefined) {
    // Allow manual open/close; device will enforce safety (no auto-open device-side)
    const v = String(command.valve).toLowerCase();
    actions.valve = v === 'open' ? 'open' : 'close';
  }
  if (Number.isFinite(command.durationSec)) {
    actions.durationSec = Number(command.durationSec);
  }
  return actions;
}

function buildActionsForAir(command = {}) {
  const actions = {};
  if (command.alarm) {
    const v = String(command.alarm).toLowerCase(); // 'on'|'off'|'auto'
    if (v === 'on' || v === 'off' || v === 'auto') actions.alarm = v;
  }
  if (command.buzzer !== undefined) {
    actions.alarm = toOnOff(command.buzzer); // map boolean buzzer -> alarm on/off
  }
  // pass through optional pulse fields if you later support them on the device
  if (Number.isFinite(command.ms)) actions.ms = Number(command.ms);
  return actions;
}

/**
 * Send a control command to a device by its deviceId.
 * Publishes to: shega/<homeId>/control
 * Payload:
 * {
 *   ts, homeId, deviceId, target: 'AIRNODE'|'STOVENODE',
 *   actions: {...}, requestId, issuedBy?: {id,email}
 * }
 */
async function sendDeviceControl(deviceId, command = {}, issuedBy /* optional: { _id, email } */) {
  const device = await Device.findOne({ deviceId }).lean();
  console.log('Found device for control:', deviceId, device ? `(home ${device.homeId})` : '(not found)');
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

  const homeId = device.homeId;
  const target = device.type === 'AIRNODE' ? 'AIRNODE' : 'STOVENODE';
   console.log(`Preparing control for device ${deviceId} (type ${target}) in home ${homeId}`);
  // Build actions per device type
  const actions =
    target === 'STOVENODE' ? buildActionsForStove(command)
    : buildActionsForAir(command);
   console.log('Mapped actions:',  target === 'STOVENODE',command );
  // If no recognized actions, fail fast
  if (!actions || Object.keys(actions).length === 0) {
    const err = new Error('No valid actions for target device');
    err.status = 400;
    throw err;
  }

  const payload = {
    ts: new Date().toISOString(),
    requestId: crypto.randomUUID(),
    homeId,
    deviceId: device.deviceId,
    target,           // 'AIRNODE' | 'STOVENODE'
    actions,          // mapped actions
  };

  if (issuedBy && (issuedBy._id || issuedBy.id || issuedBy.email)) {
    payload.issuedBy = {
      id: String(issuedBy._id || issuedBy.id || ''),
      email: issuedBy.email || undefined,
    };
  }

  const topic = `shega/${homeId}/control`;

  // Minimal, focused log (only on command publish)
  console.log(
    `[MQTT→control] ${homeId} ${target} ${JSON.stringify(actions)}${payload.issuedBy ? ` by ${payload.issuedBy.email || payload.issuedBy.id}` : ''}`
  );

  await mqtt.publish(topic, payload); // mqttService.publish handles JSON/string

  return { ok: true, topic, payload };
}

/* ---------------- Existing admin helpers stay the same ---------------- */

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
        statusCounts: { $push: '$status' },
        lastSeenAt: { $max: '$lastSeenAt' }
      }
    },
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
  const distinctHomes = await Device.distinct('homeId', match);
  const totalHomes = distinctHomes.length;
  const homes = await Device.aggregate(pipeline).skip(skip).limit(Number(limit));

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
      deviceId: d.deviceId, name: d.name, type: d.type, status: d.status
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

async function getHomeDetail(homeId) {
  const devices = await Device.find({ homeId }).lean();
  const owners = await User.find({ homes: homeId }, { password: 0 }).lean();

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

async function getDevicesByHome(homeId, { status, type }) {
  const q = { homeId };
  if (status) q.status = status;
  if (type) q.type = type;
  const devices = await Device.find(q).populate('owner', '-password').lean();
  return devices;
}

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
  sendDeviceControl,
};
