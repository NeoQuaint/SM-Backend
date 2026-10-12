// Browsers can enforce form-action on every redirect, not just the initial POST.
// Keep the allowlist limited to the payment hosts and our configured return origin.
function checkoutPolicy(cfg, nonce) {
  const hosts = cfg.mode === 'test'
    ? ['https://sandbox.payfast.co.za']
    : ['https://www.payfast.co.za', 'https://payment.payfast.io'];
  const frontend = new URL(cfg.frontend);
  if (frontend.protocol !== 'https:') throw new Error('Checkout return origin must use HTTPS');
  if (!/^[A-Za-z0-9+/=]+$/.test(nonce)) throw new Error('Invalid checkout nonce');
  return `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${[...hosts, frontend.origin].join(' ')}; base-uri 'none'; frame-ancestors 'none'`;
}
module.exports = { checkoutPolicy };
