const express=require('express');const rateLimit=require('express-rate-limit');
const {service}=require('../services/feedback-campaign');
function createRouter(campaigns,requireAdmin){
const router=express.Router();
const limiter=rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:true,legacyHeaders:false,message:{error:'Please wait before trying again.'}});
router.get('/admin',requireAdmin,async(req,res)=>{res.set('Cache-Control','no-store');try{res.json(await campaigns.snapshot());}catch{res.status(503).json({error:'Email campaign details are temporarily unavailable.'});}});
router.post('/admin/test',requireAdmin,limiter,async(req,res)=>{try{await campaigns.test(req.admin);res.json({success:true,message:'Test email accepted by the email provider.'});}catch{res.status(503).json({error:'The test email could not be sent. Please check the email configuration and try again.'});}});
router.post('/admin/send',requireAdmin,limiter,async(req,res)=>{if(req.body?.confirmation!=='SEND TO ALL CLIENTS')return res.status(400).json({error:'Please confirm the recipient group before sending.'});try{res.json(await campaigns.queue(req.admin.id));}catch{res.status(503).json({error:'Could not queue the campaign. Please refresh to check its status before trying again.'});}});
router.post('/admin/cancel',requireAdmin,limiter,async(req,res)=>{try{res.json(await campaigns.cancel());}catch{res.status(503).json({error:'Could not cancel the remaining invitations. Please refresh and try again.'});}});
const validToken=token=>/^[a-f0-9]{64}$/.test(token||'');
const page=(title,body)=>`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | Smartclass</title><body style="font-family:Arial;background:#faf7ff;color:#30233e;padding:40px 20px"><main style="max-width:520px;margin:auto"><h1>${title}</h1>${body}</main></body></html>`;
router.get('/unsubscribe/:token',(req,res)=>{if(!validToken(req.params.token))return res.status(400).send('Invalid link');res.set('Cache-Control','no-store').type('html').send(page('Stop feedback invitations?',`<p>Your account and payment emails will not change.</p><form method="post"><button style="padding:15px;border:0;border-radius:12px;background:#7135db;color:white">Stop feedback invitations</button></form>`));});
router.post('/unsubscribe/:token',async(req,res)=>{if(!validToken(req.params.token))return res.status(400).send('Invalid link');try{if(!await campaigns.unsubscribe(req.params.token))return res.status(404).send('This link could not be found.');res.type('html').send(page('You are unsubscribed.','<p>You will no longer receive feedback invitations from Smartclass.</p>'));}catch{res.status(503).send('Please try again in a moment.');}});
return router;
}
module.exports=createRouter(service(require('../db')),require('../middleware/requireAdmin'));
module.exports.createRouter=createRouter;
