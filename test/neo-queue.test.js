const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const backend=require('node:path').join(__dirname,'..');

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function server(){
 const handlers={},calls=[],pending=[];
 const router={use(){},post:(r,...h)=>handlers[r]=h.at(-1),get:(r,...h)=>handlers[r]=h.at(-1)};
 vm.runInNewContext(fs.readFileSync(backend+'/routes/neo.js','utf8'),{
  require:n=>n==='express'?{Router:()=>router}:n==='openai'?class{}:{},process:{env:{DEEPINFRA_API_KEY:'test'}},console:{log(){},error(){}},Buffer,AbortSignal,setTimeout:()=>0,module:{exports:{}},
  fetch:async(url,options)=>{calls.push(JSON.parse(options.body).text);await new Promise((resolve,reject)=>pending.push({resolve,reject}));return {ok:true,status:200,arrayBuffer:async()=>new Uint8Array([1,2]).buffer};}
 });
 const request=(text,flags={})=>{const response={status(){return this},json(v){this.body=v;return this},set(){return this},send(v){this.body=v;return this}};return handlers['/speak']({body:{text,...flags}},response).then(()=>response)};
 return {calls,pending,request};
}
test('foreground bypasses queued downloads; duplicate audio generates once',async()=>{
 const s=server();const jobs=[s.request('download one',{offlineDownload:true}),s.request('download two',{offlineDownload:true}),s.request('listen now'),s.request('listen now'),s.request('another learner')];
 await tick();assert.deepEqual(s.calls,['download one','listen now','another learner']);
 s.pending[1].resolve();s.pending[2].resolve();await tick();assert.equal(s.calls.length,3);
 s.pending[0].resolve();await tick();assert.equal(s.calls[3],'download two');s.pending[3].resolve();await Promise.all(jobs);
 await s.request('listen now');assert.equal(s.calls.length,4,'cached clip does not regenerate');
});
test('foreground promotes an existing queued prefetch and failed jobs release capacity',async()=>{
 const s=server();const a=s.request('background',{offlineDownload:true});const b=s.request('upcoming',{prefetch:true});await tick();assert.equal(s.calls.length,1);
 const c=s.request('upcoming');await tick();assert.equal(s.calls.length,2);
 s.pending[1].reject(Error('provider unavailable'));await Promise.all([b,c]);await tick();
 const retry=s.request('upcoming');await tick();assert.equal(s.calls.length,3);
 s.pending[2].resolve();s.pending[0].resolve();await Promise.all([a,retry]);
});

