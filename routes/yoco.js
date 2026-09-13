const express = require('express');
const router = express.Router();
const pool = require('../db');

const YOCO_API = 'https://payments.yoco.com/api/checkouts';
const YOCO_SECRET_KEY = process.env.YOCO_SECRET_KEY_SMARTCLASS;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.smartclasss.com';
const YOCO_TIMEOUT = 15000;
const MAX_RETRIES = 3;

const PACKAGES = {
  'basic': { price: 39, subjectsAllowed: 2, name: 'Basic' },
  'standard': { price: 59, subjectsAllowed: 4, name: 'Standard' }
};

const SWAP_FEE = 19;

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
// CREATE SUBSCRIPTION CHECKOUT
// ====================
router.post('/create-subscription-checkout', async (req, res) => {
  try {
    const { package: pkg, email, userId } = req.body;
    
    const packageKey = pkg?.toLowerCase();
    if (!packageKey || !PACKAGES[packageKey]) {
      return res.status(400).json({ success: false, error: 'Invalid package' });
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
      customer: { email: customerEmail, name: 'SmartClass Student' },
      metadata: { 
        userId: String(userIdentifier), 
        type: 'subscription', 
        package: packageDetails.name,
        subjectsAllowed: packageDetails.subjectsAllowed
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
      return res.status(response.status).json({ success: false, error: data.message || 'Failed' });
    }
    
    if (data.id && data.redirectUrl) {
      await pool.query(
        `INSERT INTO smartclass_subscription_payments 
         (user_id, checkout_id, package, amount, status, created_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW())`,
        [String(userIdentifier), data.id, packageDetails.name, amount]
      );
      
      res.json({ 
        success: true, 
        checkoutId: data.id, 
        redirectUrl: data.redirectUrl,
        package: packageDetails.name,
        amount: amount
      });
    } else {
      res.status(500).json({ success: false, error: 'No checkout created' });
    }
    
  } catch (error) {
    console.error('❌ Create subscription checkout error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// CREATE SWAP CHECKOUT
// ====================
router.post('/create-swap-checkout', async (req, res) => {
  try {
    const { oldSubject, newSubject, email, userId } = req.body;
    
    if (!oldSubject || !newSubject || oldSubject === newSubject) {
      return res.status(400).json({ success: false, error: 'Invalid subjects' });
    }
    
    const userIdentifier = userId || email || 'guest';
    const customerEmail = email || 'student@smartclass.co.za';
    const amountInCents = SWAP_FEE * 100;
    
    const requestBody = {
      amount: amountInCents,
      currency: 'ZAR',
      successUrl: `${FRONTEND_URL}/swap-success?old=${encodeURIComponent(oldSubject)}&new=${encodeURIComponent(newSubject)}`,
      cancelUrl: `${FRONTEND_URL}/profile?swap=cancelled`,
      failureUrl: `${FRONTEND_URL}/profile?swap=cancelled`,
      customer: { email: customerEmail, name: 'SmartClass Student' },
      metadata: { 
        userId: String(userIdentifier), 
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
      return res.status(response.status).json({ success: false, error: data.message || 'Failed' });
    }
    
    if (data.id && data.redirectUrl) {
      await pool.query(
        `INSERT INTO smartclass_subscription_payments 
         (user_id, checkout_id, package, amount, status, created_at)
         VALUES ($1, $2, 'swap_fee', $3, 'pending', NOW())`,
        [String(userIdentifier), data.id, SWAP_FEE]
      );
      
      res.json({ 
        success: true, 
        checkoutId: data.id, 
        redirectUrl: data.redirectUrl,
        amount: SWAP_FEE
      });
    } else {
      res.status(500).json({ success: false, error: 'No checkout created' });
    }
    
  } catch (error) {
    console.error('❌ Create swap checkout error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// AUTO-VERIFY LATEST SUBSCRIPTION
// ====================
router.post('/auto-verify-latest', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
    
    const pendingResult = await pool.query(
      `SELECT checkout_id, package, amount 
       FROM smartclass_subscription_payments 
       WHERE user_id = $1 AND status = 'pending' AND package IN ('Basic', 'Standard')
       ORDER BY created_at DESC LIMIT 1`,
      [String(userId)]
    );
    
    if (pendingResult.rows.length === 0) {
      const completedResult = await pool.query(
        `SELECT * FROM smartclass_subscriptions WHERE user_id = $1`,
        [String(userId)]
      );
      
      if (completedResult.rows.length > 0) {
        const sub = completedResult.rows[0];
        const now = new Date();
        const endDate = sub.end_date ? new Date(sub.end_date) : null;
        const hasAccess = sub.status === 'active' || (sub.status === 'cancelled' && endDate && endDate > now);
        
        if (hasAccess) {
          return res.json({
            success: true,
            hasSubscription: true,
            subscription: {
              package: sub.package,
              amount: parseFloat(sub.amount),
              subjectsAllowed: sub.package === 'Standard' ? 4 : 2,
              subjects: sub.subjects || [],
              status: sub.status,
              endDate: sub.end_date
            }
          });
        }
      }
      
      return res.json({ success: false, message: 'No pending payment found' });
    }
    
    const payment = pendingResult.rows[0];
    const checkoutId = payment.checkout_id;
    
    const { response, data: checkout } = await yocoFetch(
      `${YOCO_API}/${checkoutId}`,
      { headers: { 'Authorization': `Bearer ${YOCO_SECRET_KEY}` } }
    );
    
    if (!response.ok) return res.status(500).json({ success: false, error: 'Yoco verify failed' });
    
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
        (user_id, package, amount, status, payment_reference, end_date, created_at, updated_at)
        VALUES ($1, $2, $3, 'active', $4, NOW() + INTERVAL '30 days', NOW(), NOW())
        ON CONFLICT (user_id) 
        DO UPDATE SET 
          package = EXCLUDED.package,
          amount = EXCLUDED.amount,
          status = 'active',
          payment_reference = EXCLUDED.payment_reference,
          end_date = NOW() + INTERVAL '30 days',
          updated_at = NOW()
      `, [String(userId), pkg, amount, checkoutId]);
      
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
      return res.json({ success: false, status: 'pending' });
    } else {
      await pool.query(
        `UPDATE smartclass_subscription_payments SET status = 'failed' WHERE checkout_id = $1`,
        [checkoutId]
      );
      return res.json({ success: false, status: checkout.status });
    }
    
  } catch (error) {
    console.error('❌ Auto-verify error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// AUTO-VERIFY LATEST SWAP
// ====================
router.post('/auto-verify-swap', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
    
    const pendingResult = await pool.query(
      `SELECT checkout_id FROM smartclass_subscription_payments 
       WHERE user_id = $1 AND package = 'swap_fee' AND status = 'pending' 
       ORDER BY created_at DESC LIMIT 1`,
      [String(userId)]
    );
    
    if (pendingResult.rows.length === 0) {
      return res.json({ success: false, message: 'No pending swap' });
    }
    
    const checkoutId = pendingResult.rows[0].checkout_id;
    
    const { response, data: checkout } = await yocoFetch(
      `${YOCO_API}/${checkoutId}`,
      { headers: { 'Authorization': `Bearer ${YOCO_SECRET_KEY}` } }
    );
    
    if (!response.ok) return res.status(500).json({ success: false, error: 'Yoco verify failed' });
    
    if (checkout.status === 'COMPLETED' || checkout.status === 'completed') {
      const metadata = checkout.metadata || {};
      const oldSubject = metadata.oldSubject;
      const newSubject = metadata.newSubject;
      
      if (!oldSubject || !newSubject) {
        return res.json({ success: false, error: 'Swap metadata missing' });
      }
      
      await pool.query(
        `UPDATE smartclass_subscription_payments 
         SET status = 'completed', completed_at = NOW() 
         WHERE checkout_id = $1`,
        [checkoutId]
      );
      
      const userResult = await pool.query(
        `SELECT subjects FROM users WHERE email = $1`,
        [String(userId)]
      );
      
      if (userResult.rows.length === 0) {
        return res.json({ success: false, error: 'User not found' });
      }
      
      const currentSubjects = userResult.rows[0].subjects || [];
      
      if (!currentSubjects.includes(oldSubject)) {
        return res.json({ success: false, error: `${oldSubject} not in subjects` });
      }
      
      const updatedSubjects = currentSubjects.map(s => s === oldSubject ? newSubject : s);
      
      await pool.query(
        `UPDATE users SET subjects = $1, updated_at = NOW() WHERE email = $2`,
        [updatedSubjects, String(userId)]
      );
      
      await pool.query(
        `UPDATE smartclass_subscriptions 
         SET subjects = $1, updated_at = NOW() 
         WHERE user_id = $2`,
        [updatedSubjects, String(userId)]
      );
      
      return res.json({ 
        success: true, 
        swapCompleted: true,
        oldSubject,
        newSubject,
        subjects: updatedSubjects
      });
      
    } else if (checkout.status === 'PENDING' || checkout.status === 'pending') {
      return res.json({ success: false, status: 'pending' });
    } else {
      await pool.query(
        `UPDATE smartclass_subscription_payments SET status = 'failed' WHERE checkout_id = $1`,
        [checkoutId]
      );
      return res.json({ success: false, status: checkout.status });
    }
    
  } catch (error) {
    console.error('❌ Auto-verify swap error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// CHECK SUBSCRIPTION (respects end_date)
// ====================
router.get('/check-subscription', async (req, res) => {
  try {
    const userId = req.query.userId || req.query.email || 'guest';
    
    const result = await pool.query(
      `SELECT * FROM smartclass_subscriptions 
       WHERE user_id = $1 
       ORDER BY updated_at DESC LIMIT 1`,
      [String(userId)]
    );
    
    if (result.rows.length === 0) {
      return res.json({ success: true, hasSubscription: false });
    }
    
    const sub = result.rows[0];
    const now = new Date();
    const endDate = sub.end_date ? new Date(sub.end_date) : null;
    
    let hasAccess = false;
    if (sub.status === 'active') {
      hasAccess = true;
    } else if (sub.status === 'cancelled' && endDate && endDate > now) {
      hasAccess = true;
    }
    
    if (!hasAccess) {
      return res.json({ success: true, hasSubscription: false, reason: 'expired_or_cancelled' });
    }
    
    res.json({ 
      success: true, 
      hasSubscription: true, 
      subscription: {
        package: sub.package,
        amount: parseFloat(sub.amount),
        subjectsAllowed: sub.package === 'Standard' ? 4 : 2,
        subjects: sub.subjects || [],
        status: sub.status,
        endDate: sub.end_date,
        cancelled: sub.status === 'cancelled'
      }
    });
    
  } catch (error) {
    console.error('❌ Check subscription error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// CANCEL SUBSCRIPTION (end-of-period)
// ====================
router.post('/cancel-subscription', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) return res.status(400).json({ success: false, error: 'User ID required' });
    
    const subResult = await pool.query(
      `SELECT * FROM smartclass_subscriptions 
       WHERE user_id = $1 AND status = 'active'`,
      [String(userId)]
    );
    
    if (subResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'No active subscription' });
    }
    
    const sub = subResult.rows[0];
    const startDate = sub.created_at ? new Date(sub.created_at) : new Date();
    const endDate = new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    
    await pool.query(
      `UPDATE smartclass_subscriptions 
       SET status = 'cancelled', end_date = $1, updated_at = NOW() 
       WHERE user_id = $2 AND status = 'active'`,
      [endDate, String(userId)]
    );
    
    res.json({ 
      success: true, 
      message: 'Subscription cancelled',
      endDate: endDate.toISOString()
    });
    
  } catch (error) {
    console.error('❌ Cancel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// DOWNGRADE TO BASIC
// ====================
router.post('/downgrade-basic', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) return res.status(400).json({ success: false, error: 'User ID required' });
    
    await pool.query(
      `UPDATE smartclass_subscriptions 
       SET package = 'Basic', amount = 39, updated_at = NOW() 
       WHERE user_id = $1 AND status = 'active'`,
      [String(userId)]
    );
    
    res.json({ 
      success: true, 
      message: 'Downgraded to Basic',
      subscription: { package: 'Basic', amount: 39, subjectsAllowed: 2 }
    });
    
  } catch (error) {
    console.error('❌ Downgrade error:', error);
    res.status(500).json({ success: false, error: error.message });
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
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
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
      res.json({ success: true, checkoutId: null });
    }
    
  } catch (error) {
    console.error('❌ Check latest payment error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// VERIFY PAYMENT (legacy with checkout ID)
// ====================
router.post('/verify-payment', async (req, res) => {
  try {
    const { checkoutId, email, userId } = req.body;
    
    if (!checkoutId) return res.status(400).json({ success: false, error: 'Checkout ID required' });
    
    const { response, data: checkout } = await yocoFetch(
      `${YOCO_API}/${checkoutId}`,
      { headers: { 'Authorization': `Bearer ${YOCO_SECRET_KEY}` } }
    );
    
    if (!response.ok) return res.status(500).json({ success: false, error: 'Verify failed' });
    
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
          (user_id, package, amount, status, payment_reference, end_date, created_at, updated_at)
          VALUES ($1, $2, $3, 'active', $4, NOW() + INTERVAL '30 days', NOW(), NOW())
          ON CONFLICT (user_id) 
          DO UPDATE SET 
            package = EXCLUDED.package,
            amount = EXCLUDED.amount,
            status = 'active',
            payment_reference = EXCLUDED.payment_reference,
            end_date = NOW() + INTERVAL '30 days',
            updated_at = NOW()
        `, [String(userIdentifier), pkg, amount, checkoutId]);
        
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
        
        if (oldSubject && newSubject) {
          const userResult = await pool.query(
            `SELECT subjects FROM users WHERE email = $1`,
            [String(userIdentifier)]
          );
          
          if (userResult.rows.length > 0) {
            const currentSubjects = userResult.rows[0].subjects || [];
            if (currentSubjects.includes(oldSubject)) {
              const updatedSubjects = currentSubjects.map(s => s === oldSubject ? newSubject : s);
              
              await pool.query(
                `UPDATE users SET subjects = $1, updated_at = NOW() WHERE email = $2`,
                [updatedSubjects, String(userIdentifier)]
              );
              
              await pool.query(
                `UPDATE smartclass_subscriptions SET subjects = $1, updated_at = NOW() WHERE user_id = $2`,
                [updatedSubjects, String(userIdentifier)]
              );
              
              return res.json({ 
                success: true, 
                swapCompleted: true,
                oldSubject,
                newSubject,
                subjects: updatedSubjects
              });
            }
          }
        }
        
        res.json({ success: true, swapCompleted: true, oldSubject, newSubject });
      } else {
        res.json({ success: true });
      }
      
    } else if (checkout.status === 'PENDING' || checkout.status === 'pending') {
      res.json({ success: false, status: 'pending' });
    } else {
      await pool.query(
        `UPDATE smartclass_subscription_payments SET status = 'failed' WHERE checkout_id = $1`,
        [checkoutId]
      );
      res.json({ success: false, status: checkout.status });
    }
    
  } catch (error) {
    console.error('❌ Verify payment error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;