const { check } = require('express-validator');
const Device = require('../models/Device');
const jwt =require('jsonwebtoken')
const User =require("../models/User")
// Loads the device by :deviceId and checks the user can access it.
// Admin → any device. User → only devices in their homes.
exports.authorizeDeviceParam = async (req, res, next) => {
  try {
    const { deviceId} = req.params;
    const {homeId}= req.body;
    console.log(`Authorizing device ${deviceId} for home ${homeId}`);
    const q = { deviceId };
    if (req.user?.role !== 'admin') {
      q.homeId = { $in: req.user?.homes || [] };
    }
    if(!homeId){
      const err = new Error('homeId is required in body');
      err.status = 400;
      throw err;
    }
     console.log('Auth middleware triggered');
        const authHeader = req.headers.authorization || '';
        console.log(`Authorization header: ${authHeader}`);
        const token = authHeader.split(' ')[1];
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        console.log(`Decoded JWT payload: ${JSON.stringify(payload)}`);
        const user = await User.findById(payload.sub).lean();
        console.log("user",user)
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
        }
        // check if the provided homeId is in the user's homes
        if (!req.user.homes.includes(homeId)) {
          return res.status(403).json({ message: 'Forbidden: Access to the specified home is denied' });
        }  
        console.log('Authorization successful');
    next();
  } catch (e) { next(e); }
};
