const { publish } = require('../services/mqttService');
const sockets = require('../sockets');

const ALLOWED_STOVE = new Set(['fan', 'buzzer']);
const ALLOWED_AIR   = new Set(['fan']); // example: a relay/vent fan on AirNode

exports.send = async (req, res, next) => {
  try {
    const { device } = req; // from scope middleware
    const { command, value } = req.body;

    if (typeof command !== 'string') {
      const err = new Error('command is required (string)');
      err.status = 400; throw err;
    }
    if (![0,1,true,false].includes(value)) {
      const err = new Error('value must be boolean/0/1');
      err.status = 400; throw err;
    }
    const v = Number(value ? 1 : 0);

    // Choose topic by device type + allow listed commands
    let topic;
    if (device.type === 'STOVENODE') {
      if (!ALLOWED_STOVE.has(command)) {
        const err = new Error(`Unsupported command for STOVENODE. Allowed: ${[...ALLOWED_STOVE].join(', ')}`);
        err.status = 400; throw err;
      }
      topic = 'shega/stovenode/control';
    } else if (device.type === 'AIRNODE') {
      if (!ALLOWED_AIR.has(command)) {
        const err = new Error(`Unsupported command for AIRNODE. Allowed: ${[...ALLOWED_AIR].join(', ')}`);
        err.status = 400; throw err;
      }
      topic = 'shega/airnode/control';
    } else {
      const err = new Error(`Unknown device type: ${device.type}`);
      err.status = 400; throw err;
    }

    const payload = {
      homeId: device.homeId,
      deviceId: device.deviceId,
      command,
      value: v,
      ts: new Date().toISOString()
    };

    publish(topic, payload);
try { sockets.emitCommand(payload); } catch {}

    res.status(200).json({ ok: true, published: { topic, payload } });
  } catch (e) { next(e); }
};
