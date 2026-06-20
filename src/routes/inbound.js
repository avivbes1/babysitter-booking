'use strict';
const router = require('express').Router();
const { handleInbound } = require('../inbound');

router.post('/', async (req, res) => {
  try {
    const { from_phone, body, ts } = req.body;
    if (!from_phone || !body) return res.status(400).json({ error: 'Missing from_phone or body' });
    await handleInbound({ from_phone, body, ts: ts || new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    console.error('[BabysitterBooking] Inbound error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
