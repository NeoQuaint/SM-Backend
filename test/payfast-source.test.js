const test=require('node:test'),assert=require('node:assert/strict');
const {paymentSource}=require('../services/payfast-source');
const {signature,validateNotification}=require('../services/payfast-security');
test('Render uses edge client IP instead of Express proxy hop and ignores spoofed XFF when edge header exists',()=>{
 const req={ip:'10.0.0.1',socket:{remoteAddress:'10.0.0.2'},headers:{'cf-connecting-ip':'192.0.2.1','x-forwarded-for':'198.51.100.5, 192.0.2.1, 10.0.0.1'}};
 assert.equal(paymentSource(req,{RENDER:'true'}),'192.0.2.1');
 assert.equal(paymentSource(req,{}),'10.0.0.2');
});
test('Render documented forwarded client fallback is normalized and malformed addresses fail closed',()=>{
 assert.equal(paymentSource({headers:{'x-forwarded-for':'::ffff:192.0.2.1, 10.0.0.1'}},{RENDER:'true'}),'192.0.2.1');
 for(const headers of [{},{'cf-connecting-ip':'bad','x-forwarded-for':'192.0.2.1'},{'cf-connecting-ip':['192.0.2.1']},{'cf-connecting-ip':'192.0.2.1, 10.0.0.1'}])assert.throws(()=>paymentSource({headers},{RENDER:'true'}));
});
test('forwarded source must still match PayFast and notification must pass cryptographic and server verification',async()=>{
 const cfg={mode:'live',merchantId:'test',passphrase:'test-pass',host:'www.payfast.co.za'};
 const data={merchant_id:'test',amount_gross:'59.00'};data.signature=signature(data,cfg.passphrase);
 const deps={resolve4:async()=>['192.0.2.1'],fetcher:async()=>({ok:true,text:async()=>'VALID'})};
 const req={ip:'10.0.0.1',headers:{'cf-connecting-ip':'192.0.2.1'}};
 await validateNotification(data,paymentSource(req,{RENDER:'true'}),cfg,deps);
 await assert.rejects(validateNotification(data,'198.51.100.5',cfg,deps),/source/);
 await assert.rejects(validateNotification({...data,signature:'0'.repeat(32)},paymentSource(req,{RENDER:'true'}),cfg,deps),/signature/);
 await assert.rejects(validateNotification(data,paymentSource(req,{RENDER:'true'}),cfg,{...deps,fetcher:async()=>({ok:true,text:async()=>'INVALID'})}),/validate/);
});
