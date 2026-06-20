'use strict';
const http = require('http');
const https = require('https');

function send(to, body) {
  return new Promise((resolve, reject) => {
    const webhookUrl = process.env.TUDAT_OUTBOUND_WEBHOOK_URL || 'http://localhost:3001/send-message';
    const payload = JSON.stringify({ to, body });
    const url = new URL(webhookUrl);
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`[BabysitterBooking] Outbound → ${to}: ${body.substring(0, 60)}... (${res.statusCode})`);
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Outbound timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sendToMaster(body) {
  const jid = process.env.MASTER_GROUP_JID;
  if (!jid) { console.warn('[BabysitterBooking] MASTER_GROUP_JID not set'); return Promise.resolve(); }
  return send(jid, body);
}

module.exports = { send, sendToMaster };
