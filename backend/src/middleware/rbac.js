module.exports.requireRole = function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      const err = new Error('Unauthorized');
      err.status = 401;
      return next(err);
    }
    if (req.user.role !== role) {
      const err = new Error('Forbidden: insufficient role');
      err.status = 403;
      return next(err);
    }
    next();
  };
};
