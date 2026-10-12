const express = require('express');
const crypto = require('node:crypto');
const pool = require('../db');
const auth = require('../middleware/auth');
const { config, parseNotification, validateNotification } = require('../services/payfast-security');
const { SCHEMA, createOrder, paymentFields, settlePayfast, hash } = require('../services/payfast-orders');
const router = express.Router();
let ready;
function initialize() { return ready ||= pool.query(SCHEMA).catch(error => { ready = null; throw error; }); }
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
function failure(res, error) {
  console.warn('PayFast request failed:', error.status ? error.message : 'service or database unavailable');
  return res.status(error.status || 503).json({success: false, error: error.status && error.status < 500 ? error.message : 'Payments are temporarily unavailable. Please try again shortly.'});
}
for (const [route, swap] of [['create-subscription-checkout', false], ['create-swap-checkout', true]]) {
  router.post('/' + route, auth, async (req, res) => {
    try { const cfg = config(); await initialize(); res.json(await createOrder(pool, req.user.id, req.body, swap, cfg)); }
    catch (error) { failure(res, error); }
  });
}
router.get('/checkout/:id', async (req, res) => {
  res.set({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow'});
  try {
    const cfg = config(); await initialize();
    if (!/^pf_[a-f0-9]{32}$/.test(req.params.id) || !/^[a-f0-9]{64}$/.test(req.query.token || '')) return res.status(404).send('Checkout not found.');
    const order = (await pool.query(`SELECT o.*, p.amount, p.package, p.status FROM smartclass_payfast_orders o
      JOIN smartclass_subscription_payments p ON p.checkout_id = o.checkout_id
      WHERE o.checkout_id = $1 AND o.token_hash = $2`, [req.params.id, hash(req.query.token)])).rows[0];
    if (!order || order.mode !== cfg.mode) return res.status(404).send('Checkout not found.');
    if (order.status === 'completed') return res.redirect(`${cfg.frontend}/${order.package === 'swap_fee' ? 'swap-success' : 'payment-success'}`);
    if (order.status !== 'pending' || new Date(order.expires_at) <= new Date()) return res.status(410).send('This checkout has expired. Return to Smartclass to start again. If you already paid, check your payment status first.');
    const fields = paymentFields(order, cfg), nonce = crypto.randomBytes(18).toString('base64');
    res.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; form-action https://${cfg.host}; base-uri 'none'; frame-ancestors 'none'`);
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Smartclass secure checkout</title><body><p>Opening PayFast secure checkout…</p><form method="post" action="https://${cfg.host}/eng/process">${Object.entries(fields).map(([key,value]) => `<input type="hidden" name="${key}" value="${escape(value)}">`).join('')}<button type="submit">Continue to PayFast</button></form><script nonce="${nonce}">document.forms[0].submit()</script></body></html>`);
  } catch (error) { failure(res, error); }
});
router.post('/webhook', async (req, res) => {
  try {
    const cfg = config(), data = parseNotification(req.body);
    await validateNotification(data, req.ip, cfg);
    await initialize();
    await settlePayfast(pool, data, cfg);
    res.status(200).send('OK');
  } catch (error) { failure(res, error); }
});
router.get('/health', (req, res) => {
  let configured = false, mode = 'unconfigured';
  try { mode = config().mode; configured = true; } catch {}
  res.json({status: 'ok', provider: 'payfast', configured, mode, handler: 'verified-itn-v1'});
});
module.exports = router;
