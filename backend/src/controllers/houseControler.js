// controllers/userController.js (ESM)
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import User from '../models/User.js';

export const getUserHouseByID = async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, message: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.split(' ')[1];
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ ok: false, message: 'Server misconfigured (JWT_SECRET missing)' });
    }

    const payload = jwt.verify(token, secret);

    // Support multiple possible claim names
    const userId = payload.sub || payload.userId || payload.id;
    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Token missing user identifier' });
    }
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ ok: false, message: 'Invalid user id in token' });
    }

    const user = await User.findById(userId)
      .select('_id email role name homes') // homes should exist in  schema
      .lean();

    if (!user) {
      return res.status(401).json({ ok: false, message: 'User not found' });
    }

    // Attach sanitized user only if later middleware needs it
    req.user = {
      id: user._id.toString(),
      email: user.email,
      role: user.role,
      name: user.name || '',
      homes: user.homes || [],
    };


    return res.status(200).json({ ok: true, homes: req.user.homes });
  } catch (e) {
    const status = e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError' ? 401 : 500;
    return res.status(status).json({ ok: false, message: e.message });
  }
};
