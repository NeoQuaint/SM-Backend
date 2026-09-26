const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, full_name } = req.body;

  if (!email || !password) {
    return res.status(400).json({ status: 'error', error: 'Email and password required.' });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ status: 'error', error: 'Email already registered.' });
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, auth_provider, subjects) 
       VALUES ($1, $2, $3, 'email', '[]'::jsonb) 
       RETURNING id, email, full_name, avatar, grade, subjects, onboarding_complete, notifications_enabled`,
      [email, password_hash, full_name || '']
    );

    const user = result.rows[0];

    const token = jwt.sign(
      { id: user.id, email: user.email },
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
        avatar: user.avatar,
        grade: user.grade,
        subjects: user.subjects || [],
        onboarding_complete: user.onboarding_complete,
        notifications_enabled: user.notifications_enabled
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
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ status: 'error', error: 'Invalid credentials.' });
    }

    const user = result.rows[0];
    
    if (!user.password_hash) {
      return res.status(401).json({ status: 'error', error: 'Please login with Google.' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ status: 'error', error: 'Invalid credentials.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
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
        avatar: user.avatar,
        grade: user.grade,
        subjects: user.subjects || [],
        onboarding_complete: user.onboarding_complete,
        notifications_enabled: user.notifications_enabled
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ status: 'error', error: 'Login failed.' });
  }
});

// POST /api/auth/google
router.post('/google', async (req, res) => {
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({ status: 'error', error: 'Google credential required.' });
  }

  try {
    console.log('🔐 Verifying Google credential...');
    console.log('GOOGLE_CLIENT_ID:', GOOGLE_CLIENT_ID ? 'Set ✓' : 'NOT SET ❌');
    
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email;
    const fullName = payload.name;

    console.log('✅ Google verified:', email);

    if (!email) {
      return res.status(400).json({ status: 'error', error: 'No email from Google.' });
    }

    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    let user;
    
    if (existing.rows.length > 0) {
      user = existing.rows[0];
      
      if (!user.google_id) {
        await pool.query('UPDATE users SET google_id = $1, auth_provider = $2 WHERE id = $3', [googleId, 'google', user.id]);
      }
    } else {
      const result = await pool.query(
        `INSERT INTO users (email, full_name, google_id, auth_provider, subjects) 
         VALUES ($1, $2, $3, 'google', '[]'::jsonb) 
         RETURNING id, email, full_name, avatar, grade, subjects, onboarding_complete, notifications_enabled`,
        [email, fullName || '', googleId]
      );

      user = result.rows[0];
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
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
        avatar: user.avatar,
        grade: user.grade,
        subjects: user.subjects || [],
        onboarding_complete: user.onboarding_complete,
        notifications_enabled: user.notifications_enabled
      }
    });

  } catch (error) {
    console.error('❌ Google auth error:', error.message);
    console.error('Full error:', error);
    res.status(500).json({ status: 'error', error: 'Google authentication failed: ' + error.message });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, full_name, avatar, grade, subjects, onboarding_complete, notifications_enabled FROM users WHERE id = $1',
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

// POST /api/auth/complete-onboarding
router.post('/complete-onboarding', authMiddleware, async (req, res) => {
  const { subjects, grade, avatar, full_name, notifications_enabled } = req.body;

  try {
    const subjectsJson = JSON.stringify(Array.isArray(subjects) ? subjects : []);

    const result = await pool.query(
      `UPDATE users 
       SET subjects = $1::jsonb, 
           grade = $2, 
           avatar = $3, 
           full_name = $4,
           notifications_enabled = $5,
           onboarding_complete = true,
           updated_at = NOW()
       WHERE id = $6
       RETURNING id, email, full_name, avatar, grade, subjects, onboarding_complete, notifications_enabled`,
      [
        subjectsJson,
        grade || null,
        avatar || 'AVO',
        full_name || '',
        notifications_enabled || false,
        req.user.id
      ]
    );

    console.log(`✅ Onboarding completed for user ${req.user.id}`);

    res.json({ 
      status: 'success', 
      user: result.rows[0] 
    });

  } catch (error) {
    console.error('Complete onboarding error:', error);
    res.status(500).json({ status: 'error', error: 'Failed to complete onboarding.' });
  }
});

// PUT /api/auth/update-subjects
router.put('/update-subjects', authMiddleware, async (req, res) => {
  const { subjects, plan } = req.body;

  if (!Array.isArray(subjects)) {
    return res.status(400).json({ status: 'error', error: 'Subjects must be an array.' });
  }

  try {
    // Determine cap: prefer DB subscription, fall back to URL-supplied plan
    const subResult = await pool.query(
      `SELECT package, status, end_date FROM smartclass_subscriptions WHERE user_id = $1`,
      [String(req.user.id)]
    );

    let cap = 2;

    if (subResult.rows.length > 0) {
      const sub = subResult.rows[0];
      const now = new Date();
      const end = sub.end_date ? new Date(sub.end_date) : null;
      const active = sub.status === 'active' || (sub.status === 'cancelled' && end && end > now);
      if (active && sub.package === 'Standard') cap = 4;
    } else if (plan === 'standard') {
      // Webhook hasn't landed yet — trust the frontend's plan=standard
      cap = 4;
      console.log(`⏳ update-subjects: trusting plan=standard for user ${req.user.id} (webhook pending)`);
    }

    if (subjects.length > cap) {
      return res.status(403).json({
        status: 'error',
        error: `Your plan allows up to ${cap} subjects. Upgrade to add more.`,
      });
    }

    // users.subjects is jsonb — stringify it
    const subjectsJson = JSON.stringify(subjects);

    const result = await pool.query(
      `UPDATE users 
       SET subjects = $1::jsonb, updated_at = NOW()
       WHERE id = $2
       RETURNING id, email, subjects`,
      [subjectsJson, req.user.id]
    );

    // Keep subscription record in sync — also jsonb
    await pool.query(
      `UPDATE smartclass_subscriptions 
       SET subjects = $1::jsonb, updated_at = NOW() 
       WHERE user_id = $2`,
      [subjectsJson, String(req.user.id)]
    );

    console.log(`✅ Subjects updated for user ${req.user.id}:`, subjects);

    res.json({ 
      status: 'success', 
      user: result.rows[0] 
    });

  } catch (error) {
    console.error('Update subjects error:', error);
    res.status(500).json({ status: 'error', error: 'Failed to update subjects.' });
  }
});

// PUT /api/auth/update-notifications
router.put('/update-notifications', authMiddleware, async (req, res) => {
  const { enabled } = req.body;

  try {
    const result = await pool.query(
      `UPDATE users 
       SET notifications_enabled = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, notifications_enabled`,
      [enabled, req.user.id]
    );

    res.json({ 
      status: 'success', 
      notifications_enabled: result.rows[0].notifications_enabled 
    });

  } catch (error) {
    console.error('Update notifications error:', error);
    res.status(500).json({ status: 'error', error: 'Failed to update notifications.' });
  }
});

module.exports = router;