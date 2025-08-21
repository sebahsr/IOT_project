const { listForUser, getByDeviceIdForUser } = require('../services/deviceService');

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(1, Math.min(1000, Number(req.query.pageSize) || 100));

    const all = await listForUser(req.user);
    const start = (page - 1) * pageSize;
    const slice = all.slice(start, start + pageSize);

    res.setHeader('X-Total-Count', String(all.length));
    res.status(200).json({ ok: true, count: slice.length, page, pageSize, devices: slice });
  } catch (e) { next(e); }
};

exports.getOne = async (req, res, next) => {
  try {
    const device = await getByDeviceIdForUser(req.params.deviceId, req.user);
    if (!device) return res.status(404).json({ ok: false, message: 'Not found' });
    res.status(200).json({ ok: true, device });
  } catch (e) { next(e); }
};
