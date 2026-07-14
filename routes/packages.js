const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET /api/packages
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sc_packages WHERE is_active = TRUE ORDER BY tutor_limit'
    );
    res.json({ status: 'success', packages: result.rows });
  } catch (error) {
    console.error('Get packages error:', error);
    res.status(500).json({ status: 'error', error: 'Failed to fetch packages.' });
  }
});

module.exports = router;