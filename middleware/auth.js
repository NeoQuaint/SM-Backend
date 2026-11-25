const pool = require('../db');
const jwt = require('jsonwebtoken');

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      status: 'error', 
      error: 'Access denied. No token provided.' 
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'smartclass_dev_secret');
    const account=await pool.query('SELECT 1 FROM users WHERE id::text=$1 AND deletion_started_at IS NULL',[String(decoded.id)]);
    if(!account.rowCount)return res.status(401).json({status:'error',error:'Account no longer available.'});
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ 
      status: 'error', 
      error: 'Invalid or expired token.' 
    });
  }
};

module.exports = authMiddleware;