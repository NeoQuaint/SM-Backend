const router=require('express').Router();
const rateLimit=require('express-rate-limit');
const requireAdmin=require('../middleware/requireAdmin');
const store=require('../services/visitor-analytics').createStore(require('../db'));
const {snapshot,brief,validRequest,answer}=require('../services/admin-insights');
router.use(requireAdmin);
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
router.get('/',async(req,res)=>{const days=Number(req.query.days||7);if(![1,7,30,90].includes(days))return res.status(400).json({success:false,error:'Choose a valid report period.'});try{const data=snapshot(await store.report(days,0,false));res.json({success:true,snapshot:data,brief:brief(data)});}catch{res.status(503).json({success:false,error:'Analytics could not load. Retry shortly.'});}});
router.post('/ask',rateLimit({windowMs:60000,max:8,keyGenerator:req=>String(req.admin.id),standardHeaders:true,legacyHeaders:false,message:{success:false,error:'Please wait a minute before asking again.'}}),async(req,res)=>{
 if(!validRequest(req.body))return res.status(400).json({success:false,error:'Use a question under 1,000 characters and a valid report period.'});
 try{const data=snapshot(await store.report(req.body.days,0,false));const reply=await answer(data,req.body.question,req.body.history||[]);res.json({success:true,...reply,brief:brief(data),snapshot:data});}catch{res.status(503).json({success:false,error:'Analytics could not load. Your question has not been lost; please retry.'});}
});
module.exports=router;
