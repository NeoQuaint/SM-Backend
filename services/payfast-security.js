const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const error = (message, status = 400) => Object.assign(new Error(message), { status });
// PayFast uses PHP urlencode, insertion order, and trimmed values (not sorted keys).
const encode = value => encodeURIComponent(String(value).trim()).replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+');
const encodeNotification = value => encodeURIComponent(String(value)).replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+');
// ITNs sign every posted field, including empty strings and surrounding spaces.
// Checkout generation deliberately uses different normalization above.
function notificationParameters(data) {
  return Object.entries(data).filter(([key]) => key !== 'signature')
    .map(([key, value]) => `${key}=${encodeNotification(value)}`).join('&');
}
function parameters(data) {
  return Object.entries(data).filter(([key, value]) => key !== 'signature' && value !== '' && value != null)
    .map(([key, value]) => `${key}=${encode(value)}`).join('&');
}
function signature(data, passphrase) {
  return crypto.createHash('md5').update(parameters(data) + (passphrase ? `&passphrase=${encode(passphrase)}` : '')).digest('hex');
}
function parseNotification(raw) {
  if (!Buffer.isBuffer(raw)) throw error('Expected form notification');
  const data = Object.create(null);
  for (const [key, value] of new URLSearchParams(raw.toString('utf8'))) {
    if (!/^[a-zA-Z0-9_]+$/.test(key) || Object.hasOwn(data, key)) throw error('Invalid notification fields');
    data[key] = value;
  }
  return data;
}
function cents(value) {
  if (!/^\d+(\.\d{1,2})?$/.test(String(value))) throw error('Invalid payment amount');
  const amount = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw error('Invalid payment amount');
  return amount;
}
function config(env = process.env) {
  if (!['true', 'false'].includes(env.PAYFAST_TEST_MODE)) throw error('PayFast mode is not configured', 503);
  if (!env.PAYFAST_MERCHANT_ID || !env.PAYFAST_MERCHANT_KEY || !env.PAYFAST_PASSPHRASE) throw error('PayFast is not configured', 503);
  const sandbox = env.PAYFAST_TEST_MODE === 'true';
  const frontend = env.FRONTEND_URL || 'https://www.smartclasss.com';
  const backend = env.BACKEND_URL || 'https://smartclass-wlgb.onrender.com';
  for (const url of [frontend, backend]) if (new URL(url).protocol !== 'https:') throw error('Payment URLs require HTTPS', 503);
  return { merchantId: env.PAYFAST_MERCHANT_ID.trim(), merchantKey: env.PAYFAST_MERCHANT_KEY.trim(), passphrase: env.PAYFAST_PASSPHRASE,
    mode: sandbox ? 'test' : 'live', host: sandbox ? 'sandbox.payfast.co.za' : 'www.payfast.co.za', frontend: frontend.replace(/\/$/, ''), backend: backend.replace(/\/$/, '') };
}
async function validateNotification(data, ip, cfg, { resolve4 = dns.resolve4.bind(dns), fetcher = fetch } = {}) {
  const notificationBody = notificationParameters(data);
  const expected = crypto.createHash('md5').update(notificationBody + (cfg.passphrase ? `&passphrase=${encodeNotification(cfg.passphrase)}` : '')).digest('hex');
  if (!/^[a-f0-9]{32}$/i.test(data.signature || '') || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(data.signature.toLowerCase()))) throw error('Invalid payment signature', 401);
  if (data.merchant_id !== cfg.merchantId) throw error('Wrong payment merchant', 401);
  const hosts = cfg.mode === 'test' ? ['sandbox.payfast.co.za'] : ['www.payfast.co.za', 'api.payfast.co.za', 'ips.payfast.co.za', 'w1w.payfast.co.za', 'w2w.payfast.co.za'];
  const results = await Promise.allSettled(hosts.map(host => resolve4(host)));
  const allowed = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  if (!allowed.length) throw error('Payment source verification unavailable', 503);
  if (!allowed.includes(String(ip).replace(/^::ffff:/, ''))) throw error('Invalid payment source', 401);
  const response = await fetcher(`https://${cfg.host}/eng/query/validate`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: notificationBody, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw error('PayFast validation unavailable', 503);
  if ((await response.text()).trim() !== 'VALID') throw error('PayFast did not validate notification', 401);
}
module.exports = { encode, parameters, signature, parseNotification, cents, config, validateNotification };
