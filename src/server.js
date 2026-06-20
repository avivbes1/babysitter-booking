'use strict';
require('dotenv').config();
const express = require('express');
const { initDB } = require('./db');
const { startScheduler } = require('./scheduler');
const http = require('http');

// ── Startup validation ────────────────────────────────────────────────────────
const REQUIRED_ENV = ['SHARED_SECRET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[BabysitterBooking] FATAL: Missing required env var: ${key}`);
    process.exit(1);
  }
}

// Verify voice-server connectivity + auth before accepting requests
function checkVoiceServer() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:3001/health', (res) => {
      if (res.statusCode === 200) { resolve(true); }
      else { console.warn(`[BabysitterBooking] Voice-server health returned ${res.statusCode}`); resolve(false); }
      res.resume();
    });
    req.on('error', () => { console.warn('[BabysitterBooking] Voice-server unreachable — will retry on first send'); resolve(false); });
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

initDB();
startScheduler();

const app = express();
app.use(express.json());

// Auth middleware
const SHARED_SECRET = process.env.SHARED_SECRET;
app.use((req, res, next) => {
  if (!SHARED_SECRET) return next(); // no secret configured → open (dev mode)
  const token = req.headers['x-shared-token'];
  if (token !== SHARED_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.use('/bookings', require('./routes/bookings'));
app.use('/inbound', require('./routes/inbound'));
app.use('/onboarding', require('./routes/onboarding'));
app.use('/babysitters', require('./routes/onboarding')); // GET /babysitters/phones
app.use('/log', require('./routes/log'));
app.get('/status', require('./routes/onboarding').statusHandler);
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3002;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[BabysitterBooking] Server listening on localhost:${PORT}`);
});
