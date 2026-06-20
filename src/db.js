'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'babysitters.sqlite');

let db;

function initDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS babysitters (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      hourly_rate_nis REAL NOT NULL,
      gender TEXT NOT NULL DEFAULT 'f',
      intro_sent INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      can_request INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY,
      requested_by TEXT NOT NULL,
      job_date TEXT NOT NULL,
      start_ts TEXT NOT NULL,
      end_ts TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      filled_by INTEGER REFERENCES babysitters(id),
      agreed_rate_nis REAL,
      hours REAL,
      created_at TEXT NOT NULL,
      filled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS offers (
      id INTEGER PRIMARY KEY,
      booking_id INTEGER NOT NULL REFERENCES bookings(id),
      babysitter_id INTEGER NOT NULL REFERENCES babysitters(id),
      status TEXT NOT NULL DEFAULT 'sent',
      sent_at TEXT NOT NULL,
      responded_at TEXT,
      reminder_sent INTEGER NOT NULL DEFAULT 0,
      UNIQUE (booking_id, babysitter_id)
    );

    CREATE TABLE IF NOT EXISTS message_log (
      id INTEGER PRIMARY KEY,
      booking_id INTEGER REFERENCES bookings(id),
      babysitter_id INTEGER REFERENCES babysitters(id),
      admin_phone TEXT,
      direction TEXT NOT NULL,
      type TEXT NOT NULL,
      body TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      dedup_hash TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS onboarding_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      admins_set INTEGER NOT NULL DEFAULT 0,
      babysitters_set INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO onboarding_state (id, admins_set, babysitters_set) VALUES (1, 0, 0);
  `);

  console.log('[BabysitterBooking] DB initialized at', DB_PATH);
  return db;
}

function getDB() {
  if (!db) throw new Error('DB not initialized — call initDB() first');
  return db;
}

module.exports = { initDB, getDB };
