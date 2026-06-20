'use strict';
const router = require('express').Router();
const { getDB } = require('../db');
const { normalizePhone } = require('../booking');

// POST /onboarding/babysitters
router.post('/babysitters', (req, res) => {
  const { babysitters } = req.body;
  if (!Array.isArray(babysitters) || babysitters.length === 0)
    return res.status(400).json({ error: 'Expected { babysitters: [...] }' });

  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO babysitters (name, phone, hourly_rate_nis, gender, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      name=excluded.name, hourly_rate_nis=excluded.hourly_rate_nis, gender=excluded.gender
  `);
  const upsert = db.transaction((list) => {
    for (const s of list) {
      if (!s.name || !s.phone || !s.hourly_rate_nis) continue;
      stmt.run(s.name, normalizePhone(s.phone), s.hourly_rate_nis, s.gender || 'f', new Date().toISOString());
    }
  });
  upsert(babysitters);
  db.prepare('UPDATE onboarding_state SET babysitters_set=1 WHERE id=1').run();
  res.json({ ok: true, count: babysitters.length });
});

// POST /onboarding/admins
router.post('/admins', (req, res) => {
  const { admins } = req.body;
  if (!Array.isArray(admins) || admins.length === 0)
    return res.status(400).json({ error: 'Expected { admins: [...] }' });

  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO admins (name, phone, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET name=excluded.name
  `);
  const upsert = db.transaction((list) => {
    for (const a of list) {
      if (!a.name || !a.phone) continue;
      stmt.run(a.name, normalizePhone(a.phone), new Date().toISOString());
    }
  });
  upsert(admins);
  db.prepare('UPDATE onboarding_state SET admins_set=1 WHERE id=1').run();
  res.json({ ok: true, count: admins.length });
});

// GET /babysitters/phones — Tudat uses this to know which DMs to forward
router.get('/phones', (req, res) => {
  const phones = getDB().prepare('SELECT phone FROM babysitters WHERE active=1').all().map(r => r.phone);
  res.json({ phones });
});

// GET /status
function statusHandler(req, res) {
  const db = getDB();
  const state = db.prepare('SELECT * FROM onboarding_state WHERE id=1').get();
  const admin_count = db.prepare('SELECT COUNT(*) as cnt FROM admins').get().cnt;
  const babysitter_count = db.prepare('SELECT COUNT(*) as cnt FROM babysitters WHERE active=1').get().cnt;
  res.json({
    onboarding_complete: !!(state.admins_set && state.babysitters_set),
    admins_set: !!state.admins_set,
    babysitters_set: !!state.babysitters_set,
    admin_count,
    babysitter_count,
  });
}

module.exports = router;
module.exports.statusHandler = statusHandler;
