'use strict';
const https = require('https');
const crypto = require('crypto');
const { getDB } = require('./db');
const { render, renderMaster } = require('./templates.he.js');
const { send, sendToMaster } = require('./outbound');
const { fillBooking, getOfferCounts, normalizePhone } = require('./booking');

// ── LLM intent classifier ─────────────────────────────────────────────────────
// Replaces fragile regex. Uses Haiku to classify babysitter reply into one of
// four intents given the booking context. Fast, cheap, handles any natural language.

const INTENT_SYSTEM = `You classify a single WhatsApp reply from a babysitter.
Context: the babysitter received a message asking if they are available to babysit on a specific date and time.
Classify the reply into exactly one of these intents:
- accept: the babysitter confirms availability (yes, sure, I can make it, happy to, אשמח, כן, מתאים, בטח, etc.)
- decline: the babysitter is not available (no, can't make it, busy, לא, לא יכולה, סורי, etc.)
- opt_out: the babysitter wants to stop receiving messages (stop, remove, תפסיקו, הסר, etc.)
- question: anything else — a question, unclear, needs clarification

Return ONLY one word: accept, decline, opt_out, or question.`;

async function classifyIntent(bookingContext, reply) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.warn('[BabysitterBooking] No ANTHROPIC_API_KEY — falling back to keyword match');
    return fallbackClassify(reply);
  }

  const userMsg = `Booking: ${bookingContext}\nBabysitter reply: "${reply}"`;
  const body = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 10,
    system: INTENT_SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          const intent = r.content?.[0]?.text?.trim().toLowerCase();
          if (['accept', 'decline', 'opt_out', 'question'].includes(intent)) {
            console.log(`[BabysitterBooking] LLM classified: "${reply}" → ${intent}`);
            resolve(intent);
          } else {
            console.warn('[BabysitterBooking] Unexpected LLM intent:', intent, '— falling back');
            resolve(fallbackClassify(reply));
          }
        } catch (e) {
          console.warn('[BabysitterBooking] LLM parse error:', e.message, '— falling back');
          resolve(fallbackClassify(reply));
        }
      });
    });
    req.setTimeout(8000, () => {
      req.destroy();
      console.warn('[BabysitterBooking] LLM timeout — falling back');
      resolve(fallbackClassify(reply));
    });
    req.on('error', (e) => {
      console.warn('[BabysitterBooking] LLM error:', e.message, '— falling back');
      resolve(fallbackClassify(reply));
    });
    req.write(body);
    req.end();
  });
}

// Fallback for when LLM is unavailable
function fallbackClassify(text) {
  const t = text.trim();
  if (/תפסיקו|הסר|stop/i.test(t)) return 'opt_out';
  if (/^(כן|אשמח|מתאים|בטח|ok|yes)/i.test(t)) return 'accept';
  if (/^(לא|סורי|sorry)/i.test(t)) return 'decline';
  return 'question';
}

