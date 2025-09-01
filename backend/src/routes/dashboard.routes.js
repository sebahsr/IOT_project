const router = require('express').Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/dashboardController');
const express = require('express');
const { query, param, body } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');
const { authorizeDeviceParam } = require('../middleware/scope');
router.get('/summary', auth, ctrl.summary);
router.get('/my-latest', auth, ctrl.myLatestPerDevice);
// routes/dashboardRoutes.js


/** GET /api/dashboard/homes */
router.get(
  '/homes', requireRole('admin'),
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('status').optional().isIn(['online', 'offline', 'unknown']),
    query('type').optional().isIn(['AIRNODE', 'STOVENODE']),
    query('search').optional().isString()
  ],
  ctrl.listHomes
);

/** GET /api/dashboard/homes/:homeId */
router.get(
  '/homes/:homeId', requireRole('admin'),
  [param('homeId').isString().notEmpty()],
  ctrl.getHome
);

/** GET /api/dashboard/homes/:homeId/devices */
router.get(
  '/homes/:homeId/devices', requireRole('admin'),
  [
    param('homeId').isString().notEmpty(),
    query('status').optional().isIn(['online', 'offline', 'unknown']),
    query('type').optional().isIn(['AIRNODE', 'STOVENODE'])
  ],
  ctrl.listDevicesInHome
);

/** GET /api/dashboard/devices/:deviceId */
router.get(
  '/devices/:deviceId',
  [param('deviceId').isString().notEmpty()],
  ctrl.getDevice
);

/** POST /api/admin/devices/:deviceId/control */
router.post(
  '/devices/:deviceId/control', authorizeDeviceParam,
  [
    param('deviceId').isString().notEmpty(),
    // You can add stricter validations depending on allowed commands
    body().custom(val => typeof val === 'object' && val !== null)
  ],
  ctrl.controlDevice
);

module.exports = router;
