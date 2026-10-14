const {test}=require('node:test');const assert=require('node:assert/strict');const express=require('express');
const {validate,createRouter}=require('../routes/feedback');
const valid={submissionId:'11111111-1111-4111-8111-111111111111',usage:'broken',payment:'failed',rating:4,contact:false,email:'discard@example.com',details:'Payment stopped',improvement:'Clearer steps',comments:''};
test('validates choices, ratings, text limits and consent',()=>{
 assert.equal(validate(valid).email,'');assert.equal(validate({...valid,rating:null}).rating,null);
 for(const patch of [{usage:'invalid'},{payment:'invalid'},{rating:0},{rating:'5'},{rating:6},{contact:'yes'},{contact:true,email:'bad'},{comments:'x'.repeat(1001)},{usage:'other',other:''},{submissionId:'bad'}])assert.throws(()=>validate({...valid,...patch}));
 assert.equal(validate({...valid,contact:true,email:'person@example.com'}).email,'person@example.com');
});
test('stores parameterized feedback once on retry and protects admin data',async()=>{
 const saved=new Map();let reads=0;const pool={query:async(sql,args)=>{
  if(sql.startsWith('CREATE'))return {rows:[]};
  if(sql.startsWith('INSERT')){assert(sql.includes('ON CONFLICT'));if(!saved.has(args[0]))saved.set(args[0],args);return{rows:[]};}
  reads++;if(sql.includes('AVG'))return{rows:[{total:saved.size,average_rating:4,rated:1,contactable:0}]};
  return {rows:[]};
 }};
 const app=express();app.use(express.json());app.use('/api/feedback',createRouter(pool,(req,res,next)=>req.headers.authorization==='Bearer test-admin'?next():res.status(401).json({error:'Admin auth required'})));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port+'/api/feedback';
 try{
  const submit=b=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
  assert.equal((await submit({...valid,usage:'other'})).status,400);assert.equal(saved.size,0);
  assert.equal((await submit(valid)).status,201);assert.equal((await submit(valid)).status,201);assert.equal(saved.size,1);assert.equal(saved.get(valid.submissionId)[9],null);
  assert.equal((await fetch(url+'/admin')).status,401);assert.equal(reads,0);
  const response=await fetch(url+'/admin',{headers:{Authorization:'Bearer test-admin'}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).summary.total,1);
 }finally{await new Promise(r=>server.close(r));}
});
test('storage failures do not falsely report success',async()=>{
 const app=express();app.use(express.json());app.use(createRouter({query:async()=>{throw Error('offline')}},(_,res)=>res.sendStatus(401)));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const r=await fetch('http://127.0.0.1:'+server.address().port,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(valid)});assert.equal(r.status,503);assert.equal((await r.json()).success,undefined);}finally{await new Promise(r=>server.close(r));}
});
