const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../routes/neo.js'), 'utf8');
const code = source.slice(source.indexOf('const fetchWithRetry'), source.indexOf('// ==========================================', source.indexOf('const fetchWithRetry')));
function helper(fetch) { return vm.runInNewContext(code + '\nfetchWithRetry', { fetch, AbortSignal, TypeError, Error, setTimeout: fn => fn() }); }
test('timeout retries with a fresh deadline', async () => {
 const signals=[]; const run=helper(async (_,o)=>{signals.push(o.signal); if(signals.length===1)throw Object.assign(new Error(),{name:'TimeoutError'}); return {status:200};});
 assert.equal((await run('url',{})).status,200); assert.equal(signals.length,2); assert.notEqual(signals[0],signals[1]);
});
test('transient HTTP failures cancel the old body and retry',async()=>{for(const status of [429,502,503,504]){let calls=0,cancelled=0; const run=helper(async()=>++calls===1?{status,body:{cancel:async()=>cancelled++}}:{status:200}); assert.equal((await run('url',{})).status,200); assert.equal(cancelled,1);}});
test('authentication errors are not retried',async()=>{let calls=0;const run=helper(async()=>{calls++;return {status:401};});assert.equal((await run('url',{})).status,401);assert.equal(calls,1);});
test('exhausted timeouts return 504',async()=>{const run=helper(async()=>{throw Object.assign(new Error(),{name:'TimeoutError'});});await assert.rejects(run('url',{}),e=>e.status===504);});
test('caller cancellation prevents a provider call',async()=>{let calls=0;const run=helper(async()=>calls++);await assert.rejects(run('url',{signal:AbortSignal.abort()}));assert.equal(calls,0);});
