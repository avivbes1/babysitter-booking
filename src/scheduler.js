'use strict';
const cron = require('node-cron');
const { getDB } = require('./db');
const { render, renderMaster } = require('./templates.he.js');
const { send, sendToMaster } = require('./outbound');

function fmt(d) {
  return new Date(d).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
}
function fmtDate(d) {
  return new Date(d).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

async function checkExpiry() {
  const db = getDB();
  const openBookings = db.prepare("SELECT * FROM bookings WHERE status='open'").all();
  const now = Date.now();

  for (const booking of openBookings) {
    const expiryMs = new Date(booking.start_ts).getTime() - 2 * 3600 * 1000;
    if (now >= expiryMs) {
      db.prepare("UPDATE bookings SET status='expired' WHERE id=?").run(booking.id);
      db.prepare("UPDATE offers SET status='expired' WHERE booking_id=? AND status='sent'").run(booking.id);
      const dateStr = fmtDate(booking.start_ts);
      await sendToMaster(renderMaster('expiry', {
        date: dateStr,
        start: fmt(booking.start_ts),
        end: fmt(booking.end_ts),
      }));
      console.log(`[BabysitterBooking] Booking #${booking.id} expired (no fill before 2h mark)`);
    }
  }
}

async function checkReminders() {
  const db = getDB();
  const filledBookings = db.prepare("SELECT * FROM bookings WHERE status='filled'").all();
  const now = Date.now();
  const familyName = process.env.FAMILY_NAME || 'הבסינסקים';

  for (const booking of filledBookings) {
    const reminderMs = new Date(booking.start_ts).getTime() - 2 * 3600 * 1000;
    if (now < reminderMs) continue;

    const offer = db.prepare(
      "SELECT * FROM offers WHERE booking_id=? AND status='accepted' AND reminder_sent=0"
    ).get(booking.id);
    if (!offer) continue;

    const sitter = db.prepare('SELECT * FROM babysitters WHERE id=?').get(offer.babysitter_id);
    if (!sitter) continue;

    const msg = render('reminder', {
      name: sitter.name, family: familyName,
      date: fmtDate(booking.start_ts),
      start: fmt(booking.start_ts),
      end: fmt(booking.end_ts),
    }, sitter.gender);

    await send(sitter.phone, msg);
    db.prepare('UPDATE offers SET reminder_sent=1 WHERE id=?').run(offer.id);
    console.log(`[BabysitterBooking] Reminder sent to ${sitter.name} for booking #${booking.id}`);
  }
}

function startScheduler() {
  // Run every minute
  cron.schedule('* * * * *', async () => {
    try { await checkExpiry(); } catch (e) { console.error('[BabysitterBooking] Expiry check error:', e.message); }
    try { await checkReminders(); } catch (e) { console.error('[BabysitterBooking] Reminder check error:', e.message); }
  });
  console.log('[BabysitterBooking] Scheduler started (expiry + reminder checks every 1 min)');
}

module.exports = { startScheduler };
