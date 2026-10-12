const crypto = require('node:crypto');
const { signature, cents } = require('./payfast-security');
const { validateSwap } = require('./profile-actions');
const { settleVerifiedEvent } = require('./payment-settlement');
const SCHEMA = `CREATE TABLE IF NOT EXISTS smartclass_payfast_orders (
  checkout_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mode TEXT NOT NULL,
  metadata JSONB NOT NULL, email TEXT NOT NULL, token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, gateway_reference TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;
const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
async function createOrder(pool, userId, body, swap, cfg) {
  const plan = { basic: ['Basic', 39], standard: ['Standard', 59] }[String(body.package || '').toLowerCase()];
  if (!swap && !plan) throw fail('Choose a valid plan.');
  if (swap) await validateSwap(pool, userId, body.oldSubject, body.newSubject);
  const user = (await pool.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0];
  if (!user?.email) throw fail('Your account email could not be found.', 400);
  const checkoutId = 'pf_' + crypto.randomUUID().replaceAll('-', '');
  const token = crypto.randomBytes(32).toString('hex');
  const pkg = swap ? 'swap_fee' : plan[0], amount = swap ? 19 : plan[1];
  const metadata = swap ? { oldSubject: body.oldSubject, newSubject: body.newSubject } : {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO smartclass_subscription_payments (user_id, checkout_id, package, amount, status, created_at)
      VALUES ($1, $2, $3, $4, 'pending', NOW())`, [String(userId), checkoutId, pkg, amount]);
    await client.query(`INSERT INTO smartclass_payfast_orders (checkout_id, user_id, mode, metadata, email, token_hash, expires_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW() + INTERVAL '1 hour')`, [checkoutId, String(userId), cfg.mode, JSON.stringify(metadata), user.email, hash(token)]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return { success: true, checkoutId, package: pkg, amount, provider: 'payfast', redirectUrl: `${cfg.backend}/api/payfast/checkout/${checkoutId}?token=${token}` };
}
function paymentFields(order, cfg) {
  const fields = {
    merchant_id: cfg.merchantId, merchant_key: cfg.merchantKey,
    return_url: `${cfg.frontend}/${order.package === 'swap_fee' ? 'swap-success' : 'payment-success'}`,
    cancel_url: `${cfg.frontend}${order.package === 'swap_fee' ? '/profile?swap=cancelled' : '/payment/cancel'}`,
    notify_url: `${cfg.backend}/api/payfast/webhook`,
    email_address: order.email, m_payment_id: order.checkout_id,
    amount: (cents(order.amount) / 100).toFixed(2),
    item_name: order.package === 'swap_fee' ? 'Smartclass subject swap' : `Smartclass ${order.package} - 30 days`,
  };
  fields.signature = signature(fields, cfg.passphrase);
  return fields;
}
async function settlePayfast(pool, data, cfg) {
  if (!/^pf_[a-f0-9]{32}$/.test(data.m_payment_id || '') || !/^\d+$/.test(data.pf_payment_id || '')) throw fail('Invalid payment reference');
  const order = (await pool.query('SELECT * FROM smartclass_payfast_orders WHERE checkout_id = $1', [data.m_payment_id])).rows[0];
  if (!order) throw fail('Payment order not found; retry notification', 503);
  if (order.mode !== cfg.mode) throw fail('Payment mode mismatch');
  // Never derive user, package or swap subjects from untrusted browser fields.
  if (!['COMPLETE', 'FAILED', 'CANCELLED'].includes(data.payment_status)) throw fail('Unsupported payment status');
  const success = data.payment_status === 'COMPLETE';
  return settleVerifiedEvent(pool, {type: success ? 'payment.succeeded' : 'payment.failed', payload: {
    mode: cfg.mode, status: success ? 'succeeded' : 'failed', amount: cents(data.amount_gross), currency: 'ZAR',
    metadata: {...order.metadata, checkoutId: order.checkout_id, userId: order.user_id}
  }}, cfg.mode, async client => {
    const locked = (await client.query('SELECT gateway_reference FROM smartclass_payfast_orders WHERE checkout_id = $1 FOR UPDATE', [order.checkout_id])).rows[0];
    if (locked.gateway_reference && locked.gateway_reference !== data.pf_payment_id) throw fail('Order already has a different payment reference', 409);
    await client.query('UPDATE smartclass_payfast_orders SET gateway_reference = $2 WHERE checkout_id = $1', [order.checkout_id, data.pf_payment_id]);
  });
}
module.exports = { SCHEMA, createOrder, paymentFields, settlePayfast, hash };
