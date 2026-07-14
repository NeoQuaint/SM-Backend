const express = require('express');
const router = express.Router();
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

// GET /api/tutors/:id
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const tutorResult = await pool.query(`
      SELECT 
        u.id, u.full_name, u.avatar_url,
        tp.headline, tp.bio, tp.hourly_rate, 
        tp.qualifications, tp.verification_status,
        tp.average_rating, tp.total_sessions, tp.total_reviews
      FROM sc_tutor_profiles tp
      JOIN sc_users u ON tp.user_id = u.id
      WHERE tp.user_id = $1 AND u.is_active = TRUE
    `, [id]);

    if (tutorResult.rows.length === 0) {
      return res.status(404).json({ status: 'error', error: 'Tutor not found.' });
    }

    const tutor = tutorResult.rows[0];

    const subjectsResult = await pool.query(`
      SELECT s.id, s.name, s.category, s.icon,
             ts.grade_levels, ts.hourly_rate_override
      FROM sc_tutor_subjects ts
      JOIN sc_subjects s ON ts.subject_id = s.id
      WHERE ts.tutor_id = $1
      ORDER BY s.display_order
    `, [id]);

    const availabilityResult = await pool.query(`
      SELECT day_of_week, start_time, end_time
      FROM sc_tutor_availability
      WHERE tutor_id = $1 AND is_recurring = TRUE
      ORDER BY day_of_week, start_time
    `, [id]);

    const reviewsResult = await pool.query(`
      SELECT r.rating, r.comment, r.created_at,
             u.full_name as reviewer_name, u.avatar_url as reviewer_avatar
      FROM sc_reviews r
      JOIN sc_users u ON r.reviewer_id = u.id
      WHERE r.reviewee_id = $1
      ORDER BY r.created_at DESC
      LIMIT 10
    `, [id]);

    res.json({
      status: 'success',
      tutor,
      subjects: subjectsResult.rows,
      availability: availabilityResult.rows,
      reviews: reviewsResult.rows
    });

  } catch (error) {
    console.error('Get tutor error:', error);
    res.status(500).json({ status: 'error', error: 'Failed to fetch tutor.' });
  }
});

// PUT /api/tutors/profile (tutor updates own profile)
router.put('/profile', authMiddleware, async (req, res) => {
  if (req.user.role !== 'tutor') {
    return res.status(403).json({ status: 'error', error: 'Only tutors can update.' });
  }

  const { headline, bio, hourly_rate, qualifications } = req.body;

  try {
    const result = await pool.query(`
      UPDATE sc_tutor_profiles 
      SET headline = COALESCE($1, headline),
          bio = COALESCE($2, bio),
          hourly_rate = COALESCE($3, hourly_rate),
          qualifications = COALESCE($4, qualifications)
      WHERE user_id = $5
      RETURNING *
    `, [headline, bio, hourly_rate, qualifications, req.user.id]);

    res.json({ status: 'success', profile: result.rows[0] });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ status: 'error', error: 'Failed to update profile.' });
  }
});

module.exports = router;