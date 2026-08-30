const express = require('express');
const router = express.Router();
const pool = require('../db');

const YOCO_API = 'https://payments.yoco.com/api/checkouts';
const YOCO_SECRET_KEY = process.env.YOCO_SECRET_KEY_SMARTCLASS;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.smartclasss.com';
const YOCO_TIMEOUT = 15000;
const MAX_RETRIES = 3;

// YOCO API HELPER
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

// CREATE SUBSCRIPTION CHECKOUT
router.post('/create-subscription-checkout', async (req, res) => {
  try {
    const { amount, package: pkg, email, userId } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }
    
    const userIdentifier = userId || email || 'guest';
    const customerEmail = email || 'student@smartclass.co.za';
    const amountInCents = Math.round(amount * 100);
    
    const requestBody = {
      amount: amountInCents,
      currency: 'ZAR',
      successUrl: `${FRONTEND_URL}/payment/success`,
      cancelUrl: `${FRONTEND_URL}/payment/cancel`,
      failureUrl: `${FRONTEND_URL}/payment/cancel`,
      customer: { email: customerEmail, name: 'SmartClass Student' },
      metadata: { userId: String(userIdentifier), type: 'subscription', package: pkg }
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
      return res.status(response.status).json({ success: false, error: data.message || 'Failed to create checkout' });
    }
    
    if (data.id && data.redirectUrl) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS smartclass_subscription_payments (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
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
        [String(userIdentifier), data.id, pkg, amount]
      );
      
      res.json({ success: true, checkoutId: data.id, redirectUrl: data.redirectUrl });
    } else {
      res.status(500).json({ success: false, error: 'No checkout created' });
    }
    
  } catch (error) {
    console.error('❌ Create subscription checkout error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// CREATE SWAP FEE CHECKOUT (R19)
router.post('/create-swap-checkout', async (req, res) => {
  try {
    const { amount, oldSubject, newSubject, email, userId } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }
    
    const userIdentifier = userId || email || 'guest';
    const customerEmail = email || 'student@smartclass.co.za';
    const amountInCents = Math.round(amount * 100);
    
    const requestBody = {
      amount: amountInCents,
      currency: 'ZAR',
      successUrl: `${FRONTEND_URL}/profile?swap=success`,
      cancelUrl: `${FRONTEND_URL}/profile?swap=cancelled`,
      failureUrl: `${FRONTEND_URL}/profile?swap=cancelled`,
      customer: { email: customerEmail, name: 'SmartClass Student' },
      metadata: { userId: String(userIdentifier), type: 'swap_fee', oldSubject, newSubject }
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
      return res.status(response.status).json({ success: false, error: data.message || 'Failed to create checkout' });
    }
    
    if (data.id && data.redirectUrl) {
      await pool.query(
        `INSERT INTO smartclass_subscription_payments (user_id, checkout_id, package, amount, status, created_at)
         VALUES ($1, $2, 'swap_fee', $3, 'pending', NOW())`,
        [String(userIdentifier), data.id, amount]
      );
      
      res.json({ success: true, checkoutId: data.id, redirectUrl: data.redirectUrl });
    } else {
      res.status(500).json({ success: false, error: 'No checkout created' });
    }
    
  } catch (error) {
    console.error('❌ Create swap checkout error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// VERIFY PAYMENT VIA API (works without webhooks)
router.post('/verify-payment', async (req, res) => {
  try {
    const { checkoutId, email, userId } = req.body;
    
    if (!checkoutId) {
      return res.status(400).json({ success: false, error: 'Checkout ID required' });
    }
    
    const { response, data: checkout } = await yocoFetch(
      `https://payments.yoco.com/api/checkouts/${checkoutId}`,
      {
        headers: { 'Authorization': `Bearer ${YOCO_SECRET_KEY}` }
      }
    );
    
    if (!response.ok) {
      return res.status(500).json({ success: false, error: 'Failed to verify payment' });
    }
    
    if (checkout.status === 'COMPLETED' || checkout.status === 'completed') {
      const userIdentifier = userId || email || 'guest';
      const amount = (checkout.amount / 100).toFixed(2);
      const pkg = checkout.metadata?.package || 'Basic';
      
      await pool.query(
        `UPDATE smartclass_subscription_payments SET status = 'completed', completed_at = NOW() WHERE checkout_id = $1`,
        [checkoutId]
      );
      
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
      `, [String(userIdentifier), pkg, amount, checkoutId]);
      
      res.json({ success: true, hasSubscription: true, subscription: { package: pkg, amount: parseFloat(amount) } });
    } else if (checkout.status === 'PENDING' || checkout.status === 'pending') {
      res.json({ success: false, status: 'pending', message: 'Payment still processing' });
    } else {
      res.json({ success: false, status: checkout.status, message: 'Payment not completed' });
    }
    
  } catch (error) {
    console.error('❌ Verify payment error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// CHECK SUBSCRIPTION STATUS
router.get('/check-subscription', async (req, res) => {
  try {
    const userId = req.query.userId || req.query.email || 'guest';
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS smartclass_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
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
      [String(userId)]
    );
    
    if (result.rows.length > 0) {
      res.json({ success: true, hasSubscription: true, subscription: result.rows[0] });
    } else {
      res.json({ success: true, hasSubscription: false });
    }
    
  } catch (error) {
    console.error('❌ Check subscription error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// CHECK LATEST PAYMENT (fallback when no checkout ID in URL)
router.get('/check-latest-payment', async (req, res) => {
  try {
    const userId = req.query.userId || req.query.email || 'guest';
    
    const result = await pool.query(
      `SELECT checkout_id FROM smartclass_subscription_payments 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [String(userId)]
    );
    
    if (result.rows.length > 0) {
      res.json({ checkoutId: result.rows[0].checkout_id });
    } else {
      res.json({ checkoutId: null });
    }
    
  } catch (error) {
    console.error('❌ Check latest payment error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// CANCEL SUBSCRIPTION
router.post('/cancel-subscription', async (req, res) => {
  try {
    const { userId } = req.body;
    
    await pool.query(
      `UPDATE smartclass_subscriptions SET status = 'cancelled', updated_at = NOW() WHERE user_id = $1 AND status = 'active'`,
      [String(userId)]
    );
    
    res.json({ success: true, message: 'Subscription cancelled' });
    
  } catch (error) {
    console.error('❌ Cancel subscription error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;