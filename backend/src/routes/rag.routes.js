// routes/rag.js (mount at /api/rag)
const router = require('express').Router();
const axios = require('axios');
const Telemetry = require('../models/Telemetry'); // {houseId, metrics{co2_ppm,co_ppm,pm25_ugm3,temp_c,...}, ts}
const { decodeJwtFromReq } = require('../utils/auth.js'); //  helper


// POST /api/rag/chat/stream
router.post('/chat/stream', async (req, res) => {
  try {
    const user = decodeJwtFromReq(req);
    if (!user) return res.status(401).json({ ok:false, message:'Unauthorized' });

    const { question, houseId: bodyHouseId, locale, telemetry: clientTel } = req.body || {};
    const houseId = user.role === 'admin' ? (bodyHouseId || user.houseId) : user.houseId;
    if (!houseId) return res.status(400).json({ ok:false, message:'houseId required' });

    const latest = await Telemetry.findOne({ houseId }).sort({ ts: -1 }).lean();
    const dbTel = latest?.metrics || {};

    const mergedTelemetry = {
      co2_ppm:   clientTel?.co2_ppm   ?? dbTel.co2_ppm,
      co_ppm:    clientTel?.co_ppm    ?? dbTel.co_ppm,
      pm25_ugm3: clientTel?.pm25_ugm3 ?? dbTel.pm25_ugm3,
      temp_c:    clientTel?.temp_c    ?? dbTel.temp_c,
      stove_temp_c:    clientTel?.stove_temp_c    ?? dbTel.stove_temp_c,
      stove_fan_on:    clientTel?.stove_fan_on    ?? dbTel.stove_fan_on,
      stove_buzzer_on: clientTel?.stove_buzzer_on ?? dbTel.stove_buzzer_on,
    };

    console.log('[API→RAG] telemetry sent:', mergedTelemetry);

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const py = await axios({
      method: 'post',
      url: (process.env.RAG_URL || 'http://localhost:5055') + '/v1/chat/stream',
      data: { question, houseId, locale, telemetry: mergedTelemetry },
      responseType: 'stream',
      timeout: 60000,
    });

    py.data.on('data', (chunk) => res.write(chunk));
    py.data.on('end',  () => res.end());
    py.data.on('error',() => res.end());
  } catch (err) {
    console.error('RAG proxy error', err);
    if (!res.headersSent) res.status(500).json({ ok:false, message:'RAG proxy failed' });
    else res.end();
  }
});
module.exports = router;
