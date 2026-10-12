const test = require('node:test'), assert = require('node:assert/strict');
const { encode, parameters, signature, parseNotification, cents, config, validateNotification } = require('../services/payfast-security');
const cfg = { merchantId: '10000100', passphrase: 'test-pass', mode: 'test', host: 'sandbox.payfast.co.za' };
test('realistic ITN keeps blank fields and exact whitespace in signature and server confirmation', async () => {
  const canonical = 'm_payment_id=pf_123&pf_payment_id=1234&payment_status=COMPLETE&item_name=Study+plan&item_description=&custom_str1=&amount_gross=59.00&name_first=+Neo+&merchant_id=10000100';
  const digest = require('node:crypto').createHash('md5').update(canonical + '&passphrase=test-pass').digest('hex');
  const data = parseNotification(Buffer.from(canonical + '&signature=' + digest));
  const deps = {resolve4:async()=>['192.0.2.1'],fetcher:async(url,options)=>{assert.equal(options.body,canonical);return {ok:true,text:async()=> 'VALID'};}};
  await validateNotification(data,'192.0.2.1',cfg,deps);
  await assert.rejects(validateNotification({...data,custom_str1:'changed'},'192.0.2.1',cfg,deps),/signature/);
  const removed={...data};delete removed.item_description;
  await assert.rejects(validateNotification(removed,'192.0.2.1',cfg,deps),/signature/);
});
const signed = () => { const data = { m_payment_id: 'pf_123', pf_payment_id: '1234', payment_status: 'COMPLETE', amount_gross: '59.00', merchant_id: cfg.merchantId }; data.signature = signature(data, cfg.passphrase); return data; };
test('PHP form encoding, insertion order and signature exclusion', () => {
  assert.equal(encode(" A ~!*'() "), 'A+%7E%21%2A%27%28%29');
  assert.equal(parameters({z:' hello ',a:'one two',empty:'',signature:'ignored'}), 'z=hello&a=one+two');
  assert.equal(signature({a:'1'}, ''), '3872c9ae3f427af0be0ead09d07ae2cf');
  assert.notEqual(signature({a:1,b:2},''), signature({b:2,a:1},''));
});
test('raw notification rejects duplicate fields; amounts are exact integer cents', () => {
  assert.throws(()=>parseNotification(Buffer.from('amount_gross=59&amount_gross=1')));
  assert.equal(parseNotification(Buffer.from('item_name=Study+plan')).item_name,'Study plan');
  assert.equal(cents('59.00'),5900);
  for (const value of ['NaN','1e3','-1','0','59.001']) assert.throws(()=>cents(value));
});
test('configuration fails closed without explicit mode and credentials', () => {
  assert.throws(()=>config({}));
  assert.throws(()=>config({PAYFAST_TEST_MODE:'true',PAYFAST_MERCHANT_ID:'id',PAYFAST_MERCHANT_KEY:'key'}));
});
test('ITN requires signature, matching merchant, PayFast source and server confirmation', async () => {
  const deps = {resolve4:async()=>['192.0.2.1'],fetcher:async(url,options)=>{assert.equal(url,'https://sandbox.payfast.co.za/eng/query/validate');assert.ok(!options.body.includes('passphrase'));assert.ok(!options.body.includes('signature'));return {ok:true,text:async()=> 'VALID'};}};
  await validateNotification(signed(),'::ffff:192.0.2.1',cfg,deps);
  await assert.rejects(validateNotification({...signed(),amount_gross:'1.00'},'192.0.2.1',cfg,deps),/signature/);
  await assert.rejects(validateNotification(signed(),'192.0.2.2',cfg,deps),/source/);
  await assert.rejects(validateNotification(signed(),'192.0.2.1',{...cfg,merchantId:'other'},deps),/merchant/);
  await assert.rejects(validateNotification(signed(),'192.0.2.1',cfg,{...deps,fetcher:async()=>({ok:true,text:async()=> 'INVALID'})}),/validate/);
  await assert.rejects(validateNotification(signed(),'192.0.2.1',cfg,{...deps,resolve4:async()=>{throw Error('dns down');}}),{status:503});
});
