'use strict';
const crypto = require('crypto');
const { getDB } = require('./db');
const { render, renderMaster } = require('./templates.he.js');
const { send, sendToMaster } = require('./outbound');
const { fillBooking, getOfferCounts, normalizePhone } = require('./booking');

const ACCEPT = /^(כן|אשמח|מתאים|בטח|בשמחה|ok|yes|אוקיי|נהדר|מעולה)\b/i;
const DECLINE = /^(לא|לא\s+יכולה|לא\s+יכול|לא\s+פנויה|לא\s+פנוי|סורי|sorry|לא\s+אוכל)\b/i;
const OPT_OUT = /תפסיקו|הסר|STOP|stop/;

function dedup(from_phone, ts, body) {
  return crypto.createHash('sha256').update(`${from_phone}|${ts}|${body}`).digest('hex');
}

function logMessage(db, { booking_id, babysitter_id, admin_phone, direction, type, body, dedup_hash }) {
  try {
    db.prepare(
      'INSERT INTO message_log (booking_id, babysitter_id, admin_phone, direction, type, body, sent_at, dedup_hash) VALUES (?,?,?,?,?,?,?,?)'
    ).run(booking_id || null, babysitter_id || null, admin_phone || null, direction, type, body, new Date().toISOString(), dedup_hash || null);
  } catch (_) { /* dedup_hash unique constraint — already logged */ }
}

function getAdminName() {
  const admin = getDB().prepare('SELECT name FROM admins WHERE can_request=1 LIMIT 1').get();
  return admin ? admin.name : 'המשפחה';
}

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
    console.log(`[BabysitterBooking] Unknown sender ${phone}, logged and ignored`);
    return;
  }

  // Find most recent open offer for this sitter
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

  // Opt-out
  if (OPT_OUT.test(body)) {
    db.prepare('UPDATE babysitters SET active=0 WHERE id=?').run(sitter.id);
    await send(sitter.phone, render('opt_out', {}, sitter.gender));
    console.log(`[BabysitterBooking] Opt-out: ${sitter.name} (${phone})`);
    return;
  }

  // If booking already filled by someone else
  if (offer.booking_status === 'filled') {
    await send(sitter.phone, render('already_booked', { name: sitter.name }, sitter.gender));
    return;
  }

  const adminName = getAdminName();

  if (ACCEPT.test(body.trim())) {
    const { won, booking, rate, hours } = fillBooking(offer.booking_id, sitter.id);
    if (won) {
      await send(sitter.phone, render('ack', { name: sitter.name, admin: adminName }, sitter.gender));
      const startObj = new Date(booking.start_ts);
      const endObj = new Date(booking.end_ts);
      const fmt = d => d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
      const dateStr = startObj.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
      const dayStr = startObj.toLocaleDateString('he-IL', { weekday: 'long', timeZone: 'Asia/Jerusalem' });
      const total = Math.round(hours * rate);
      await sendToMaster(renderMaster('fill', {
        name: sitter.name, day: dayStr, date: dateStr,
        start: fmt(startObj), end: fmt(endObj),
        hours, rate, total,
      }));
      console.log(`[BabysitterBooking] Booking #${offer.booking_id} filled by ${sitter.name}`);
    } else {
      await send(sitter.phone, render('already_booked', { name: sitter.name }, sitter.gender));
    }

  } else if (DECLINE.test(body.trim())) {
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
    // Question or unclear → refer to admin
    await send(sitter.phone, render('refer', { admin: adminName }, sitter.gender));
  }
}

module.exports = { handleInbound };
