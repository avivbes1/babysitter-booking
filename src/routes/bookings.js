'use strict';
const router = require('express').Router();
const { createBooking, cancelBooking } = require('../booking');
const { getDB } = require('../db');

router.post('/', async (req, res) => {
  try {
    const { requested_by, day, date, start, end, babysitter_ids, rate } = req.body;
    if (!requested_by || !date || !start || !end) return res.status(400).json({ error: 'Missing required fields: requested_by, date, start, end' });
    const result = await createBooking({ requested_by, day: day || date, date, start, end, babysitter_ids, rate });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/', (req, res) => {
  const bookings = getDB().prepare(`
    SELECT b.*, s.name as filled_by_name,
      (SELECT COUNT(*) FROM offers o WHERE o.booking_id=b.id AND o.status='sent') as pending_count,
      (SELECT COUNT(*) FROM offers o WHERE o.booking_id=b.id) as total_offers
    FROM bookings b
    LEFT JOIN babysitters s ON s.id = b.filled_by
    ORDER BY b.created_at DESC
  `).all();
  res.json(bookings);
});

router.get('/:id', (req, res) => {
  const booking = getDB().prepare('SELECT * FROM bookings WHERE id=?').get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Not found' });
  const offers = getDB().prepare(`
    SELECT o.*, s.name, s.phone, s.gender FROM offers o
    JOIN babysitters s ON s.id = o.babysitter_id
    WHERE o.booking_id=?
  `).all(req.params.id);
  res.json({ ...booking, offers });
});

router.post('/:id/cancel', async (req, res) => {
  try {
    await cancelBooking(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
