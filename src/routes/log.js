'use strict';
const router = require('express').Router();
const { getDB } = require('../db');

router.get('/', (req, res) => {
  const rows = getDB().prepare(`
    SELECT ml.*, s.name as sitter_name, s.phone as sitter_phone
    FROM message_log ml
    LEFT JOIN babysitters s ON s.id = ml.babysitter_id
    ORDER BY ml.sent_at DESC
    LIMIT 500
  `).all();
  res.json(rows);
});

module.exports = router;
