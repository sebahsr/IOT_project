const router = require('express').Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/telemetryController');

router.get('/', auth, ctrl.list);
router.get('/latest-per-device', auth, ctrl.latestPerDevice);
router.get('/latest/:deviceId', auth, ctrl.latestForDevice);
router.get('/export.csv', auth, ctrl.exportCSV);
module.exports = router;
