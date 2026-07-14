const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET /api/subjects
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sc_subjects ORDER BY display_order'
    );
    
    // Group by category (matching Skolify's groupedSubjects pattern)
    const grouped = {};
    result.rows.forEach(subject => {
      if (!grouped[subject.category]) {
        grouped[subject.category] = [];
      }
      grouped[subject.category].push(subject);
    });

    res.json({ 
      status: 'success', 
      subjects: result.rows,
      grouped 
    });
  } catch (error) {
    console.error('Get subjects error:', error);
    res.status(500).json({ status: 'error', error: 'Failed to fetch subjects.' });
  }
});

// GET /api/subjects/:id/tutors
router.get('/:id/tutors', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT 
        u.id, u.full_name, u.avatar_url,
        tp.headline, tp.hourly_rate, tp.average_rating, 
        tp.total_sessions, tp.total_reviews,
        ts.hourly_rate_override,
        ts.grade_levels
      FROM sc_tutor_subjects ts
      JOIN sc_tutor_profiles tp ON ts.tutor_id = tp.user_id
      JOIN sc_users u ON tp.user_id = u.id
      WHERE ts.subject_id = $1 
        AND tp.verification_status = 'verified'
        AND tp.is_available = TRUE
        AND u.is_active = TRUE
      ORDER BY tp.average_rating DESC NULLS LAST
    `, [id]);

    res.json({ status: 'success', tutors: result.rows });
  } catch (error) {
    console.error('Get tutors for subject error:', error);
    res.status(500).json({ status: 'error', error: 'Failed to fetch tutors.' });
  }
});

module.exports = router;