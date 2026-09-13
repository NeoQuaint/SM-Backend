const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const requireAdmin = require('../middleware/requireAdmin');

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'smartclass_admin_secret';

// ====================
// REGISTER (first admin only)
// ====================
router.post('/register', async (req, res) => {
  try {
    const { email, password, full_name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    // Check if any admin exists
    const countResult = await pool.query('SELECT COUNT(*) FROM admins');
    if (parseInt(countResult.rows[0].count) > 0) {
      return res.status(403).json({ 
        success: false, 
        error: 'Admin already exists. Use login, or ask an existing admin to add you.' 
      });
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const result = await pool.query(
      `INSERT INTO admins (email, password_hash, full_name, is_super_admin)
       VALUES ($1, $2, $3, true)
       RETURNING id, email, full_name, is_super_admin`,
      [email.toLowerCase(), password_hash, full_name || 'Super Admin']
    );

    const admin = result.rows[0];
    const token = jwt.sign(
      { adminId: admin.id, email: admin.email },
      ADMIN_JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ First admin created: ${admin.email}`);

    res.json({ success: true, token, admin });
  } catch (error) {
    console.error('Admin register error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// LOGIN
// ====================
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const result = await pool.query(
      'SELECT * FROM admins WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const admin = result.rows[0];
    const valid = await bcrypt.compare(password, admin.password_hash);

    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { adminId: admin.id, email: admin.email },
      ADMIN_JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ Admin logged in: ${admin.email}`);

    res.json({
      success: true,
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        full_name: admin.full_name,
        is_super_admin: admin.is_super_admin
      }
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// ME (verify token)
// ====================
router.get('/me', requireAdmin, async (req, res) => {
  res.json({ success: true, admin: req.admin });
});

// ====================
// LIST ADMINS
// ====================
router.get('/admins', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, full_name, is_super_admin, created_at FROM admins ORDER BY created_at ASC'
    );
    res.json({ success: true, admins: result.rows });
  } catch (error) {
    console.error('List admins error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// ADD NEW ADMIN
// ====================
router.post('/admins', requireAdmin, async (req, res) => {
  try {
    const { email, password, full_name, is_super_admin } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const existing = await pool.query('SELECT id FROM admins WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Admin already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const result = await pool.query(
      `INSERT INTO admins (email, password_hash, full_name, is_super_admin)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, full_name, is_super_admin, created_at`,
      [email.toLowerCase(), password_hash, full_name || '', is_super_admin || false]
    );

    console.log(`✅ New admin added by ${req.admin.email}: ${email}`);

    res.json({ success: true, admin: result.rows[0] });
  } catch (error) {
    console.error('Add admin error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// DELETE ADMIN
// ====================
router.delete('/admins/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Can't delete self
    if (parseInt(id) === req.admin.id) {
      return res.status(400).json({ success: false, error: "Can't delete yourself" });
    }

    await pool.query('DELETE FROM admins WHERE id = $1', [id]);

    console.log(`✅ Admin #${id} removed by ${req.admin.email}`);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete admin error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// CHANGE PASSWORD
// ====================
router.post('/change-password', requireAdmin, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, error: 'Both passwords required' });
    }

    const result = await pool.query('SELECT password_hash FROM admins WHERE id = $1', [req.admin.id]);
    const admin = result.rows[0];

    const valid = await bcrypt.compare(current_password, admin.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Current password is wrong' });
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(new_password, salt);

    await pool.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [password_hash, req.admin.id]);

    res.json({ success: true, message: 'Password changed' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;