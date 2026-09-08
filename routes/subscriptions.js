const express = require('express');
const router = express.Router();
const pool = require('../db');

// ====================
// CANCEL SUBSCRIPTION
// ====================
router.post('/cancel', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'User ID required' 
      });
    }
    
    await pool.query(
      `UPDATE smartclass_subscriptions 
       SET status = 'cancelled', updated_at = NOW() 
       WHERE user_id = $1 AND status = 'active'`,
      [String(userId)]
    );
    
    console.log(`✅ Subscription cancelled for ${userId}`);
    
    res.json({ 
      success: true, 
      message: 'Subscription cancelled successfully' 
    });
    
  } catch (error) {
    console.error('❌ Cancel subscription error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ====================
// DOWNGRADE TO BASIC
// ====================
router.post('/downgrade-basic', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'User ID required' 
      });
    }
    
    await pool.query(
      `UPDATE smartclass_subscriptions 
       SET package = 'Basic', amount = 39, updated_at = NOW() 
       WHERE user_id = $1 AND status = 'active'`,
      [String(userId)]
    );
    
    console.log(`✅ Downgraded to Basic for ${userId}`);
    
    res.json({ 
      success: true, 
      message: 'Downgraded to Basic package (R39/month)',
      subscription: {
        package: 'Basic',
        amount: 39,
        subjectsAllowed: 2
      }
    });
    
  } catch (error) {
    console.error('❌ Downgrade error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ====================
// GET CURRENT SUBSCRIPTION
// ====================
router.get('/current', async (req, res) => {
  try {
    const userId = req.query.userId;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'User ID required' 
      });
    }
    
    const result = await pool.query(
      `SELECT * FROM smartclass_subscriptions 
       WHERE user_id = $1 
       ORDER BY updated_at DESC 
       LIMIT 1`,
      [String(userId)]
    );
    
    if (result.rows.length > 0) {
      res.json({ 
        success: true, 
        subscription: result.rows[0] 
      });
    } else {
      res.json({ 
        success: true, 
        subscription: null 
      });
    }
    
  } catch (error) {
    console.error('❌ Get subscription error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;