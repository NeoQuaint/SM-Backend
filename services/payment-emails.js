const SCHEMA = `
CREATE TABLE IF NOT EXISTS smartclass_email_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO smartclass_email_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS smartclass_payment_emails (
  checkout_id TEXT PRIMARY KEY, recipient TEXT NOT NULL, package TEXT NOT NULL,
  amount NUMERIC NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), locked_until TIMESTAMPTZ,
  sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function receiptMessage(receipt, sender) {
  const amount = `R${Number(receipt.amount).toFixed(2)}`;
  const item = receipt.package === 'swap_fee' ? 'Subject change' : `${receipt.package} plan`;
  const text = `Your Smartclass payment is confirmed.\n\n${item}: ${amount}\nReference: ${receipt.checkout_id}\n\nYour next step doesn’t have to be a big one. Pick a topic, and Neo will work through it with you.\n\nOpen your study space: https://www.smartclasss.com/dashboard\n\nNeed help? Reply to this email.\nThe Smartclass team`;
  return {
    from: {name:'Smartclass', address:sender}, to:receipt.recipient, replyTo:sender,
    subject:'Your Smartclass payment is confirmed',
    messageId:`<payment-${receipt.checkout_id.replace(/[^a-zA-Z0-9_-]/g,'')}@smartclasss.com>`,
    text,
    html:`<div style="background:#f8f4fc;padding:32px 16px;font-family:Arial,sans-serif;color:#292033"><div style="max-width:520px;margin:auto;background:white;border:1px solid #e6dbee;border-radius:24px;padding:32px"><p style="color:#7442d5;font-weight:bold">Smartclass</p><h1 style="font-size:28px">You’re all set.</h1><p>Your payment is confirmed. Thank you for choosing Smartclass.</p><div style="background:#fff5e9;padding:20px;border-radius:16px"><strong>${escapeHtml(item)} · ${amount}</strong><p style="font-size:12px;overflow-wrap:anywhere">Reference: ${escapeHtml(receipt.checkout_id)}</p></div><p style="line-height:1.7">One topic at a time. Neo is here to help you understand it, work through an example, and try it yourself.</p><p style="margin:28px 0"><a href="https://www.smartclasss.com/dashboard" style="display:inline-block;background:#7540df;color:white;padding:15px 22px;border-radius:24px;text-decoration:none;font-weight:bold">Open my study space →</a></p><p style="font-size:13px;color:#75677b">Need help? Just reply to this email.<br>The Smartclass team</p></div></div>`
  };
}

// The worker only reads committed payments. SMTP failure never rolls back paid access.
// A persisted installation date avoids unexpectedly emailing historical customers.
async function deliverPendingReceipts(pool, transporter, sender) {
  await pool.query(`INSERT INTO smartclass_payment_emails (checkout_id, recipient, package, amount)
    SELECT p.checkout_id, u.email, p.package, p.amount
    FROM smartclass_subscription_payments p JOIN users u ON u.id::text = p.user_id::text
    WHERE p.status = 'completed' AND p.completed_at >= (SELECT enabled_at FROM smartclass_email_settings WHERE id = 1)
      AND u.email IS NOT NULL AND u.email <> ''
    ON CONFLICT (checkout_id) DO NOTHING`);
  for (let count=0; count<10; count++) {
    const claimed = await pool.query(`UPDATE smartclass_payment_emails SET locked_until = NOW() + INTERVAL '5 minutes', attempts = attempts + 1
      WHERE checkout_id = (SELECT checkout_id FROM smartclass_payment_emails
        WHERE sent_at IS NULL AND next_attempt_at <= NOW() AND (locked_until IS NULL OR locked_until < NOW())
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
    const receipt = claimed.rows[0]; if (!receipt) break;
    try {
      await transporter.sendMail(receiptMessage(receipt,sender));
      await pool.query('UPDATE smartclass_payment_emails SET sent_at = NOW(), locked_until = NULL WHERE checkout_id = $1', [receipt.checkout_id]);
      console.log('✅ Payment confirmation email sent');
    } catch {
      const delay = Math.min(3600, 30 * 2 ** Math.min(receipt.attempts,7));
      await pool.query("UPDATE smartclass_payment_emails SET locked_until = NULL, next_attempt_at = NOW() + ($2 * INTERVAL '1 second') WHERE checkout_id = $1",[receipt.checkout_id,delay]);
      console.warn('Payment confirmation email deferred; it will retry.');
    }
  }
}

function startPaymentEmails(pool, env=process.env) {
  if (!env.SUPPORT_EMAIL_PASSWORD) { console.warn('Payment emails need SUPPORT_EMAIL_PASSWORD; paid access is unaffected.'); return ()=>{}; }
  const sender=env.SUPPORT_EMAIL || 'smartclass.za@gmail.com';
  const nodemailer = require('nodemailer');
  const transporter=nodemailer.createTransport({service:'gmail',auth:{user:sender,pass:env.SUPPORT_EMAIL_PASSWORD},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000});
  let running=false,initialized=false;
  const tick=async()=>{
    if(running)return;running=true;
    try { if(!initialized){await pool.query(SCHEMA);initialized=true;} await deliverPendingReceipts(pool,transporter,sender); }
    catch { console.warn('Payment email queue temporarily unavailable; retrying shortly.'); }
    finally { running=false; }
  };
  void tick();const timer=setInterval(tick,15000);timer.unref?.();return ()=>clearInterval(timer);
}
module.exports={startPaymentEmails,deliverPendingReceipts,receiptMessage,SCHEMA};
