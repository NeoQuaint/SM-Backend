const { isIP } = require('node:net');
function paymentSource(req, env = process.env) {
  let value;
  // Only trust edge headers on the known Render deployment. Its public ingress
  // passes through Cloudflare; Express trust-proxy=1 can select a proxy hop.
  if (env.RENDER === 'true') {
    value = req.headers['cf-connecting-ip'];
    if (value == null) {
      const forwarded = req.headers['x-forwarded-for'];
      value = typeof forwarded === 'string' ? forwarded.split(',')[0] : undefined;
    }
  } else {
    value = req.socket?.remoteAddress;
  }
  if (typeof value !== 'string') throw Object.assign(new Error('Payment source address unavailable'), {status:401});
  const address = value.trim().replace(/^::ffff:/i, '');
  if (!isIP(address)) throw Object.assign(new Error('Invalid payment source address'), {status:401});
  return address;
}
module.exports = { paymentSource };
