const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

function signToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role,
      email: user.email,
      homes: user.homes || []
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES || '7d' }
  );
}

async function register({ email, password, name, homes }) {
  const exists = await User.findOne({ email });
  if (exists) {
    const err = new Error('Email already registered');
    err.status = 409;
    throw err;
  }
  const hash = await bcrypt.hash(password, 10);
  const user = await User.create({
    email,
    password: hash,
    role: 'user',       // default; admins will be created via seed script
    name: name || '',
    homes: Array.isArray(homes) ? homes : []
  });

  const token = signToken(user);
  return { user: sanitize(user), token };
}

async function login({ email, password }) {
  const user = await User.findOne({ email });
  if (!user) {
    const err = new Error('Invalid credentials');
    err.status = 401;
    throw err;
  }
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    const err = new Error('Invalid credentials');
    err.status = 401;
    throw err;
  }
  const token = signToken(user);
  return { user: sanitize(user), token };
}
async function findUserByEmail(email) {
  console.log('Finding user by email:', email);
  const user = await User.findOne({ email }).lean();
  if (!user) {  
    console.log('User not found');
    return null;
  }
  return sanitize(user);
}

function sanitize(u) {
  return {
    id: u._id?.toString?.() || u.id,
    email: u.email,
    role: u.role,
    name: u.name || '',
    homes: u.homes || []
  };
}
async function getUsers() {
  const users = await User.find({}, '-password -__v').lean();
  console.log('Fetched users:', users);
  if (!users || !users.length) return []; 

  return users.map(sanitize);
}
module.exports = { register, login, sanitize, getUsers, findUserByEmail };
