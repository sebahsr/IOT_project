const router = require('express').Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const adminCtrl = require('../controllers/adminController');

router.get('/overview', auth, requireRole('admin'), adminCtrl.overview);


module.exports = router;
