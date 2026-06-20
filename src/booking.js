'use strict';
const { getDB } = require('./db');
const { render, renderMaster } = require('./templates.he.js');
const { send, sendToMaster } = require('./outbound');
const { parsePhoneNumber } = require('libphonenumber-js');

function normalizePhone(phone) {
  try { return parsePhoneNumber(phone, 'IL').format('E.164'); } catch (_) { return phone; }
}

function now() { return new Date().toISOString(); }

function computeHours(startTs, endTs) {
  return Math.round(((new Date(endTs) - new Date(startTs)) / 3600000) * 100) / 100;
}

function buildTimestamp(date, time) {
  // date: YYYY-MM-DD, time: HH:MM → ISO with +03:00
  return `${date}T${time}:00+03:00`;
}

function getFirstAdmin() {
  return getDB().prepare('SELECT * FROM admins WHERE can_request=1 LIMIT 1').get();
}

function getOfferCounts(bookingId) {
  const rows = getDB().prepare(
    'SELECT status, COUNT(*) as cnt FROM offers WHERE booking_id=? GROUP BY status'
  ).all(bookingId);
  const counts = { sent: 0, accepted: 0, declined: 0, superseded: 0, expired: 0 };
  rows.forEach(r => { counts[r.status] = r.cnt; });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { ...counts, total, pending: counts.sent };
}

// Fill transaction — atomic, first-accept-wins
function fillBooking(bookingId, babysitterId) {
  const db = getDB();
  const booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
  const sitter = db.prepare('SELECT * FROM babysitters WHERE id=?').get(babysitterId);
  const rate = sitter.hourly_rate_nis;
  const hours = computeHours(booking.start_ts, booking.end_ts);
  const filledAt = now();

  const txn = db.transaction(() => {
    const result = db.prepare(
      "UPDATE bookings SET status='filled', filled_by=?, agreed_rate_nis=?, hours=?, filled_at=? WHERE id=? AND status='open'"
    ).run(babysitterId, rate, hours, filledAt, bookingId);
    if (result.changes === 0) return false;
    db.prepare("UPDATE offers SET status='accepted', responded_at=? WHERE booking_id=? AND babysitter_id=?")
      .run(filledAt, bookingId, babysitterId);
    db.prepare("UPDATE offers SET status='superseded' WHERE booking_id=? AND status='sent'")
      .run(bookingId);
    return true;
  });

  return { won: txn(), booking, sitter, rate, hours };
}

async function createBooking({ requested_by, day, date, start, end, babysitter_ids, rate }) {
  const db = getDB();
  const normalizedRequester = normalizePhone(requested_by);
  const admin = db.prepare('SELECT * FROM admins WHERE phone=? AND can_request=1').get(normalizedRequester);
  if (!admin) {
    const err = new Error('Unauthorized: not an admin with booking permission');
    err.status = 403;
    throw err;
  }

  const start_ts = buildTimestamp(date, start);
  const end_ts = buildTimestamp(date, end);
  const hours = computeHours(start_ts, end_ts);
  const createdAt = now();

  const bookingResult = db.prepare(
    "INSERT INTO bookings (requested_by, job_date, start_ts, end_ts, status, hours, created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(normalizedRequester, date, start_ts, end_ts, 'open', hours, createdAt);
  const bookingId = bookingResult.lastInsertRowid;

  let sitters;
  if (babysitter_ids && babysitter_ids.length > 0) {
    const ph = babysitter_ids.map(() => '?').join(',');
    sitters = db.prepare(`SELECT * FROM babysitters WHERE id IN (${ph}) AND active=1`).all(...babysitter_ids);
  } else {
    sitters = db.prepare('SELECT * FROM babysitters WHERE active=1').all();
  }

  if (sitters.length === 0) {
    await sendToMaster(renderMaster('no_sitters', {}));
    db.prepare("UPDATE bookings SET status='expired' WHERE id=?").run(bookingId);
    return { bookingId, sent: 0 };
  }

  const firstAdmin = getFirstAdmin();
  const adminName = firstAdmin ? firstAdmin.name : 'המשפחה';
  const familyName = process.env.FAMILY_NAME || 'הבסינסקים';

  for (const sitter of sitters) {
    db.prepare(
      "INSERT OR IGNORE INTO offers (booking_id, babysitter_id, status, sent_at) VALUES (?,?,?,?)"
    ).run(bookingId, sitter.id, 'sent', now());

    if (!sitter.intro_sent) {
      const introMsg = render('intro', { name: sitter.name, family: familyName, admin: adminName }, sitter.gender);
      await send(sitter.phone, introMsg);
      db.prepare('UPDATE babysitters SET intro_sent=1 WHERE id=?').run(sitter.id);
    }

    const offerMsg = render('offer', {
      name: sitter.name, day, date, start, end,
      rate: rate || sitter.hourly_rate_nis,
    }, sitter.gender);
    await send(sitter.phone, offerMsg);
  }

  console.log(`[BabysitterBooking] Booking #${bookingId} created, broadcast to ${sitters.length} sitters`);
  return { bookingId, sent: sitters.length };
}

async function cancelBooking(bookingId) {
  const db = getDB();
  const booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
  if (!booking) { const e = new Error('Booking not found'); e.status = 404; throw e; }
  if (!['open', 'filled'].includes(booking.status)) {
    const e = new Error(`Cannot cancel booking with status: ${booking.status}`); e.status = 400; throw e;
  }

  db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(bookingId);
  db.prepare("UPDATE offers SET status='expired' WHERE booking_id=? AND status='sent'").run(bookingId);

  // Notify confirmed sitter if booking was filled
  if (booking.filled_by) {
    const sitter = db.prepare('SELECT * FROM babysitters WHERE id=?').get(booking.filled_by);
    if (sitter) {
      const startObj = new Date(booking.start_ts);
      const endObj = new Date(booking.end_ts);
      const fmt = (d) => d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
      const dateStr = startObj.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
      const msg = render('cancellation', { name: sitter.name, date: dateStr, start: fmt(startObj), end: fmt(endObj) }, sitter.gender);
      await send(sitter.phone, msg);
    }
  }

  const startObj = new Date(booking.start_ts);
  const endObj = new Date(booking.end_ts);
  const fmt = (d) => d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
  const dateStr = startObj.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
  await sendToMaster(renderMaster('cancel', { date: dateStr, start: fmt(startObj), end: fmt(endObj) }));

  console.log(`[BabysitterBooking] Booking #${bookingId} cancelled`);
}

module.exports = { createBooking, cancelBooking, fillBooking, getOfferCounts, normalizePhone };
