const router = require('express').Router();
const { body } = require('express-validator');

const auth = require('../middleware/auth');
const { authorizeDeviceParam } = require('../middleware/scope');
const validate = require('../middleware/validate');

const ctrl = require('../controllers/deviceController');
const cmd  = require('../controllers/commandController');
const hos = require('../controllers/houseControler')
// List devices visible to the user
router.get('/', auth, ctrl.list);

// Get one device (must be visible to the user)
router.get('/:deviceId', auth, authorizeDeviceParam, ctrl.getOne);

// Send command to a device (user must have access)
router.post(
  '/:deviceId/command',
  auth,
  authorizeDeviceParam,
  validate([
    body('command').isString().trim().notEmpty(),
    body('value').custom(v => [0,1,true,false].includes(v))
  ]),
  cmd.send
);

router.post('/getUserHouseByID', hos.getUserHouseByID);

module.exports = router;

