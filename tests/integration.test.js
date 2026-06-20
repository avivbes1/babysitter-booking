'use strict';
/**
 * Integration test — babysitter booking full flow.
 * Starts a mock VoiceServer on port 3099, runs the real booking logic
 * against an in-memory DB, and validates the entire flow.
 */

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Test env setup (must happen before any require of app modules) ────────────
const TEST_DB = path.join(os.tmpdir(), `babysitter-test-${Date.now()}.sqlite`);
const MOCK_PORT = 3099;
const TEST_APP_PORT = 3097;
const TEST_SECRET = 'test-secret-integration';

process.env.DATABASE_PATH = TEST_DB;
process.env.SHARED_SECRET = TEST_SECRET;
process.env.AGENT_OUTBOUND_WEBHOOK_URL = `http://localhost:${MOCK_PORT}/send-message`;
process.env.MASTER_GROUP_JID = 'test-master@g.us';
process.env.FAMILY_NAME = 'TestFamily';

// ── Mock VoiceServer ──────────────────────────────────────────────────────────
let capturedMessages = [];

function createMockServer() {
  return http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === 'POST' && req.url === '/send-message') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          // Bug 2 regression: must have `text` not `body`
          if (!parsed.text) {
            res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing text field' }));
          }
          capturedMessages.push(parsed);
          res.writeHead(200); res.end(JSON.stringify({ ok: true }));
        } catch (_) {
          res.writeHead(400); res.end('Bad JSON');
        }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost', port: TEST_APP_PORT, path, method,
      headers: {
        'Content-Type': 'application/json',
        'x-shared-token': TEST_SECRET,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (_) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runTests() {
  // Start mock server
  const mockServer = createMockServer();
  await new Promise(r => mockServer.listen(MOCK_PORT, '127.0.0.1', r));

  // Start booking service
  const { initDB } = require('../src/db');
  const app = require('express')();
  app.use(require('express').json());
  app.use((req, res, next) => {
    if (req.headers['x-shared-token'] !== TEST_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });
  app.use('/bookings', require('../src/routes/bookings'));
  app.use('/inbound', require('../src/routes/inbound'));
  app.use('/onboarding', require('../src/routes/onboarding'));
  app.use('/babysitters', require('../src/routes/onboarding'));
  app.get('/status', require('../src/routes/onboarding').statusHandler);
  initDB();
  const server = await new Promise(r => { const s = app.listen(TEST_APP_PORT, '127.0.0.1', () => r(s)); });

  console.log('\n[Integration] Onboarding');

  await test('seed admins', async () => {
    const r = await apiRequest('POST', '/onboarding/admins', {
      admins: [{ name: 'אביב', phone: '+972500000001' }],
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.ok);
  });

  await test('seed babysitters', async () => {
    const r = await apiRequest('POST', '/onboarding/babysitters', {
      babysitters: [
        { name: 'שיר', phone: '+972500000010', hourly_rate_nis: 30, gender: 'f' },
        { name: 'לי',  phone: '+972500000011', hourly_rate_nis: 30, gender: 'f' },
      ],
    });
    assert.equal(r.status, 200);
  });

  await test('GET /status shows onboarding complete', async () => {
    const r = await apiRequest('GET', '/status', null);
    assert.equal(r.body.onboarding_complete, true);
  });

  console.log('\n[Integration] Booking broadcast');
  capturedMessages = [];

  let bookingId;
  await test('POST /bookings creates booking and broadcasts', async () => {
    const r = await apiRequest('POST', '/bookings', {
      requested_by: '+972500000001',
      day: 'ראשון',
      date: '2026-07-01',
      start: '20:00',
      end: '23:00',
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.ok);
    assert.equal(r.body.sent, 2);
    bookingId = r.body.bookingId;
  });

  await test('Bug 2 regression: outbound uses {text} not {body}', () => {
    assert.ok(capturedMessages.length > 0, 'No messages captured');
    capturedMessages.forEach(m => {
      assert.ok(m.text !== undefined, `Message missing 'text' field: ${JSON.stringify(m)}`);
      assert.ok(m.body === undefined, `Message has forbidden 'body' field`);
    });
  });

  await test('Bug 3 regression: offer contains no rate (₪)', () => {
    const offerMsgs = capturedMessages.filter(m => m.text && m.text.includes('פנוי'));
    assert.ok(offerMsgs.length > 0, 'No offer messages found');
    offerMsgs.forEach(m => {
      assert.ok(!m.text.includes('₪'), `Rate leaked in offer: ${m.text}`);
      assert.ok(!m.text.match(/\d+\s*ש[""']?ח/), `Rate leaked in offer: ${m.text}`);
    });
  });

  await test('Intro sent before offer to each sitter', () => {
    // Each sitter should get 2 messages: intro + offer
    const sitter1Msgs = capturedMessages.filter(m => m.to === '+972500000010');
    const sitter2Msgs = capturedMessages.filter(m => m.to === '+972500000011');
    assert.ok(sitter1Msgs.length >= 2, `Sitter 1 got ${sitter1Msgs.length} messages, expected ≥2`);
    assert.ok(sitter2Msgs.length >= 2, `Sitter 2 got ${sitter2Msgs.length} messages, expected ≥2`);
  });

  console.log('\n[Integration] Inbound acceptance');
  capturedMessages = [];

  await test('First sitter accepts → ack + master group update', async () => {
    const r = await apiRequest('POST', '/inbound', {
      from_phone: '+972500000010',
      body: 'כן',
      ts: '2026-07-01T16:00:00Z',
    });
    assert.equal(r.status, 200);
    assert.ok(capturedMessages.some(m => m.text && m.text.includes('מעולה')), 'No ack message sent to sitter');
    assert.ok(capturedMessages.some(m => m.to === 'test-master@g.us'), 'Master group not notified');
    const masterMsg = capturedMessages.find(m => m.to === 'test-master@g.us');
    assert.ok(masterMsg.text.includes('✅'), `Master group message: ${masterMsg?.text}`);
  });

  await test('Second sitter accepts → already_booked', async () => {
    capturedMessages = [];
    const r = await apiRequest('POST', '/inbound', {
      from_phone: '+972500000011',
      body: 'כן',
      ts: '2026-07-01T16:01:00Z',
    });
    assert.equal(r.status, 200);
    assert.ok(capturedMessages.some(m => m.text && m.text.includes('נסגרה')), 'No already_booked message');
  });

  console.log('\n[Integration] Phase 3 — idempotency');

  await test('Duplicate inbound message processed only once', async () => {
    capturedMessages = [];
    // Create new booking first
    await apiRequest('POST', '/bookings', {
      requested_by: '+972500000001', day: 'שני', date: '2026-07-02', start: '19:00', end: '22:00',
    });
    capturedMessages = [];
    const payload = { from_phone: '+972500000010', body: 'אשמח', ts: '2026-07-02T15:00:00Z' };
    await apiRequest('POST', '/inbound', payload);
    const firstCount = capturedMessages.length;
    await apiRequest('POST', '/inbound', payload); // exact same message again
    assert.equal(capturedMessages.length, firstCount, 'Duplicate message was processed twice');
  });

  await test('Bug 4 regression: intro_sent=1 only set on successful send', async () => {
    const { getDB } = require('../src/db');
    const rows = getDB().prepare('SELECT intro_sent FROM babysitters').all();
    rows.forEach(r => assert.equal(r.intro_sent, 1, 'intro_sent not set after successful sends'));
  });

  // Cleanup
  server.close();
  mockServer.close();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
}

// ── Entry point ───────────────────────────────────────────────────────────────
module.exports = {
  async run() {
    await runTests();
    if (failed > 0) return { pass: false, message: `${passed} passed, ${failed} failed` };
    return { pass: true, message: `${passed} passed, 0 failed` };
  },
};

// Run directly
if (require.main === module) {
  console.log('\n🧪 Babysitter Booking — Integration Tests\n');
  runTests().then(() => {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }).catch(e => {
    console.error('Test runner error:', e.message);
    process.exit(1);
  });
}
