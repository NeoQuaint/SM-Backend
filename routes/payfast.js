const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
const PAYFAST_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY;
const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE;
const PAYFAST_TEST_MODE = process.env.PAYFAST_TEST_MODE === 'true';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://sm-simple.vercel.app';
const BACKEND_URL = process.env.BACKEND_URL || 'https://smartclass-wlgb.onrender.com';

// ====================
// PAYFAST SIGNATURE GENERATOR
// ====================
const generatePayFastSignature = (data, passphrase = null) => {
  let pfOutput = '';
  const sortedKeys = Object.keys(data).sort();
  
  for (const key of sortedKeys) {
    if (data[key] !== '' && data[key] !== null && data[key] !== undefined) {
      pfOutput += `${key}=${encodeURIComponent(data[key]).replace(/%20/g, '+')}&`;
    }
  }
  
  let getString = pfOutput.slice(0, -1);
  
  if (passphrase !== null && passphrase !== '') {
    getString += `&passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}`;
  }
  
  return crypto.createHash('md5').update(getString).digest('hex');
};

// ====================
// VERIFY PAYFAST SIGNATURE
// ====================
const verifyPayFastSignature = (data, signature) => {
  const generatedSignature = generatePayFastSignature(data, PAYFAST_PASSPHRASE);
  return generatedSignature === signature;
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
    
    if (!customerEmail) {
      const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
      if (userResult.rows.length > 0) {
        customerEmail = userResult.rows[0].email;
      }
    }
    
    const paymentId = `SM-SUB-${Date.now()}-${userId}`;
    
    const paymentData = {
      merchant_id: PAYFAST_MERCHANT_ID,
      merchant_key: PAYFAST_MERCHANT_KEY,
      return_url: `${FRONTEND_URL}/payment/success`,
      cancel_url: `${FRONTEND_URL}/payment/cancel`,
      notify_url: `${BACKEND_URL}/api/payfast/webhook`,
      m_payment_id: paymentId,
      amount: amount.toFixed(2),
      item_name: `${pkg} Subscription - SmartClass`,
      item_description: `Monthly subscription for ${pkg} package`,
      email_address: customerEmail,
      custom_str1: userId.toString(),
      custom_str2: pkg,
      custom_str3: 'subscription',
      subscription_type: '1',
      billing_date: new Date().toISOString().split('T')[0],
      recurring_amount: amount.toFixed(2),
      frequency: '3',
      cycles: '0',
    };
    
    paymentData.signature = generatePayFastSignature(paymentData, PAYFAST_PASSPHRASE);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS smartclass_subscription_payments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        payment_id VARCHAR(255) NOT NULL,
        package VARCHAR(50),
        amount DECIMAL(10,2),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP,
        UNIQUE(payment_id)
      )
    `);
    
    await pool.query(
      `INSERT INTO smartclass_subscription_payments (user_id, payment_id, package, amount, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())`,
      [userId, paymentId, pkg, amount]
    );
    
    res.json({
      success: true,
      paymentData,
      payfastUrl: PAYFAST_TEST_MODE 
        ? 'https://sandbox.payfast.co.za/eng/process'
        : 'https://www.payfast.co.za/eng/process'
    });
    
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
    
    if (!customerEmail) {
      const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
      if (userResult.rows.length > 0) {
        customerEmail = userResult.rows[0].email;
      }
    }
    
    const paymentId = `SM-SWAP-${Date.now()}-${userId}`;
    
    const paymentData = {
      merchant_id: PAYFAST_MERCHANT_ID,
      merchant_key: PAYFAST_MERCHANT_KEY,
      return_url: `${FRONTEND_URL}/profile?swap=success`,
      cancel_url: `${FRONTEND_URL}/profile?swap=cancelled`,
      notify_url: `${BACKEND_URL}/api/payfast/webhook`,
      m_payment_id: paymentId,
      amount: amount.toFixed(2),
      item_name: 'Subject Swap Fee',
      item_description: `Swap ${oldSubject} to ${newSubject}`,
      email_address: customerEmail,
      custom_str1: userId.toString(),
      custom_str2: 'swap_fee',
      custom_str3: `${oldSubject}->${newSubject}`,
    };
    
    paymentData.signature = generatePayFastSignature(paymentData, PAYFAST_PASSPHRASE);
    
    await pool.query(
      `INSERT INTO smartclass_subscription_payments (user_id, payment_id, package, amount, status, created_at)
       VALUES ($1, $2, 'swap_fee', $3, 'pending', NOW())`,
      [userId, paymentId, amount]
    );
    
    res.json({
      success: true,
      paymentData,
      payfastUrl: PAYFAST_TEST_MODE 
        ? 'https://sandbox.payfast.co.za/eng/process'
        : 'https://www.payfast.co.za/eng/process'
    });
    
  } catch (error) {
    console.error('❌ Create swap checkout error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// PAYFAST WEBHOOK (ITN)
// ====================
router.post('/webhook', async (req, res) => {
  try {
    const pfData = req.body;
    const signature = pfData.signature;
    
    delete pfData.signature;
    
    if (!verifyPayFastSignature(pfData, signature)) {
      console.log('❌ Invalid PayFast signature');
      return res.status(400).json({ received: false, error: 'Invalid signature' });
    }
    
    const paymentId = pfData.m_payment_id;
    const paymentStatus = pfData.payment_status;
    const amount = pfData.amount_gross;
    const userId = pfData.custom_str1;
    const pkg = pfData.custom_str2;
    const customData = pfData.custom_str3;
    
    console.log('📩 PayFast webhook received:', { paymentId, paymentStatus, amount, pkg });
    
    const dedupKey = `${paymentId}-${paymentStatus}`;
    if (processedWebhooks.has(dedupKey)) {
      console.log(`⏭️ Skipping duplicate webhook: ${dedupKey}`);
      return res.status(200).json({ received: true, duplicate: true });
    }
    processedWebhooks.set(dedupKey, Date.now());
    
    if (paymentStatus === 'COMPLETE') {
      await pool.query(
        `UPDATE smartclass_subscription_payments SET status = 'completed', completed_at = NOW() WHERE payment_id = $1`,
        [paymentId]
      );
      
      if (pkg === 'swap_fee') {
        const [oldSubject, newSubject] = customData.split('->');
        
        const userResult = await pool.query(
          'SELECT subjects FROM smartclass_users WHERE id = $1',
          [userId]
        );
        
        if (userResult.rows.length > 0) {
          let subjects = userResult.rows[0].subjects;
          if (typeof subjects === 'string') {
            subjects = JSON.parse(subjects);
          }
          const updatedSubjects = subjects.map(s => s === oldSubject ? newSubject : s);
          
          await pool.query(
            'UPDATE smartclass_users SET subjects = $1 WHERE id = $2',
            [JSON.stringify(updatedSubjects), userId]
          );
          
          console.log(`✅ Subject swap completed: ${oldSubject} -> ${newSubject}`);
        }
      } else {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS smartclass_subscriptions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            package VARCHAR(50),
            amount DECIMAL(10,2),
            status VARCHAR(20) DEFAULT 'active',
            payment_id VARCHAR(255),
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(user_id)
          )
        `);
        
        await pool.query(`
          INSERT INTO smartclass_subscriptions (user_id, package, amount, status, payment_id, created_at, updated_at)
          VALUES ($1, $2, $3, 'active', $4, NOW(), NOW())
          ON CONFLICT (user_id) 
          DO UPDATE SET 
            package = EXCLUDED.package,
            amount = EXCLUDED.amount,
            status = 'active',
            payment_id = EXCLUDED.payment_id,
            updated_at = NOW()
        `, [userId, pkg, amount, paymentId]);
        
        console.log(`✅ Subscription activated: User ${userId} - ${pkg} at R${amount}/month`);
      }
    }
    
    res.status(200).json({ received: true });
    
  } catch (error) {
    console.error('❌ PayFast webhook error:', error);
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
        payment_id VARCHAR(255),
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