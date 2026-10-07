// Input must come from the signature-verified Yoco webhook, never a browser return URL.
const SUPPORTED = new Set(['payment.succeeded', 'payment.failed', 'payment.cancelled', 'refund.succeeded', 'payment.refunded']);
function fail(message, status = 422) { return Object.assign(new Error(message), { status }); }
function checkoutIdFrom(payload) {
  const id = payload?.metadata?.checkoutId || payload?.checkoutId || payload?.checkout_id;
  return typeof id === 'string' && /^(ch_|checkout_)[A-Za-z0-9_-]+$/.test(id) ? id : null;
}
async function settleYocoEvent(pool, event, expectedMode = 'live') {
  const type = event.type || event.event_type;
  if (!SUPPORTED.has(type)) return { received: true, skipped: 'unsupported event' };
  const payload = event.payload || event.data;
  const checkoutId = checkoutIdFrom(payload);
  if (!checkoutId) throw fail('Missing checkout ID in payment metadata', 400);
  if (payload.mode !== expectedMode) throw fail('Payment mode does not match this service');
  const success = type === 'payment.succeeded';
  const refund = type === 'refund.succeeded' || type === 'payment.refunded';
  if ((success || refund) && payload.status !== 'succeeded') throw fail('Event does not confirm a succeeded payment or refund');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Duplicate and concurrent deliveries serialize on the existing checkout row.
    const result = await client.query('SELECT * FROM smartclass_subscription_payments WHERE checkout_id = $1 FOR UPDATE', [checkoutId]);
    const payment = result.rows[0];
    if (!payment) throw fail('Checkout is not recorded yet; retry delivery', 503);
    if (!Number.isSafeInteger(payload.amount) || payload.currency !== 'ZAR' || payload.amount !== Math.round(Number(payment.amount) * 100)) throw fail('Payment amount or currency does not match the recorded checkout');
    const metadata = payload.metadata || {};
    if (metadata.userId != null && String(metadata.userId) !== String(payment.user_id)) throw fail('Payment owner does not match checkout');
    if (metadata.package != null && String(metadata.package).toLowerCase() !== String(payment.package).toLowerCase()) throw fail('Payment plan does not match checkout');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(payment.user_id)]);

    if (refund) {
      await client.query("UPDATE smartclass_subscription_payments SET status = 'refunded' WHERE checkout_id = $1", [checkoutId]);
      // A refund for an older payment must not cancel a more recent paid plan.
      await client.query("UPDATE smartclass_subscriptions SET status = 'cancelled', end_date = NOW(), updated_at = NOW() WHERE user_id = $1 AND payment_reference = $2", [String(payment.user_id), checkoutId]);
      await client.query('COMMIT'); return { received: true, refunded: true };
    }
    if (!success) {
      await client.query("UPDATE smartclass_subscription_payments SET status = 'failed' WHERE checkout_id = $1 AND status = 'pending'", [checkoutId]);
      await client.query('COMMIT'); return { received: true };
    }
    if (payment.status === 'completed' || payment.status === 'refunded') {
      await client.query('COMMIT'); return { received: true, duplicate: true };
    }
    if (!['pending', 'failed'].includes(payment.status)) throw fail('Unexpected recorded payment status');

    if (payment.package === 'swap_fee') {
      if (typeof metadata.oldSubject !== 'string' || typeof metadata.newSubject !== 'string' || metadata.oldSubject === metadata.newSubject) throw fail('Verified swap metadata is missing');
      const userResult = await client.query('SELECT subjects FROM users WHERE id = $1 FOR UPDATE', [payment.user_id]);
      const current = userResult.rows[0]?.subjects;
      if (!Array.isArray(current) || !current.includes(metadata.oldSubject) || current.includes(metadata.newSubject)) throw fail('Swap no longer matches the current subjects');
      const updated = JSON.stringify(current.map(s => s === metadata.oldSubject ? metadata.newSubject : s));
      await client.query('UPDATE users SET subjects = $1::jsonb, updated_at = NOW() WHERE id = $2', [updated, payment.user_id]);
      await client.query('UPDATE smartclass_subscriptions SET subjects = $1::jsonb, updated_at = NOW() WHERE user_id = $2', [updated, String(payment.user_id)]);
    } else {
      if (!['Basic', 'Standard'].includes(payment.package)) throw fail('Unknown recorded subscription plan');
      const currentResult = await client.query(`SELECT s.payment_reference, p.created_at AS payment_created_at
        FROM smartclass_subscriptions s LEFT JOIN smartclass_subscription_payments p ON p.checkout_id = s.payment_reference
        WHERE s.user_id = $1 FOR UPDATE OF s`, [String(payment.user_id)]);
      const current = currentResult.rows[0];
      const newerPayment = current?.payment_created_at && new Date(current.payment_created_at) > new Date(payment.created_at);
      if (current?.payment_reference !== checkoutId && !newerPayment) {
        await client.query(`INSERT INTO smartclass_subscriptions
          (user_id, package, amount, status, payment_reference, end_date, created_at, updated_at)
          VALUES ($1, $2, $3, 'active', $4, NOW() + INTERVAL '30 days', NOW(), NOW())
          ON CONFLICT (user_id) DO UPDATE SET package = EXCLUDED.package, amount = EXCLUDED.amount,
          status = 'active', payment_reference = EXCLUDED.payment_reference,
          end_date = NOW() + INTERVAL '30 days', updated_at = NOW()`,
          [String(payment.user_id), payment.package, payment.amount, checkoutId]);
      }
    }
    // Mark paid only after granting the entitlement, in the same transaction.
    await client.query("UPDATE smartclass_subscription_payments SET status = 'completed', completed_at = NOW() WHERE checkout_id = $1", [checkoutId]);
    await client.query('COMMIT');
    return { received: true, subscription: payment.package !== 'swap_fee', swap: payment.package === 'swap_fee' };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
module.exports = { settleYocoEvent, checkoutIdFrom };
