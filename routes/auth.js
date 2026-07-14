const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, full_name, role } = req.body;

  if (!email || !password || !full_name || !role) {
    return res.status(400).json({ status: 'error', error: 'All fields required.' });
  }

  if (!['student', 'tutor'].includes(role)) {
    return res.status(400).json({ status: 'error', error: 'Role must be student or tutor.' });
  }

  try {
    const existing = await pool.query('SELECT id FROM sc_users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ status: 'error', error: 'Email already registered.' });
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const result = await pool.query(
      `INSERT INTO sc_users (email, password_hash, full_name, role) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, email, full_name, role, avatar_url, created_at`,
      [email, password_hash, full_name, role]
    );

    const user = result.rows[0];

    if (role === 'student') {
      await pool.query('INSERT INTO sc_student_profiles (user_id) VALUES ($1)', [user.id]);
    } else if (role === 'tutor') {
      await pool.query('INSERT INTO sc_tutor_profiles (user_id) VALUES ($1)', [user.id]);
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET || 'smartclass_dev_secret',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      status: 'success',
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        avatar_url: user.avatar_url
      }
    });

  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ status: 'error', error: 'Registration failed.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ status: 'error', error: 'Email and password required.' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM sc_users WHERE email = $1 AND is_active = TRUE',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ status: 'error', error: 'Invalid credentials.' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ status: 'error', error: 'Invalid credentials.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET || 'smartclass_dev_secret',
      { expiresIn: '7d' }
    );

    res.json({
      status: 'success',
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        avatar_url: user.avatar_url
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ status: 'error', error: 'Login failed.' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, full_name, role, avatar_url FROM sc_users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', error: 'User not found.' });
    }

    res.json({ status: 'success', user: result.rows[0] });

  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ status: 'error', error: 'Failed to get user.' });
  }
});

module.exports = router;