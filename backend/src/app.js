const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const systemRoutes = require('./routes/system.routes');
const router = require('express').Router();
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const validate = require('./middleware/validate');
const auth = require('./middleware/auth');
const ctrl = require('./controllers/authController');
const authRoutes = require('./routes/auth.routes'); 

const deviceRoutes = require('./routes/devices.routes');     
const telemetryRoutes = require('./routes/telemetry.routes'); 
const dashboardRoutes = require('./routes/dashboard.routes'); 
const adminRoutes = require('./routes/admin.routes'); 
const rag = require('./routes/rag.routes')
const { apiLimiter, authLimiter } = require('./middleware/rateLimiters');
const errorHandler = require('./middleware/errorHandler');
const notFound = require('./middleware/notFound');
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

router.get('/me', auth, ctrl.me);

module.exports = router;

const app = express();
const allowlist = ['http://localhost:3002', 'http://127.0.0.1:3002'];

app.use(cors({
  origin(origin, cb) {
    // allow non-browser clients like Postman (no Origin header)
    if (!origin) return cb(null, true);
    if (allowlist.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());

// Health root
app.get('/', (req, res) => {
  res.json({ ok: true, name: 'SHEGA Backend', version: '1.0.0' });
});

// Routes
app.use('/api/system', systemRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/dashboard', dashboardRoutes); // ← add
app.use('/api/admin', adminRoutes);

app.use('/api', apiLimiter);
// Stricter limits just for auth
app.use('/api/auth', authLimiter);
app.use('/api/rag',rag)
app.use(notFound);
app.use(errorHandler);

module.exports = app;
