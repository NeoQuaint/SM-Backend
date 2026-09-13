const jwt = require('jsonwebtoken');
const pool = require('../db');

const requireAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ success: false, error: 'Admin auth required' });
    }

    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET || 'smartclass_admin_secret');
    const result = await pool.query(
      'SELECT id, email, full_name, is_super_admin FROM admins WHERE id = $1',
      [decoded.adminId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Admin not found' });
    }

    req.admin = result.rows[0];
    next();
  } catch (error) {
    console.error('Admin auth error:', error);
    res.status(401).json({ success: false, error: 'Invalid admin token' });
  }
};

module.exports = requireAdmin;