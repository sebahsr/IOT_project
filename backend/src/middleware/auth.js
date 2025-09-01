const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async function auth(req, res, next) {
  try {
    console.log('Auth middleware triggered');
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      const err = new Error('Missing or invalid Authorization header');
      err.status = 401;
      throw err;
    }
    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(payload.sub).lean();
    if (!user) {
      const err = new Error('User not found');
      err.status = 401;
      throw err;
    }

    // attach sanitized user
    req.user = {
      id: user._id.toString(),
      email: user.email,
      role: user.role,
      name: user.name || '',
      homes: user.homes || []
    };


    next();
  } catch (e) {
    if (!e.status) e.status = 401;
    next(e);
  }
};
// middleware/auth.js
// Assumes req.user is set by  auth middleware (e.g., JWT).
module.exports.requireAuth = async(req, res, next) => {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      const err = new Error('Missing or invalid Authorization header');
      err.status = 401;
      throw err;
    }
    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);
     const user = await User.findById(payload.sub).lean();
    if (!user) {
      const err = new Error('User not found');
      err.status = 401;
      throw err;  
    }
  
  console.log('Checking auth for user:', user.role,(user.role.trim() !== 'admin'));
  if (user.role !== 'admin') return res.status(401).json({ message: 'Unauthorized' });
  next();
};

module.exports.requireRole =  (role) => async(req, res, next) => {
 const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      const err = new Error('Missing or invalid Authorization header');
      err.status = 401;
      throw err;
    }
    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);
     const user = await User.findById(payload.sub).lean();
    if (!user) {
      const err = new Error('User not found');
      err.status = 401;
      throw err;  
    }
  if (!user || user.role !== role) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
};

module.exports.auths = async function (req, res, next) {
  try {
    console.log('Auth middleware triggered');
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      const err = new Error('Missing or invalid Authorization header');
      err.status = 401;
      throw err;
    }
    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(payload.sub).lean();
    if (!user) {
      const err = new Error('User not found');
      err.status = 401;
      throw err;
    }

    // attach sanitized user
    req.user = {
      id: user._id.toString(),
      email: user.email,
      role: user.role,
      name: user.name || '',
      homes: user.homes || []
    };

    next();
  } catch (e) {
    if (!e.status) e.status = 401;
    next(e);
  }
};