const router = require('express').Router();
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const validate = require('../middleware/validate');
const auth = require('../middleware/auth');
const ctrl = require('../controllers/authController');

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 100
});

// POST /api/auth/register
router.post(
  '/register',
  limiter,
  validate([
    body('email').isEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 6 }).withMessage('Password min 6 chars'),
    body('name').optional().isString(),
    body('homes').optional().isArray()
  ]),
  ctrl.register
);

// POST /api/auth/login
router.post(
  '/login',
  limiter,
  validate([
    body('email').isEmail(),
    body('password').isString().isLength({ min: 6 })
  ]),
  ctrl.login
);
router.get (
  '/getUsers',
  ctrl.getUsers

);
// GET /api/auth/me (protected)
router.get('/me', auth, ctrl.me);

module.exports = router;
