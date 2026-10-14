const express=require('express');
const rateLimit=require('express-rate-limit');
const options=require('../data/feedbackOptions.json');
function validate(body){
 if(!body || typeof body!=='object')throw Error('Please complete the feedback form.');
 const text=(key,max)=>{const value=body[key]??'';if(typeof value!=='string'||value.length>max)throw Error('Please keep your answers within the displayed limits.');return value.trim();};
 const usage=text('usage',30),payment=text('payment',30);
 if(!options.usage.some(o=>o[0]===usage)||!options.payment.some(o=>o[0]===payment))throw Error('Please choose one answer for each of the first two questions.');
 const other=text('other',500),details=text('details',1000),improvement=text('improvement',1000),comments=text('comments',1000);
 if(usage==='other'&&!other)throw Error('Please tell us what is stopping you.');
 if(body.rating!==null&&(!Number.isInteger(body.rating)||body.rating<1||body.rating>5))throw Error('Please select a rating or choose not enough experience.');
 if(body.contact!==true&&body.contact!==false)throw Error('Please check your contact preference.');
 const email=body.contact?text('email',254):'';
 if(body.contact&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('Please enter a valid email address.');
 const submissionId=text('submissionId',36);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(submissionId))throw Error('Please refresh the page and try again.');
 return {submissionId,usage,payment,other:usage==='other'?other:'',details:['broken'].includes(usage)||payment==='failed'?details:'',improvement,comments,rating:body.rating,contact:body.contact,email};
}
function createRouter(pool,requireAdmin){
 const router=express.Router();let ready;
 const ensure=()=>ready||(ready=pool.query(`CREATE TABLE IF NOT EXISTS smartclass_feedback (
 id BIGSERIAL PRIMARY KEY, submission_id UUID UNIQUE NOT NULL, usage_reason TEXT NOT NULL, payment_reason TEXT NOT NULL,
 other_reason TEXT NOT NULL DEFAULT '', issue_details TEXT NOT NULL DEFAULT '', improvement TEXT NOT NULL DEFAULT '', comments TEXT NOT NULL DEFAULT '',
 rating INTEGER CHECK(rating BETWEEN 1 AND 5), contact_consent BOOLEAN NOT NULL DEFAULT false, email TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`).catch(e=>{ready=null;throw e;}));
 router.get('/health',async(req,res)=>{try{await ensure();res.json({status:'ready',version:1});}catch{res.status(503).json({error:'Feedback is temporarily unavailable.'});}});
 router.post('/',rateLimit({windowMs:15*60*1000,limit:8,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Too many submissions. Please try again later.'}}),async(req,res)=>{
  let v;try{v=validate(req.body);}catch(e){return res.status(400).json({error:e.message});}
  try{await ensure();await pool.query(`INSERT INTO smartclass_feedback (submission_id,usage_reason,payment_reason,other_reason,issue_details,improvement,comments,rating,contact_consent,email)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(submission_id) DO NOTHING`,[v.submissionId,v.usage,v.payment,v.other,v.details,v.improvement,v.comments,v.rating,v.contact,v.email||null]);res.status(201).json({success:true});}
  catch{res.status(503).json({error:'Your feedback could not be saved. Please try again.'});}
 });
 router.get('/admin',requireAdmin,async(req,res)=>{
  const page=Math.max(1,Math.min(100000,parseInt(req.query.page,10)||1));
  try{await ensure();const [summary,usage,payment,rows]=await Promise.all([
   pool.query('SELECT COUNT(*)::int AS total, ROUND(AVG(rating),1) AS average_rating, COUNT(rating)::int AS rated, COUNT(*) FILTER (WHERE contact_consent)::int AS contactable FROM smartclass_feedback'),
   pool.query('SELECT usage_reason AS reason, COUNT(*)::int AS count FROM smartclass_feedback GROUP BY usage_reason ORDER BY count DESC'),
   pool.query('SELECT payment_reason AS reason, COUNT(*)::int AS count FROM smartclass_feedback GROUP BY payment_reason ORDER BY count DESC'),
   pool.query('SELECT * FROM smartclass_feedback ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET $1',[(page-1)*50])]);
   res.set('Cache-Control','no-store');res.json({summary:summary.rows[0],usage:usage.rows,payment:payment.rows,responses:rows.rows,page});
  }catch{res.status(503).json({error:'Could not load feedback. Please retry.'});}
 });
 return router;
}
module.exports=createRouter(require('../db'),require('../middleware/requireAdmin'));
module.exports.createRouter=createRouter;module.exports.validate=validate;
