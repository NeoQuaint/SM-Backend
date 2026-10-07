const test=require('node:test'),assert=require('node:assert/strict');
const {settleYocoEvent,checkoutIdFrom}=require('../services/yoco-settlement');
const basePayment=()=>({checkout_id:'ch_checkout1',user_id:'student-uuid',package:'Standard',amount:'59.00',status:'pending',created_at:new Date('2026-10-07T10:00:00Z')});
const event=(changes={})=>({type:'payment.succeeded',payload:{id:'p_payment1',status:'succeeded',mode:'live',amount:5900,currency:'ZAR',metadata:{checkoutId:'ch_checkout1'},...changes}});
function database({payment=basePayment(),subscription=null,failGrant=false}={}){
 let state={payment,subscription},snapshot;const calls=[];let grants=0,released=0;
 const client={release(){released++;},async query(sql,args=[]){calls.push({sql,args});
  if(sql==='BEGIN'){snapshot=structuredClone(state);return{rows:[]};}
  if(sql==='ROLLBACK'){state=snapshot;return{rows:[]};}
  if(sql==='COMMIT'||sql.includes('pg_advisory'))return{rows:[]};
  if(sql.startsWith('SELECT * FROM smartclass_subscription_payments'))return{rows:state.payment?[state.payment]:[]};
  if(sql.startsWith('SELECT s.payment_reference'))return{rows:state.subscription?[state.subscription]:[]};
  if(sql.startsWith('INSERT INTO smartclass_subscriptions')){if(failGrant)throw new Error('database unavailable');grants++;state.subscription={payment_reference:args[3],package:args[1],amount:args[2],user_id:args[0],status:'active'};return{rows:[]};}
  if(sql.startsWith('UPDATE smartclass_subscription_payments')){if(sql.includes("status = 'completed'"))state.payment.status='completed';else if(sql.includes("status = 'refunded'"))state.payment.status='refunded';else if(state.payment.status==='pending')state.payment.status='failed';return{rows:[]};}
  if(sql.startsWith('UPDATE smartclass_subscriptions SET status')){if(state.subscription?.payment_reference===args[1])state.subscription.status='cancelled';return{rows:[]};}
  throw new Error('Unexpected SQL: '+sql);
 }};
 return {pool:{connect:async()=>client},calls,get state(){return state;},get grants(){return grants;},get released(){return released;}};
}
test('real Yoco payload uses metadata checkoutId, not p_ payment ID; custom user metadata is not required',async()=>{
 const db=database();const result=await settleYocoEvent(db.pool,event());assert.equal(result.subscription,true);assert.equal(db.state.payment.status,'completed');assert.equal(db.state.subscription.user_id,'student-uuid');assert.equal(db.state.subscription.package,'Standard');assert.equal(db.calls[1].args[0],'ch_checkout1');assert.equal(db.released,1);
});
test('duplicate success cannot extend access or grant twice',async()=>{
 const db=database();await settleYocoEvent(db.pool,event());const result=await settleYocoEvent(db.pool,event());assert.equal(result.duplicate,true);assert.equal(db.grants,1);
});
test('payment and access roll back together; a later retry recovers the pending payment',async()=>{
 const broken=database({failGrant:true});await assert.rejects(settleYocoEvent(broken.pool,event()),/database unavailable/);assert.equal(broken.state.payment.status,'pending');assert.equal(broken.state.subscription,null);assert.equal(broken.released,1);const fixed=database({payment:broken.state.payment});await settleYocoEvent(fixed.pool,event());assert.equal(fixed.state.payment.status,'completed');
});
test('wrong amount, currency, mode, owner or non-success status cannot grant access',async()=>{
 for(const change of [{amount:3900},{amount:'5900'},{currency:'USD'},{mode:'test'},{status:'pending'},{metadata:{checkoutId:'ch_checkout1',userId:'another-user'}},{metadata:{checkoutId:'ch_checkout1',package:'Basic'}}]){const db=database();await assert.rejects(settleYocoEvent(db.pool,event(change)));assert.equal(db.grants,0);assert.equal(db.state.payment.status,'pending');}
});
test('missing or unknown checkout stays retryable instead of acknowledged as success',async()=>{
 assert.equal(checkoutIdFrom({id:'p_payment1'}),null);await assert.rejects(settleYocoEvent(database().pool,event({metadata:{}})),{status:400});await assert.rejects(settleYocoEvent(database({payment:null}).pool,event()),{status:503});
});
test('created events do not activate; delayed failures do not undo a success',async()=>{
 const db=database();assert.equal((await settleYocoEvent(db.pool,{...event(),type:'payment.created'})).skipped,'unsupported event');assert.equal(db.grants,0);await settleYocoEvent(db.pool,event());await settleYocoEvent(db.pool,{...event({status:'failed'}),type:'payment.failed'});assert.equal(db.state.payment.status,'completed');assert.equal(db.state.subscription.status,'active');
});
test('refund prevents a delayed success from reactivating it',async()=>{
 const db=database();await settleYocoEvent(db.pool,event());await settleYocoEvent(db.pool,{...event(),type:'refund.succeeded'});assert.equal(db.state.subscription.status,'cancelled');await settleYocoEvent(db.pool,event());assert.equal(db.state.payment.status,'refunded');assert.equal(db.grants,1);
});
test('an old payment or refund cannot replace/cancel a more recent plan',async()=>{
 const sub={payment_reference:'ch_newer',payment_created_at:new Date('2026-10-07T12:00:00Z'),status:'active',package:'Basic'};const db=database({subscription:sub});await settleYocoEvent(db.pool,event());assert.equal(db.grants,0);assert.equal(db.state.payment.status,'completed');await settleYocoEvent(db.pool,{...event(),type:'refund.succeeded'});assert.equal(db.state.subscription.status,'active');
});
