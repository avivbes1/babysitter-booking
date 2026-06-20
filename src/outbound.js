'use strict';
const http = require('http');

const OUTBOUND_URL = process.env.AGENT_OUTBOUND_WEBHOOK_URL || 'http://localhost:3001/send-message';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendOnce(to, text) {
  const payload = JSON.stringify({ to, text });
  const url = new URL(OUTBOUND_URL);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Outbound timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function send(to, text) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await sendOnce(to, text);
      if (result.status >= 200 && result.status < 300) {
        console.log(`[BabysitterBooking] Outbound → ${to}: ${text.substring(0, 60)}... (${result.status})`);
        return result;
      }
      console.error(`[BabysitterBooking] Outbound attempt ${attempt}/${MAX_RETRIES} failed: HTTP ${result.status} → ${to}: ${text.substring(0, 40)}`);
    } catch (e) {
      console.error(`[BabysitterBooking] Outbound attempt ${attempt}/${MAX_RETRIES} error: ${e.message} → ${to}`);
    }
    if (attempt < MAX_RETRIES) await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
  }
  console.error(`[BabysitterBooking] PERMANENT FAILURE: message not delivered after ${MAX_RETRIES} attempts → ${to}: ${text.substring(0, 60)}`);
  return { status: 0, failed: true };
}

function sendToMaster(text) {
  const jid = process.env.MASTER_GROUP_JID;
  if (!jid) { console.warn('[BabysitterBooking] MASTER_GROUP_JID not set — skipping master group update'); return Promise.resolve(); }
  return send(jid, text);
}

module.exports = { send, sendToMaster };
