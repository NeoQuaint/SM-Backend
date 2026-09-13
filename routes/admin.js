const express = require('express');
const router = express.Router();
const pool = require('../db');
const requireAdmin = require('../middleware/requireAdmin');

// ====================
// STATS OVERVIEW
// ====================
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Users
    const totalUsers = await pool.query('SELECT COUNT(*) FROM users');
    const usersToday = await pool.query('SELECT COUNT(*) FROM users WHERE created_at >= $1', [today]);
    const usersWeek = await pool.query('SELECT COUNT(*) FROM users WHERE created_at >= $1', [weekAgo]);
    const usersMonth = await pool.query('SELECT COUNT(*) FROM users WHERE created_at >= $1', [monthAgo]);

    // Subscriptions
    const subStats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'active' AND package = 'Basic') AS basic_active,
        COUNT(*) FILTER (WHERE status = 'active' AND package = 'Standard') AS standard_active,
        COUNT(*) FILTER (WHERE status = 'cancelled' AND end_date > NOW()) AS cancelled_active,
        COUNT(*) FILTER (WHERE status = 'cancelled' AND (end_date IS NULL OR end_date <= NOW())) AS expired
      FROM smartclass_subscriptions
    `);

    // Revenue
    const revenue = await pool.query(`
      SELECT 
        COALESCE(SUM(amount) FILTER (WHERE status = 'completed' AND package IN ('Basic', 'Standard')), 0) AS total_sub_revenue,
        COALESCE(SUM(amount) FILTER (WHERE status = 'completed' AND package = 'swap_fee'), 0) AS total_swap_revenue,
        COALESCE(SUM(amount) FILTER (WHERE status = 'completed' AND completed_at >= $1), 0) AS revenue_today,
        COALESCE(SUM(amount) FILTER (WHERE status = 'completed' AND completed_at >= $2), 0) AS revenue_week,
        COALESCE(SUM(amount) FILTER (WHERE status = 'completed' AND completed_at >= $3), 0) AS revenue_month
      FROM smartclass_subscription_payments
    `, [today, weekAgo, monthAgo]);

    // MRR
    const mrr = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS mrr
      FROM smartclass_subscriptions
      WHERE status = 'active' OR (status = 'cancelled' AND end_date > NOW())
    `);

    // Support
    const support = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'open') AS open_tickets,
        COUNT(*) AS total_tickets
      FROM support_tickets
    `);

    // Payments counts
    const paymentStats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed
      FROM smartclass_subscription_payments
    `);

    res.json({
      success: true,
      stats: {
        users: {
          total: parseInt(totalUsers.rows[0].count),
          today: parseInt(usersToday.rows[0].count),
          week: parseInt(usersWeek.rows[0].count),
          month: parseInt(usersMonth.rows[0].count)
        },
        subscriptions: {
          basic_active: parseInt(subStats.rows[0].basic_active),
          standard_active: parseInt(subStats.rows[0].standard_active),
          cancelled_active: parseInt(subStats.rows[0].cancelled_active),
          expired: parseInt(subStats.rows[0].expired),
          total_active: parseInt(subStats.rows[0].basic_active) + parseInt(subStats.rows[0].standard_active) + parseInt(subStats.rows[0].cancelled_active)
        },
        revenue: {
          total_sub: parseFloat(revenue.rows[0].total_sub_revenue),
          total_swap: parseFloat(revenue.rows[0].total_swap_revenue),
          today: parseFloat(revenue.rows[0].revenue_today),
          week: parseFloat(revenue.rows[0].revenue_week),
          month: parseFloat(revenue.rows[0].revenue_month),
          mrr: parseFloat(mrr.rows[0].mrr)
        },
        support: {
          open: parseInt(support.rows[0].open_tickets),
          total: parseInt(support.rows[0].total_tickets)
        },
        payments: {
          completed: parseInt(paymentStats.rows[0].completed),
          pending: parseInt(paymentStats.rows[0].pending),
          failed: parseInt(paymentStats.rows[0].failed)
        }
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// USERS LIST
// ====================
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const { search, limit = 100, offset = 0 } = req.query;

    let query = `
      SELECT 
        u.id, u.email, u.full_name, u.grade, u.subjects,
        u.onboarding_complete, u.created_at,
        s.package, s.status AS sub_status, s.end_date
      FROM users u
      LEFT JOIN smartclass_subscriptions s ON s.user_id = u.email
    `;
    const params = [];

    if (search) {
      query += ` WHERE u.email ILIKE $1 OR u.full_name ILIKE $1`;
      params.push(`%${search}%`);
    }

    query += ` ORDER BY u.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    const countResult = await pool.query('SELECT COUNT(*) FROM users');

    res.json({
      success: true,
      total: parseInt(countResult.rows[0].count),
      users: result.rows
    });
  } catch (error) {
    console.error('Users list error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// USER DETAIL
// ====================
router.get('/users/:email', requireAdmin, async (req, res) => {
  try {
    const { email } = req.params;

    const userResult = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const payments = await pool.query(
      `SELECT * FROM smartclass_subscription_payments 
       WHERE user_id = $1 ORDER BY created_at DESC`,
      [email]
    );

    const subscription = await pool.query(
      `SELECT * FROM smartclass_subscriptions 
       WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [email]
    );

    res.json({
      success: true,
      user: userResult.rows[0],
      payments: payments.rows,
      subscription: subscription.rows[0] || null
    });
  } catch (error) {
    console.error('User detail error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// SUBSCRIPTIONS LIST
// ====================
router.get('/subscriptions', requireAdmin, async (req, res) => {
  try {
    const { status, package: pkg, limit = 100, offset = 0 } = req.query;

    let query = `
      SELECT 
        s.*, u.full_name, u.grade
      FROM smartclass_subscriptions s
      LEFT JOIN users u ON u.email = s.user_id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      params.push(status);
      query += ` AND s.status = $${params.length}`;
    }

    if (pkg) {
      params.push(pkg);
      query += ` AND s.package = $${params.length}`;
    }

    query += ` ORDER BY s.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    res.json({ success: true, subscriptions: result.rows });
  } catch (error) {
    console.error('Subscriptions list error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// FORCE CANCEL SUBSCRIPTION
// ====================
router.post('/subscriptions/:userId/cancel', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    await pool.query(
      `UPDATE smartclass_subscriptions 
       SET status = 'cancelled', end_date = NOW(), updated_at = NOW() 
       WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );

    console.log(`✅ Admin ${req.admin.email} force-cancelled ${userId}`);

    res.json({ success: true, message: 'Subscription force-cancelled' });
  } catch (error) {
    console.error('Force cancel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// PAYMENTS LIST
// ====================
router.get('/payments', requireAdmin, async (req, res) => {
  try {
    const { status, package: pkg, limit = 100, offset = 0 } = req.query;

    let query = `
      SELECT p.*, u.full_name, u.email
      FROM smartclass_subscription_payments p
      LEFT JOIN users u ON u.email = p.user_id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      params.push(status);
      query += ` AND p.status = $${params.length}`;
    }

    if (pkg) {
      params.push(pkg);
      query += ` AND p.package = $${params.length}`;
    }

    query += ` ORDER BY p.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    res.json({ success: true, payments: result.rows });
  } catch (error) {
    console.error('Payments list error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// SUPPORT TICKETS
// ====================
router.get('/support', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM support_tickets ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ success: true, tickets: result.rows });
  } catch (error) {
    console.error('Support list error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// RESOLVE TICKET
// ====================
router.patch('/support/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    await pool.query(
      `UPDATE support_tickets 
       SET status = $1, resolved_at = CASE WHEN $1 = 'resolved' THEN NOW() ELSE NULL END 
       WHERE id = $2`,
      [status || 'resolved', id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Resolve ticket error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;