const { register, login, sanitize, getUsers,findUserByEmail } = require('../services/authService');

exports.register = async (req, res, next) => {
  try {
    console.log('Registering user:', req.body);
    const existingUser = await findUserByEmail(req.body.email);
    if (existingUser) {
      const err = new Error('Email already registered');
      err.status = 409;
      throw err;
    }
    const { user, token } = await register(req.body);
    res.status(201).json({ ok: true, user, token });
  } catch (e) { next(e); }
};

exports.login = async (req, res, next) => {
  try {
    const { user, token } = await login(req.body);
    res.status(200).json({ ok: true, user, token });
  } catch (e) { next(e); }
};

exports.me = async (req, res) => {
  res.status(200).json({ ok: true, user: req.user });
};

exports.getUsers = async (req, res, next) => {
  try {
    const users = await getUsers();
    res.status(200).json({ ok: true, users });
  } catch (e) { next(e); }
};