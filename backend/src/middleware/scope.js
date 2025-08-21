const Device = require('../models/Device');

// Loads the device by :deviceId and checks the user can access it.
// Admin → any device. User → only devices in their homes.
exports.authorizeDeviceParam = async (req, res, next) => {
  try {
    const { deviceId } = req.params;
    const q = { deviceId };
    if (req.user?.role !== 'admin') {
      q.homeId = { $in: req.user?.homes || [] };
    }
    const device = await Device.findOne(q).lean();
    if (!device) {
      const err = new Error('Device not found or not accessible');
      err.status = 404;
      throw err;
    }
    req.device = device; // attach for handlers
    next();
  } catch (e) { next(e); }
};
