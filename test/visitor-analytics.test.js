const test=require('node:test'),assert=require('node:assert/strict');
const {validate,createStore}=require('../services/visitor-analytics');
const sample={id:'11111111-1111-4111-8111-111111111111',session:'22222222-2222-4222-8222-222222222222',visitor:'33333333-3333-4333-8333-333333333333',stage:'welcome',action:'view',source:'google.com',device:'mobile'};
test('only bounded, permitted metadata is accepted',()=>{
 const event=validate({...sample,seconds:9000,email:'secret@example.test',answer:'private',source:'https://example.test/?token=secret'});
 assert.equal(event.seconds,30);assert.equal(event.source,'direct');assert.equal(event.email,undefined);assert.equal(event.answer,undefined);
 for(const body of [null,{}, {...sample,id:'bad'},{...sample,stage:'constructor'},{...sample,action:'payment_confirmed'}])assert.equal(validate(body),null);
});
test('failed writes roll back and do not falsely succeed',async()=>{
 const calls=[];const client={query:async sql=>{calls.push(sql);if(sql.startsWith('INSERT INTO smartclass_visits'))throw Error('unavailable');},release(){calls.push('released');}};
 const store=createStore({query:async()=>({rows:[]}),connect:async()=>client});
 await assert.rejects(store.record(validate(sample),null),/unavailable/);assert(calls.includes('ROLLBACK'));assert(calls.includes('released'));assert(!calls.includes('COMMIT'));
});
