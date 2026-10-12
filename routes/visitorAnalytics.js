const express=require('express');
const jwt=require('jsonwebtoken');
const rateLimit=require('express-rate-limit');
const requireAdmin=require('../middleware/requireAdmin');
const {validate,createStore}=require('../services/visitor-analytics');
const store=createStore(require('../db'));
const router=express.Router();
router.post('/event',rateLimit({windowMs:60000,max:90,standardHeaders:true,legacyHeaders:false}),async(req,res)=>{
 const event=validate(req.body);if(!event)return res.status(400).json({success:false,error:'Invalid visit event'});
 let userId=null;
 try{const token=req.headers.authorization?.replace(/^Bearer /,'');if(token){const claims=jwt.verify(token,process.env.JWT_SECRET||'smartclass_dev_secret');if(/^[0-9a-f-]{36}$/i.test(claims.id||''))userId=claims.id;}}catch{}
 try{await store.record(event,userId);res.status(202).json({success:true});}catch{console.warn('Visitor analytics write unavailable');res.status(503).json({success:false,error:'Tracking temporarily unavailable'});}
});
router.get('/report',requireAdmin,async(req,res)=>{
 const days=Number(req.query.days||7),offset=Number(req.query.offset||0);
 if(![1,7,30,90].includes(days)||!Number.isSafeInteger(offset)||offset<0||offset>100000)return res.status(400).json({success:false,error:'Invalid report range'});
 try{res.set('Cache-Control','no-store');res.json(await store.report(days,offset));}catch{res.status(503).json({success:false,error:'Visitor analytics is not available yet. Check the backend deployment and retry.'});}
});
module.exports=router;
