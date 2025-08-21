const router = require('express').Router();
const { getMongoState } = require('../config/mongo');

router.get('/status', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'shega-backend',
    db: getMongoState(),
    time: new Date().toISOString()
  });
});

module.exports = router;
