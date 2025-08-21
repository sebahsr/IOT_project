const Device = require('../models/Device');
const Telemetry = require('../models/Telemetry');

/**
 * GET /api/admin/overview
 * Admin-only: global counts, latest telemetry timestamp, top homes by device count
 */
exports.overview = async (req, res, next) => {
  try {
    const deviceAgg = await Device.aggregate([
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
            { $sort: { count: -1 } },
            { $limit: 50 }
          ]
        }
      }
    ]);

    const totalDevices = deviceAgg[0]?.totalDevices?.[0]?.count || 0;
    const devicesByStatus = deviceAgg[0]?.devicesByStatus || [];
    const devicesByType = deviceAgg[0]?.devicesByType || [];
    const homes = deviceAgg[0]?.homes?.map(h => ({ homeId: h._id, deviceCount: h.count })) || [];

    // latest telemetry ts and total telemetry docs
    const latestTelemetry = await Telemetry.findOne().sort({ ts: -1 }).lean();
    const teleCountAgg = await Telemetry.aggregate([{ $count: 'count' }]);
    const totalTelemetry = teleCountAgg[0]?.count || 0;

    res.status(200).json({
      ok: true,
      totals: {
        devices: totalDevices,
        telemetry: totalTelemetry
      },
      latestTelemetryTs: latestTelemetry?.ts || null,
      devicesByStatus,
      devicesByType,
      topHomes: homes
    });
  } catch (e) { next(e); }
};

/** POST /api/admin/addUsers */
exports.addUser = async (req, res, next) => {
  try {
    const { email, name, role, homes } = req.body;
    const user = new User({ email, name, role, homes });
    await user.save();
    res.status(201).json({ ok: true, user });
  } catch (e) {
    next(e);
  }
};
