const express = require('express');
const router = express.Router();
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const crypto = require('crypto');

const YOCO_API = 'https://payments.yoco.com/api/checkouts';
const YOCO_SECRET_KEY = process.env.YOCO_SECRET_KEY_SMARTCLASS;
const YOCO_WEBHOOK_SECRET = process.env.YOCO_WEBHOOK_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.smartclasss.com';
const YOCO_TIMEOUT = 15000;
const MAX_RETRIES = 3;

const PACKAGES = {
  basic: { price: 39, subjectsAllowed: 2, name: 'Basic' },
  standard: { price: 59, subjectsAllowed: 4, name: 'Standard' },
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
        'Idempotency-Key': `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      },
    };

    try {
      const response = await fetch(url, requestOptions);
      clearTimeout(timeoutId);
      const data = await response.json();

      if (!response.ok && response.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      return { response, data };
    } catch (error) {
      clearTimeout(timeoutId);
      if (
        attempt < retries &&
        (error.name === 'AbortError' ||
          error.name === 'TypeError' ||
          error.code === 'ECONNRESET')
      ) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      throw error;
    }
  }
};

// ====================
// CREATE SUBSCRIPTION CHECKOUT
// ====================
router.post('/create-subscription-checkout', authMiddleware, async (req, res) => {
  try {
    const { package: pkg, returnPath } = req.body;
    const userId = req.user.id;
    const email = req.user.email;

    const packageKey = pkg?.toLowerCase();
    if (!packageKey || !PACKAGES[packageKey]) {
      return res.status(400).json({ success: false, error: 'Invalid package' });
    }

    const packageDetails = PACKAGES[packageKey];
    const amountInCents = packageDetails.price * 100;

    const safeReturn = typeof returnPath === 'string' && returnPath.startsWith('/')
      ? returnPath
      : '/dashboard';

    const requestBody = {
      amount: amountInCents,
      currency: 'ZAR',
      successUrl: `${FRONTEND_URL}/payment-success?package=${packageKey}`,
      cancelUrl: `${FRONTEND_URL}/payment/cancel`,
      failureUrl: `${FRONTEND_URL}/payment/cancel`,
      customer: { email, name: 'SmartClass Student' },
      metadata: {
        userId: String(userId),
        type: 'subscription',
        package: packageDetails.name,
        subjectsAllowed: packageDetails.subjectsAllowed,
        returnPath: safeReturn,
      },
    };

    const { response, data } = await yocoFetch(YOCO_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${YOCO_SECRET_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ success: false, error: data.message || 'Failed' });
    }

    if (!data.id || !data.redirectUrl) {
      return res.status(500).json({ success: false, error: 'No checkout created' });
    }

    await pool.query(
      `INSERT INTO smartclass_subscription_payments
       (user_id, checkout_id, package, amount, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())`,
      [String(userId), data.id, packageDetails.name, packageDetails.price]
    );

    res.json({
      success: true,
      checkoutId: data.id,
      redirectUrl: data.redirectUrl,
      package: packageDetails.name,
      amount: packageDetails.price,
    });
  } catch (error) {
    console.error('❌ Create subscription checkout error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// CREATE SWAP CHECKOUT
// ====================
router.post('/create-swap-checkout', authMiddleware, async (req, res) => {
  try {
    const { oldSubject, newSubject } = req.body;
    const userId = req.user.id;
    const email = req.user.email;

    if (!oldSubject || !newSubject || oldSubject === newSubject) {
      return res.status(400).json({ success: false, error: 'Invalid subjects' });
    }

    const amountInCents = SWAP_FEE * 100;

    const requestBody = {
      amount: amountInCents,
      currency: 'ZAR',
      successUrl: `${FRONTEND_URL}/swap-success?old=${encodeURIComponent(oldSubject)}&new=${encodeURIComponent(newSubject)}`,
      cancelUrl: `${FRONTEND_URL}/profile?swap=cancelled`,
      failureUrl: `${FRONTEND_URL}/profile?swap=cancelled`,
      customer: { email, name: 'SmartClass Student' },
      metadata: {
        userId: String(userId),
        type: 'swap_fee',
        oldSubject,
        newSubject,
      },
    };

    const { response, data } = await yocoFetch(YOCO_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${YOCO_SECRET_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ success: false, error: data.message || 'Failed' });
    }

    if (!data.id || !data.redirectUrl) {
      return res.status(500).json({ success: false, error: 'No checkout created' });
    }

    await pool.query(
      `INSERT INTO smartclass_subscription_payments
       (user_id, checkout_id, package, amount, status, created_at)
       VALUES ($1, $2, 'swap_fee', $3, 'pending', NOW())`,
      [String(userId), data.id, SWAP_FEE]
    );

    res.json({
      success: true,
      checkoutId: data.id,
      redirectUrl: data.redirectUrl,
      amount: SWAP_FEE,
    });
  } catch (error) {
    console.error('❌ Create swap checkout error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// CHECK SUBSCRIPTION
// ====================
router.get('/check-subscription', authMiddleware, async (req, res) => {
  try {
    const userId = String(req.user.id);

    const result = await pool.query(
      `SELECT * FROM smartclass_subscriptions
       WHERE user_id = $1
       ORDER BY updated_at DESC LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, hasSubscription: false });
    }

    const sub = result.rows[0];
    const now = new Date();
    const endDate = sub.end_date ? new Date(sub.end_date) : null;

    let hasAccess = false;
    if (sub.status === 'active') hasAccess = true;
    else if (sub.status === 'cancelled' && endDate && endDate > now) hasAccess = true;

    if (!hasAccess) {
      return res.json({
        success: true,
        hasSubscription: false,
        reason: 'expired_or_cancelled',
      });
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
        cancelled: sub.status === 'cancelled',
      },
    });
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
    const userId = String(req.user.id);

    const subResult = await pool.query(
      `SELECT * FROM smartclass_subscriptions
       WHERE user_id = $1 AND status = 'active'`,
      [userId]
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
      [endDate, userId]
    );

    res.json({
      success: true,
      message: 'Subscription cancelled',
      endDate: endDate.toISOString(),
    });
  } catch (error) {
    console.error('❌ Cancel error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// DOWNGRADE TO BASIC
// ====================
router.post('/downgrade-basic', authMiddleware, async (req, res) => {
  try {
    const userId = String(req.user.id);

    await pool.query(
      `UPDATE smartclass_subscriptions
       SET package = 'Basic', amount = 39, updated_at = NOW()
       WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );

    res.json({
      success: true,
      message: 'Downgraded to Basic',
      subscription: { package: 'Basic', amount: 39, subjectsAllowed: 2 },
    });
  } catch (error) {
    console.error('❌ Downgrade error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// YOCO WEBHOOK
// Standard Webhooks payload: { type: "payment.created", data: {...} }
// ====================
router.post('/webhook', async (req, res) => {
  try {
    const webhookId = req.headers['webhook-id'];
    const webhookTimestamp = req.headers['webhook-timestamp'];
    const signatureHeader = req.headers['webhook-signature'];

    if (!webhookId || !webhookTimestamp || !signatureHeader) {
      console.error('❌ Webhook missing required headers');
      return res.status(400).json({ error: 'Missing headers' });
    }

    if (!YOCO_WEBHOOK_SECRET) {
      console.error('❌ YOCO_WEBHOOK_SECRET not set');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    // Replay protection
    const now = Math.floor(Date.now() / 1000);
    const ts = parseInt(webhookTimestamp, 10);
    if (isNaN(ts) || Math.abs(now - ts) > 180) {
      console.error('❌ Webhook timestamp outside tolerance:', webhookTimestamp);
      return res.status(401).json({ error: 'Timestamp out of tolerance' });
    }

    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      console.error('❌ Webhook body is not raw');
      return res.status(500).json({ error: 'Webhook misconfigured' });
    }

    const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody.toString('utf8')}`;

    const secretBytes = Buffer.from(
      YOCO_WEBHOOK_SECRET.split('_')[1] || YOCO_WEBHOOK_SECRET,
      'base64'
    );

    const expected = crypto
      .createHmac('sha256', secretBytes)
      .update(signedContent)
      .digest('base64');

    const signatures = signatureHeader.split(' ');
    let verified = false;
    for (const sig of signatures) {
      const value = sig.includes(',') ? sig.split(',')[1] : sig;
      if (!value) continue;
      const a = Buffer.from(expected);
      const b = Buffer.from(value);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        verified = true;
        break;
      }
    }

    if (!verified) {
      console.error('❌ Webhook signature mismatch');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    console.log('🔍 Webhook payload keys:', Object.keys(event));

    // Support both `event_type` (some Yoco docs) and `type` (Standard Webhooks)
    const eventType = event.event_type || event.type;
    const payload = event.payload || event.data || event;

    console.log('✅ Yoco webhook received:', eventType, '| id:', webhookId);

    const paymentId = payload.payment_id || payload.id;
    const orderId = payload.order_id;
    const lookupId = orderId || paymentId;

    // ====== Failed ======
    if (eventType === 'payment.failed' || eventType === 'payment.cancelled') {
      if (lookupId) {
        await pool.query(
          `UPDATE smartclass_subscription_payments
           SET status = 'failed'
           WHERE checkout_id = $1 AND status = 'pending'`,
          [lookupId]
        );
      }
      return res.status(200).json({ received: true });
    }

    // ====== Refunded ======
    if (eventType === 'payment.refunded') {
      if (lookupId) {
        await pool.query(
          `UPDATE smartclass_subscription_payments
           SET status = 'refunded'
           WHERE checkout_id = $1`,
          [lookupId]
        );

        const payRow = await pool.query(
          `SELECT user_id FROM smartclass_subscription_payments WHERE checkout_id = $1`,
          [lookupId]
        );

        if (payRow.rows.length > 0) {
          const userId = payRow.rows[0].user_id;
          await pool.query(
            `UPDATE smartclass_subscriptions
             SET status = 'cancelled', end_date = NOW(), updated_at = NOW()
             WHERE user_id = $1`,
            [userId]
          );
          console.log('✅ Subscription cancelled due to refund for user', userId);
        }
      }
      return res.status(200).json({ received: true });
    }

    // ====== Success ======
    if (
      eventType !== 'payment.succeeded' &&
      eventType !== 'payment.created' &&
      eventType !== 'payment.completed'
    ) {
      return res.status(200).json({ received: true, skipped: eventType });
    }

    if (!lookupId) {
      console.error('❌ Webhook: no payment/order id in payload');
      return res.status(200).json({ received: true, skipped: 'no id' });
    }

    // Fetch the full checkout to read metadata
    const { response, data: checkout } = await yocoFetch(
      `${YOCO_API}/${lookupId}`,
      { headers: { Authorization: `Bearer ${YOCO_SECRET_KEY}` } }
    );

    if (!response.ok) {
      console.error('❌ Could not fetch checkout for webhook:', lookupId);
      return res.status(200).json({ received: true, skipped: 'checkout fetch failed' });
    }

    if (checkout.status !== 'COMPLETED' && checkout.status !== 'completed') {
      console.log('⏭️ Checkout not completed yet:', checkout.status);
      return res.status(200).json({ received: true, skipped: 'not completed' });
    }

    const metadata = checkout.metadata || {};
    const userId = metadata.userId;
    const type = metadata.type;

    if (!userId) {
      console.error('❌ Webhook: no userId in checkout metadata');
      return res.status(200).json({ received: true, skipped: 'no userId' });
    }

    await pool.query(
      `UPDATE smartclass_subscription_payments
       SET status = 'completed', completed_at = NOW()
       WHERE checkout_id = $1`,
      [lookupId]
    );

    // ====== Swap fee ======
    if (type === 'swap_fee') {
      const { oldSubject, newSubject } = metadata;
      if (!oldSubject || !newSubject) {
        return res.status(200).json({ received: true, skipped: 'swap metadata missing' });
      }

      const userResult = await pool.query(
        `SELECT subjects FROM users WHERE id = $1`,
        [userId]
      );
      if (userResult.rows.length === 0) {
        return res.status(200).json({ received: true, skipped: 'user not found' });
      }

      const current = userResult.rows[0].subjects || [];
      if (!current.includes(oldSubject)) {
        return res.status(200).json({ received: true, skipped: 'old subject missing' });
      }

      const updated = current.map((s) => (s === oldSubject ? newSubject : s));
      const updatedJson = JSON.stringify(updated);

      await pool.query(
        `UPDATE users SET subjects = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [updatedJson, userId]
      );
      await pool.query(
        `UPDATE smartclass_subscriptions SET subjects = $1::jsonb, updated_at = NOW() WHERE user_id = $2`,
        [updatedJson, String(userId)]
      );

      console.log('✅ Swap completed for user', userId, ':', oldSubject, '→', newSubject);
      return res.status(200).json({ received: true, swap: true });
    }

    // ====== Subscription ======
    if (type === 'subscription') {
      const pkg = metadata.package || 'Basic';
      const amount = (checkout.amount / 100).toFixed(2);

      await pool.query(
        `INSERT INTO smartclass_subscriptions
         (user_id, package, amount, status, payment_reference, end_date, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', $4, NOW() + INTERVAL '30 days', NOW(), NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET
           package = EXCLUDED.package,
           amount = EXCLUDED.amount,
           status = 'active',
           payment_reference = EXCLUDED.payment_reference,
           end_date = NOW() + INTERVAL '30 days',
           updated_at = NOW()`,
        [String(userId), pkg, amount, lookupId]
      );

      console.log('✅ Subscription activated for user', userId, '| package:', pkg);
      return res.status(200).json({ received: true, subscription: true });
    }

    res.status(200).json({ received: true, skipped: 'unknown type' });
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ====================
// CHECK LATEST PAYMENT
// ====================
router.get('/check-latest-payment', authMiddleware, async (req, res) => {
  try {
    const userId = String(req.user.id);

    const result = await pool.query(
      `SELECT checkout_id, package, status 
       FROM smartclass_subscription_payments 
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (result.rows.length > 0) {
      res.json({
        success: true,
        checkoutId: result.rows[0].checkout_id,
        package: result.rows[0].package,
        status: result.rows[0].status,
      });
    } else {
      res.json({ success: true, checkoutId: null });
    }
  } catch (error) {
    console.error('❌ Check latest payment error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;