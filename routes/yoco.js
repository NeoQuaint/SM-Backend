const express = require('express');
const router = express.Router();
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const YOCO_API = 'https://payments.yoco.com/api/checkouts';
const YOCO_SECRET_KEY = process.env.YOCO_SECRET_KEY_SMARTCLASS;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://sm-simple.vercel.app';
const YOCO_TIMEOUT = 15000;
const MAX_RETRIES = 3;

// ====================
// YOCO API HELPER
// ====================
const yocoFetch = async (url, options, retries = MAX_RETRIES) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), YOCO_TIMEOUT);
    
    const requestOptions = {
      ...options,
      signal: controller.signal,
      headers: {
        ...options.headers,
        'Idempotency-Key': `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      }
    };

    try {
      const response = await fetch(url, requestOptions);
      clearTimeout(timeoutId);
      
      const data = await response.json();
      
      if (!response.ok && response.status >= 500 && attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }
      
      return { response, data };
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (attempt < retries && (error.name === 'AbortError' || error.name === 'TypeError' || error.code === 'ECONNRESET')) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }
      
      throw error;
    }
  }
};

// ====================
// WEBHOOK DUPLICATE PREVENTION
// ====================
const processedWebhooks = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of processedWebhooks) {
    if (now - timestamp > 30 * 60 * 1000) {
      processedWebhooks.delete(key);
    }
  }
}, 5 * 60 * 1000);

// ====================
// CREATE SUBSCRIPTION CHECKOUT
// ====================
router.post('/create-subscription-checkout', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { amount, package: pkg, email } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }
    
    let customerEmail = email;
    let customerName = 'SmartClass Student';
    
    if (!customerEmail) {
      const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
      if (userResult.rows.length > 0) {
        customerEmail = userResult.rows[0].email;
      }
    }
    
    const amountInCents = Math.round(amount * 100);
    
    const requestBody = {
      amount: amountInCents,
      currency: 'ZAR',
      successUrl: `${FRONTEND_URL}/payment/success`,
      cancelUrl: `${FRONTEND_URL}/payment/cancel`,
      failureUrl: `${FRONTEND_URL}/payment/cancel`,
      customer: {
        email: customerEmail,
        name: customerName
      },
      metadata: {
        userId: userId.toString(),
        type: 'subscription',
        package: pkg
      }
    };
    
    const { response, data } = await yocoFetch(YOCO_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${YOCO_SECRET_KEY}`
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      return res.status(response.status).json({ 
        success: false, 
        error: data.message || 'Failed to create checkout',
        details: data
      });
    }
    
    if (data.id && data.redirectUrl) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS smartclass_subscription_payments (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          checkout_id VARCHAR(255) NOT NULL,
          package VARCHAR(50),
          amount DECIMAL(10,2),
          status VARCHAR(20) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT NOW(),
          completed_at TIMESTAMP,
          UNIQUE(checkout_id)
        )
      `);
      
      await pool.query(
        `INSERT INTO smartclass_subscription_payments (user_id, checkout_id, package, amount, status, created_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW())`,
        [userId, data.id, pkg, amount]
      );
      
      res.json({
        success: true,
        checkoutId: data.id,
        redirectUrl: data.redirectUrl
      });
    } else {
      res.status(500).json({ success: false, error: 'No checkout created', details: data });
    }
    
  } catch (error) {
    console.error('❌ Create subscription checkout error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// CREATE SWAP FEE CHECKOUT (R19)
// ====================
router.post('/create-swap-checkout', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { amount, oldSubject, newSubject, email } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }
    
    let customerEmail = email;
    let customerName = 'SmartClass Student';
    
    if (!customerEmail) {
      const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
      if (userResult.rows.length > 0) {
        customerEmail = userResult.rows[0].email;
      }
    }
    
    const amountInCents = Math.round(amount * 100);
    
    const requestBody = {
      amount: amountInCents,
      currency: 'ZAR',
      successUrl: `${FRONTEND_URL}/profile?swap=success`,
      cancelUrl: `${FRONTEND_URL}/profile?swap=cancelled`,
      failureUrl: `${FRONTEND_URL}/profile?swap=cancelled`,
      customer: {
        email: customerEmail,
        name: customerName
      },
      metadata: {
        userId: userId.toString(),
        type: 'swap_fee',
        oldSubject,
        newSubject
      }
    };
    
    const { response, data } = await yocoFetch(YOCO_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${YOCO_SECRET_KEY}`
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      return res.status(response.status).json({ 
        success: false, 
        error: data.message || 'Failed to create checkout',
        details: data
      });
    }
    
    if (data.id && data.redirectUrl) {
      await pool.query(
        `INSERT INTO smartclass_subscription_payments (user_id, checkout_id, package, amount, status, created_at)
         VALUES ($1, $2, 'swap_fee', $3, 'pending', NOW())`,
        [userId, data.id, amount]
      );
      
      res.json({
        success: true,
        checkoutId: data.id,
        redirectUrl: data.redirectUrl
      });
    } else {
      res.status(500).json({ success: false, error: 'No checkout created', details: data });
    }
    
  } catch (error) {
    console.error('❌ Create swap checkout error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// YOCO WEBHOOK
// ====================
router.post('/webhook', async (req, res) => {
  try {
    const event = req.body;
    const payload = event.payload || event.data || {};
    const metadata = payload.metadata || {};
    
    const checkoutId = metadata.checkoutId || payload.id || payload.checkoutId || event.id || 'unknown';
    const amount = payload.amount ? (payload.amount / 100).toFixed(2) : '0.00';
    const userId = metadata.userId;
    const paymentType = metadata.type;
    const pkg = metadata.package;
    
    console.log('📩 Yoco webhook received:', { checkoutId, amount, userId, paymentType, pkg });
    
    if (processedWebhooks.has(checkoutId)) {
      console.log(`⏭️ Skipping duplicate webhook: ${checkoutId}`);
      return res.status(200).json({ received: true, duplicate: true });
    }
    processedWebhooks.set(checkoutId, Date.now());
    
    if (event.type === 'checkout.completed' || event.type === 'payment.succeeded') {
      await pool.query(
        `UPDATE smartclass_subscription_payments SET status = 'completed', completed_at = NOW() WHERE checkout_id = $1`,
        [checkoutId]
      );
      
      if (paymentType === 'swap_fee') {
        const oldSubject = metadata.oldSubject;
        const newSubject = metadata.newSubject;
        
        const userResult = await pool.query(
          'SELECT subjects FROM users WHERE id = $1',
          [userId]
        );
        
        if (userResult.rows.length > 0) {
          let subjects = userResult.rows[0].subjects;
          if (typeof subjects === 'string') {
            try { subjects = JSON.parse(subjects); } catch(e) { subjects = []; }
          }
          const updatedSubjects = subjects.map(s => s === oldSubject ? newSubject : s);
          
          await pool.query(
            'UPDATE users SET subjects = $1 WHERE id = $2',
            [JSON.stringify(updatedSubjects), userId]
          );
          
          console.log(`✅ Subject swap completed: ${oldSubject} -> ${newSubject}`);
        }
      } else if (paymentType === 'subscription') {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS smartclass_subscriptions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            package VARCHAR(50),
            amount DECIMAL(10,2),
            status VARCHAR(20) DEFAULT 'active',
            payment_reference VARCHAR(255),
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(user_id)
          )
        `);
        
        await pool.query(`
          INSERT INTO smartclass_subscriptions (user_id, package, amount, status, payment_reference, created_at, updated_at)
          VALUES ($1, $2, $3, 'active', $4, NOW(), NOW())
          ON CONFLICT (user_id) 
          DO UPDATE SET 
            package = EXCLUDED.package,
            amount = EXCLUDED.amount,
            status = 'active',
            payment_reference = EXCLUDED.payment_reference,
            updated_at = NOW()
        `, [userId, pkg, amount, checkoutId]);
        
        console.log(`✅ Subscription activated: User ${userId} - ${pkg} at R${amount}/month`);
      }
    }
    
    res.status(200).json({ received: true });
    
  } catch (error) {
    console.error('❌ Yoco webhook error:', error);
    res.status(200).json({ received: true });
  }
});

// ====================
// CHECK SUBSCRIPTION STATUS
// ====================
router.get('/check-subscription', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS smartclass_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        package VARCHAR(50),
        amount DECIMAL(10,2),
        status VARCHAR(20) DEFAULT 'active',
        payment_reference VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id)
      )
    `);
    
    const result = await pool.query(
      `SELECT * FROM smartclass_subscriptions WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );
    
    if (result.rows.length > 0) {
      res.json({ 
        success: true, 
        hasSubscription: true, 
        subscription: result.rows[0]
      });
    } else {
      res.json({ success: true, hasSubscription: false });
    }
    
  } catch (error) {
    console.error('❌ Check subscription error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// CANCEL SUBSCRIPTION
// ====================
router.post('/cancel-subscription', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    
    await pool.query(
      `UPDATE smartclass_subscriptions SET status = 'cancelled', updated_at = NOW() WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );
    
    res.json({ success: true, message: 'Subscription cancelled' });
    
  } catch (error) {
    console.error('❌ Cancel subscription error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;