function bookingContext(offer) {
  try {
    const startObj = new Date(offer.start_ts);
    const fmt = d => d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
    const dateStr = startObj.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
    return `babysitting on ${dateStr} from ${fmt(startObj)} to ${fmt(new Date(offer.end_ts))}`;
  } catch (_) {
    return 'babysitting job';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dedup(from_phone, ts, body) {
  return crypto.createHash('sha256').update(`${from_phone}|${ts}|${body}`).digest('hex');
}

function logMessage(db, { booking_id, babysitter_id, admin_phone, direction, type, body, dedup_hash }) {
  try {
    db.prepare(
      'INSERT INTO message_log (booking_id, babysitter_id, admin_phone, direction, type, body, sent_at, dedup_hash) VALUES (?,?,?,?,?,?,?,?)'
    ).run(booking_id || null, babysitter_id || null, admin_phone || null, direction, type, body, new Date().toISOString(), dedup_hash || null);
  } catch (_) {}
}

function getAdminName() {
  const admin = getDB().prepare('SELECT name FROM admins WHERE can_request=1 LIMIT 1').get();
  return admin ? admin.name : 'המשפחה';
}

// ── Main handler ──────────────────────────────────────────────────────────────

async function handleInbound({ from_phone, body, ts }) {
  const db = getDB();
  const phone = normalizePhone(from_phone);
  const hash = dedup(phone, ts, body);

  // Idempotency
  const existing = db.prepare('SELECT id FROM message_log WHERE dedup_hash=?').get(hash);
  if (existing) { console.log('[BabysitterBooking] Inbound dedup hit, skipping'); return; }

  // Find babysitter
  const sitter = db.prepare('SELECT * FROM babysitters WHERE phone=?').get(phone);
  if (!sitter) {
    logMessage(db, { direction: 'in', type: 'freeform_in', body, dedup_hash: hash });
    return;
  }

  // Find most recent open offer
  const offer = db.prepare(`
    SELECT o.*, b.start_ts, b.end_ts, b.job_date, b.status as booking_status
    FROM offers o JOIN bookings b ON o.booking_id = b.id
    WHERE o.babysitter_id = ? AND b.status IN ('open', 'filled')
    ORDER BY o.sent_at DESC LIMIT 1
  `).get(sitter.id);

  if (!offer) {
    logMessage(db, { babysitter_id: sitter.id, direction: 'in', type: 'freeform_in', body, dedup_hash: hash });
    return;
  }

  logMessage(db, { booking_id: offer.booking_id, babysitter_id: sitter.id, direction: 'in', type: 'freeform_in', body, dedup_hash: hash });

  // Already filled → always already_booked
  if (offer.booking_status === 'filled') {
    await send(sitter.phone, render('already_booked', { name: sitter.name }, sitter.gender));
    return;
  }

  // Classify intent with LLM
  const intent = await classifyIntent(bookingContext(offer), body);
  const adminName = getAdminName();

  if (intent === 'opt_out') {
    db.prepare('UPDATE babysitters SET active=0 WHERE id=?').run(sitter.id);
    await send(sitter.phone, render('opt_out', {}, sitter.gender));
    console.log(`[BabysitterBooking] Opt-out: ${sitter.name}`);

  } else if (intent === 'accept') {
    const { won, booking, rate, hours } = fillBooking(offer.booking_id, sitter.id);
    if (won) {
      await send(sitter.phone, render('ack', { name: sitter.name, admin: adminName }, sitter.gender));
      const startObj = new Date(booking.start_ts);
      const endObj = new Date(booking.end_ts);
      const fmt = d => d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
      const dateStr = startObj.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
      const dayStr = startObj.toLocaleDateString('he-IL', { weekday: 'long', timeZone: 'Asia/Jerusalem' });
      await sendToMaster(renderMaster('fill', {
        name: sitter.name, day: dayStr, date: dateStr,
        start: fmt(startObj), end: fmt(endObj),
        hours, rate: rate || 0, total: Math.round(hours * (rate || 0)),
      }));
      console.log(`[BabysitterBooking] Booking #${offer.booking_id} filled by ${sitter.name}`);
    } else {
      await send(sitter.phone, render('already_booked', { name: sitter.name }, sitter.gender));
    }

  } else if (intent === 'decline') {
    db.prepare("UPDATE offers SET status='declined', responded_at=? WHERE booking_id=? AND babysitter_id=?")
      .run(new Date().toISOString(), offer.booking_id, sitter.id);
    await send(sitter.phone, render('decline_ack', { name: sitter.name }, sitter.gender));
    const counts = getOfferCounts(offer.booking_id);
    const booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(offer.booking_id);
    const startObj = new Date(booking.start_ts);
    const endObj = new Date(booking.end_ts);
    const fmt = d => d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
    const dateStr = startObj.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
    await sendToMaster(renderMaster('decline', {
      sitter_name: sitter.name, date: dateStr,
      start: fmt(startObj), end: fmt(endObj),
      total: counts.total, accepted: counts.accepted,
      declined: counts.declined, pending: counts.pending,
    }));
    console.log(`[BabysitterBooking] ${sitter.name} declined booking #${offer.booking_id}`);

  } else {
    // question / unclear → refer to admin
    await send(sitter.phone, render('refer', { admin: adminName }, sitter.gender));
  }
}

module.exports = { handleInbound };
