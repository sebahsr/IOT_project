module.exports = (req, res) => {
  res.status(404).json({ ok: false, message: 'Not Found', path: req.originalUrl });
};
