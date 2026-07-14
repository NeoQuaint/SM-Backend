const express = require('express');
const router = express.Router();
const pool = require('../db');

// POST /api/track-event
router.post('/', async (req, res) => {
  const { eventType, eventData } = req.body;
  const token = req.headers.authorization;

  let userId = null;
  if (token && token.startsWith('Bearer ')) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token.split(' ')[1], process.env.JWT_SECRET || 'smartclass_dev_secret');
      userId = decoded.id;
    } catch (e) {}
  }

  try {
    await pool.query(`
      INSERT INTO sc_analytics_events (user_id, event_type, event_data)
      VALUES ($1, $2, $3)
    `, [userId, eventType, JSON.stringify(eventData || {})]);
    res.json({ status: 'success' });
  } catch (error) {
    res.json({ status: 'success' });
  }
});

module.exports = router;