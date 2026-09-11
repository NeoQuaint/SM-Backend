const express = require('express');
const router = express.Router();
const pool = require('../db');

const YOCO_API = 'https://payments.yoco.com/api/checkouts';
const YOCO_SECRET_KEY = process.env.YOCO_SECRET_KEY_SMARTCLASS;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.smartclasss.com';
const YOCO_TIMEOUT = 15000;
const MAX_RETRIES = 3;

// Package definitions
const PACKAGES = {
  'basic': { price: 39, subjectsAllowed: 2, name: 'Basic' },
  'standard': { price: 59, subjectsAllowed: 4, name: 'Standard' }
};

// Swap fee constant
const SWAP_FEE = 19;

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

// ====================
// CREATE SUBSCRIPTION CHECKOUT (Basic R39 / Standard R59)
// ====================
router.post('/create-subscription-checkout', async (req, res) => {
  try {
    const { package: pkg, email, userId } = req.body;
    
    const packageKey = pkg?.toLowerCase();
    if (!packageKey || !PACKAGES[packageKey]) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid package. Must be "basic" or "standard"' 
      });
    }

    const packageDetails = PACKAGES[packageKey];
    const amount = packageDetails.price;
    const userIdentifier = userId || email || 'guest';
    const customerEmail = email || 'student@smartclass.co.za';
    const amountInCents = amount * 100;
    
    const requestBody = {
      amount: amountInCents,
      currency: 'ZAR',
      successUrl: `${FRONTEND_URL}/payment-success?package=${packageKey}`,
      cancelUrl: `${FRONTEND_URL}/payment/cancel`,
      failureUrl: `${FRONTEND_URL}/payment/cancel`,
      customer: { 
        email: customerEmail, 
        name: 'SmartClass Student' 
      },
      metadata: { 
        userId: String(userIdentifier), 
        type: 'subscription', 
        package: packageDetails.name,
        subjectsAllowed: packageDetails.subjectsAllowed,
        description: `${packageDetails.name} Package - R${amount}/month`
      }
    };
    
    console.log(`💳 Creating ${packageDetails.name} checkout for ${userIdentifier}: R${amount}`);
    
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
        error: data.message || 'Failed to create checkout' 
      });
    }
    
    if (data.id && data.redirectUrl) {
      await pool.query(
        `INSERT INTO smartclass_subscription_payments 
         (user_id, checkout_id, package, amount, status, created_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW())`,
        [String(userIdentifier), data.id, packageDetails.name, amount]
      );
      
      console.log(`✅ ${packageDetails.name} checkout created: ${data.id}`);
      
      res.json({ 
        success: true, 
        checkoutId: data.id, 
        redirectUrl: data.redirectUrl,
        package: packageDetails.name,
        amount: amount
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: 'No checkout created' 
      });
    }
    
  } catch (error) {
    console.error('❌ Create subscription checkout error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ====================
// CREATE SUBJECT SWAP CHECKOUT (R19)
// ====================
router.post('/create-swap-checkout', async (req, res) => {
  try {
    const { oldSubject, newSubject, email, userId } = req.body;
    
    if (!oldSubject || !newSubject) {
      return res.status(400).json({ 
        success: false, 
        error: 'Both oldSubject and newSubject are required' 
      });
    }
    
    if (oldSubject === newSubject) {
      return res.status(400).json({ 
        success: false, 
        error: 'Old and new subject cannot be the same' 
      });
    }
    
    const userIdentifier = userId || email || 'guest';
    const customerEmail = email || 'student@smartclass.co.za';
    const amountInCents = SWAP_FEE * 100;
    
    const requestBody = {
      amount: amountInCents,
      currency: 'ZAR',
      successUrl: `${FRONTEND_URL}/profile?swap=success&old=${encodeURIComponent(oldSubject)}&new=${encodeURIComponent(newSubject)}`,
      cancelUrl: `${FRONTEND_URL}/profile?swap=cancelled`,
      failureUrl: `${FRONTEND_URL}/profile?swap=cancelled`,
      customer: { 
        email: customerEmail, 
        name: 'SmartClass Student' 
      },
      metadata: { 
        userId: String(userIdentifier), 
        type: 'swap_fee', 
        oldSubject, 
        newSubject,
        description: `Subject Swap: ${oldSubject} → ${newSubject}`
      }
    };
    
    console.log(`🔄 Creating swap checkout: ${oldSubject} → ${newSubject} for ${userIdentifier}`);
    
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
        error: data.message || 'Failed to create swap checkout' 
      });
    }
    
    if (data.id && data.redirectUrl) {
      await pool.query(
        `INSERT INTO smartclass_subscription_payments 
         (user_id, checkout_id, package, amount, status, created_at)
         VALUES ($1, $2, 'swap_fee', $3, 'pending', NOW())`,
        [String(userIdentifier), data.id, SWAP_FEE]
      );
      
      console.log(`✅ Swap checkout created: ${data.id}`);
      
      res.json({ 
        success: true, 
        checkoutId: data.id, 
        redirectUrl: data.redirectUrl,
        amount: SWAP_FEE,
        oldSubject,
        newSubject
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: 'No checkout created' 
      });
    }
    
  } catch (error) {
    console.error('❌ Create swap checkout error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ====================
// AUTO-VERIFY LATEST PENDING PAYMENT
// (Doesn't need checkout ID from frontend)
// ====================
router.post('/auto-verify-latest', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId required' });
    }
    
    console.log(`🔍 Auto-verifying latest pending for: ${userId}`);
    
    // Get latest pending payment for this user
    const pendingResult = await pool.query(
      `SELECT checkout_id, package, amount 
       FROM smartclass_subscription_payments 
       WHERE user_id = $1 AND status = 'pending' 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [String(userId)]
    );
    
    if (pendingResult.rows.length === 0) {
      // No pending - check if already subscribed
      const completedResult = await pool.query(
        `SELECT * FROM smartclass_subscriptions 
         WHERE user_id = $1 AND status = 'active'`,
        [String(userId)]
      );
      
      if (completedResult.rows.length > 0) {
        const sub = completedResult.rows[0];
        console.log(`✅ Already subscribed: ${userId} → ${sub.package}`);
        return res.json({
          success: true,
          hasSubscription: true,
          subscription: {
            package: sub.package,
            amount: parseFloat(sub.amount),
            subjectsAllowed: sub.package === 'Standard' ? 4 : 2
          }
        });
      }
      
      console.log(`⚠️ No pending payment found for ${userId}`);
      return res.json({ success: false, message: 'No pending payment found' });
    }
    
    const payment = pendingResult.rows[0];
    const checkoutId = payment.checkout_id;
    
    console.log(`🎯 Found pending checkout: ${checkoutId}`);
    
    // Verify with Yoco
    const { response, data: checkout } = await yocoFetch(
      `${YOCO_API}/${checkoutId}`,
      { headers: { 'Authorization': `Bearer ${YOCO_SECRET_KEY}` } }
    );
    
    if (!response.ok) {
      return res.status(500).json({ success: false, error: 'Yoco verify failed' });
    }
    
    console.log(`📊 Yoco status for ${checkoutId}: ${checkout.status}`);
    
    if (checkout.status === 'COMPLETED' || checkout.status === 'completed') {
      const amount = (checkout.amount / 100).toFixed(2);
      const metadata = checkout.metadata || {};
      const pkg = metadata.package || payment.package || 'Basic';
      
      await pool.query(
        `UPDATE smartclass_subscription_payments 
         SET status = 'completed', completed_at = NOW() 
         WHERE checkout_id = $1`,
        [checkoutId]
      );
      
      await pool.query(`
        INSERT INTO smartclass_subscriptions 
        (user_id, package, amount, status, payment_reference, created_at, updated_at)
        VALUES ($1, $2, $3, 'active', $4, NOW(), NOW())
        ON CONFLICT (user_id) 
        DO UPDATE SET 
          package = EXCLUDED.package,
          amount = EXCLUDED.amount,
          status = 'active',
          payment_reference = EXCLUDED.payment_reference,
          updated_at = NOW()
      `, [String(userId), pkg, amount, checkoutId]);
      
      console.log(`✅ Auto-verified subscription: ${userId} → ${pkg} (R${amount})`);
      
      return res.json({
        success: true,
        hasSubscription: true,
        subscription: {
          package: pkg,
          amount: parseFloat(amount),
          subjectsAllowed: pkg === 'Standard' ? 4 : 2
        }
      });
    } else if (checkout.status === 'PENDING' || checkout.status === 'pending') {
      return res.json({ success: false, status: 'pending', message: 'Still processing' });
    } else {
      await pool.query(
        `UPDATE smartclass_subscription_payments SET status = 'failed' WHERE checkout_id = $1`,
        [checkoutId]
      );
      return res.json({ success: false, status: checkout.status, message: 'Payment failed' });
    }
    
  } catch (error) {
    console.error('❌ Auto-verify error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// VERIFY PAYMENT (with checkout ID)
// ====================
router.post('/verify-payment', async (req, res) => {
  try {
    const { checkoutId, email, userId } = req.body;
    
    if (!checkoutId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Checkout ID required' 
      });
    }
    
    console.log(`🔍 Verifying payment: ${checkoutId}`);
    
    const { response, data: checkout } = await yocoFetch(
      `${YOCO_API}/${checkoutId}`,
      {
        headers: { 
          'Authorization': `Bearer ${YOCO_SECRET_KEY}` 
        }
      }
    );
    
    if (!response.ok) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to verify payment' 
      });
    }
    
    if (checkout.status === 'COMPLETED' || checkout.status === 'completed') {
      const userIdentifier = userId || email || 'guest';
      const amount = (checkout.amount / 100).toFixed(2);
      const metadata = checkout.metadata || {};
      const pkg = metadata.package || 'Basic';
      const paymentType = metadata.type || 'subscription';
      
      await pool.query(
        `UPDATE smartclass_subscription_payments 
         SET status = 'completed', completed_at = NOW() 
         WHERE checkout_id = $1`,
        [checkoutId]
      );
      
      if (paymentType === 'subscription') {
        await pool.query(`
          INSERT INTO smartclass_subscriptions 
          (user_id, package, amount, status, payment_reference, created_at, updated_at)
          VALUES ($1, $2, $3, 'active', $4, NOW(), NOW())
          ON CONFLICT (user_id) 
          DO UPDATE SET 
            package = EXCLUDED.package,
            amount = EXCLUDED.amount,
            status = 'active',
            payment_reference = EXCLUDED.payment_reference,
            updated_at = NOW()
        `, [String(userIdentifier), pkg, amount, checkoutId]);
        
        console.log(`✅ Subscription activated: ${userIdentifier} → ${pkg} (R${amount})`);
        
        res.json({ 
          success: true, 
          hasSubscription: true, 
          subscription: { 
            package: pkg, 
            amount: parseFloat(amount),
            subjectsAllowed: pkg === 'Standard' ? 4 : 2
          } 
        });
        
      } else if (paymentType === 'swap_fee') {
        const { oldSubject, newSubject } = metadata;
        
        console.log(`✅ Subject swap paid: ${oldSubject} → ${newSubject}`);
        
        res.json({ 
          success: true, 
          swapCompleted: true,
          oldSubject,
          newSubject
        });
      } else {
        res.json({ success: true });
      }
      
    } else if (checkout.status === 'PENDING' || checkout.status === 'pending') {
      res.json({ 
        success: false, 
        status: 'pending', 
        message: 'Payment still processing' 
      });
    } else {
      await pool.query(
        `UPDATE smartclass_subscription_payments 
         SET status = 'failed' 
         WHERE checkout_id = $1`,
        [checkoutId]
      );
      
      res.json({ 
        success: false, 
        status: checkout.status, 
        message: 'Payment not completed' 
      });
    }
    
  } catch (error) {
    console.error('❌ Verify payment error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ====================
// CHECK SUBSCRIPTION STATUS
// ====================
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
      `SELECT * FROM smartclass_subscriptions 
       WHERE user_id = $1 AND status = 'active'`,
      [String(userId)]
    );
    
    if (result.rows.length > 0) {
      const sub = result.rows[0];
      res.json({ 
        success: true, 
        hasSubscription: true, 
        subscription: {
          package: sub.package,
          amount: parseFloat(sub.amount),
          subjectsAllowed: sub.package === 'Standard' ? 4 : 2
        }
      });
    } else {
      res.json({ 
        success: true, 
        hasSubscription: false 
      });
    }
    
  } catch (error) {
    console.error('❌ Check subscription error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ====================
// CHECK LATEST PAYMENT
// ====================
router.get('/check-latest-payment', async (req, res) => {
  try {
    const userId = req.query.userId || req.query.email || 'guest';
    
    const result = await pool.query(
      `SELECT checkout_id, package, status 
       FROM smartclass_subscription_payments 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [String(userId)]
    );
    
    if (result.rows.length > 0) {
      res.json({ 
        success: true,
        checkoutId: result.rows[0].checkout_id,
        package: result.rows[0].package,
        status: result.rows[0].status
      });
    } else {
      res.json({ 
        success: true,
        checkoutId: null 
      });
    }
    
  } catch (error) {
    console.error('❌ Check latest payment error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ====================
// CANCEL SUBSCRIPTION
// ====================
router.post('/cancel-subscription', async (req, res) => {
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

module.exports = router;