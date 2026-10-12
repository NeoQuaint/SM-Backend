const test = require('node:test'), assert = require('node:assert/strict');
const { checkoutPolicy } = require('../services/payfast-checkout-policy');
test('live form permits initial PayFast POST, hosted checkout redirect and merchant return only', () => {
  const policy = checkoutPolicy({mode:'live', frontend:'https://www.smartclasss.com/payment-success'}, 'testNonce123');
  const destinations = policy.match(/form-action ([^;]+)/)[1].split(' ');
  assert.deepEqual(destinations, ['https://www.payfast.co.za','https://payment.payfast.io','https://www.smartclasss.com']);
  assert.ok(!policy.includes('*'));
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'nonce-testNonce123'/);
  assert.match(policy, /frame-ancestors 'none'/);
});
test('sandbox remains isolated from live payment hosts', () => {
  const policy = checkoutPolicy({mode:'test',frontend:'https://www.smartclasss.com'}, 'testNonce123');
  assert.match(policy,/form-action https:\/\/sandbox.payfast.co.za https:\/\/www.smartclasss.com;/);
  assert.ok(!policy.includes('payment.payfast.io'));
});
test('invalid return protocols and nonce injection are rejected', () => {
  assert.throws(()=>checkoutPolicy({mode:'live',frontend:'http://example.com'},'testNonce'));
  assert.throws(()=>checkoutPolicy({mode:'live',frontend:'https://www.smartclasss.com'},"'; script-src *"));
});
