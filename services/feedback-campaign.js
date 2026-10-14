const crypto=require('crypto');
const SUBJECT='What could make Smartclass better for you?';
const LINK='https://smartclass-feedback.vercel.app';
const API='https://smartclass-wlgb.onrender.com';
const KEY='feedback-invitation-v1';
const SCHEMA=`CREATE TABLE IF NOT EXISTS smartclass_feedback_campaigns (
 id SERIAL PRIMARY KEY, campaign_key TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'sending',
 created_by INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS smartclass_feedback_email_optouts(email TEXT PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS smartclass_feedback_email_recipients (
 id BIGSERIAL PRIMARY KEY,campaign_id INTEGER NOT NULL REFERENCES smartclass_feedback_campaigns(id),
 email TEXT NOT NULL,full_name TEXT NOT NULL DEFAULT '',unsubscribe_token TEXT UNIQUE NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',claimed_at TIMESTAMPTZ,sent_at TIMESTAMPTZ,
 UNIQUE(campaign_id,email));`;
const ELIGIBLE=`SELECT DISTINCT ON (lower(trim(u.email))) lower(trim(u.email)) AS email, COALESCE(u.full_name,'') AS full_name
 FROM users u WHERE u.email IS NOT NULL AND trim(u.email) ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
 AND NOT EXISTS(SELECT 1 FROM smartclass_feedback_email_optouts o WHERE o.email=lower(trim(u.email)))
 ORDER BY lower(trim(u.email)),u.created_at DESC`;
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function textFor(name){const first=name==='[First name]'?name:String(name||'').trim().split(/\s+/)[0];return `Hi ${first||'there'},\n\nWe are working on making Smartclass more useful, and we would love to hear about your experience.\n\nWas anything confusing? Did something not work? Is there something holding you back from studying with us or choosing a paid plan?\n\nOur short feedback form takes about two minutes. You do not need to sign in, and you can leave out your contact details.\n\nShare your feedback: ${LINK}\n\nWhether you have used Smartclass once or regularly, your honest feedback will help us decide what to improve next.\n\nThank you for your time,\nThe Smartclass team`;}
function message(recipient,sender,{test=false}={}){
 const text=textFor(recipient.full_name);const unsubscribe=recipient.unsubscribe_token?`${API}/api/feedback-email/unsubscribe/${recipient.unsubscribe_token}`:null;
 return {from:{name:'Smartclass',address:sender},to:recipient.email,replyTo:sender,subject:(test?'[Test] ':'')+SUBJECT,
 ...(test?{}:{messageId:`<feedback-${recipient.id}-${recipient.campaign_id}@smartclasss.com>`}),
 text:text+(unsubscribe?`\n\nNo more feedback invitations: ${unsubscribe}`:'\n\nThis is a preview sent only to your admin email.'),
 html:`<div style="background:#f7f2fc;padding:30px 16px;font-family:Arial,sans-serif;color:#30233e"><div style="max-width:540px;margin:auto;padding:30px;background:white;border-radius:20px"><strong style="color:#7135db">Smartclass</strong><h1 style="font-size:28px">Help us make Smartclass better.</h1>${text.split('\n\n').map(p=>p.startsWith('Share your feedback:')?`<p><a href="${LINK}" style="display:inline-block;padding:15px 24px;border-radius:25px;background:#7135db;color:white;text-decoration:none;font-weight:bold">Share my feedback →</a></p>`:`<p style="line-height:1.7">${escape(p).replace(/\n/g,'<br>')}</p>`).join('')}<p style="font-size:12px;color:#83758d">${unsubscribe?`<a href="${unsubscribe}">Stop feedback invitations</a> · This does not affect account or payment emails.`:'Test email — only your admin address receives this preview.'}</p></div></div>`,
 ...(unsubscribe?{headers:{'List-Unsubscribe':`<${unsubscribe}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}}:{})};
}
function transport(env=process.env){if(!env.SUPPORT_EMAIL_PASSWORD)return null;const sender=env.SUPPORT_EMAIL||'smartclass.za@gmail.com';return {sender,client:require('nodemailer').createTransport({service:'gmail',auth:{user:sender,pass:env.SUPPORT_EMAIL_PASSWORD},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000})};}
function service(pool,mail=transport()){
 let ready;const ensure=()=>ready||(ready=pool.query(SCHEMA).catch(e=>{ready=null;throw e;}));
 async function snapshot(){await ensure();const [audience,campaign]=await Promise.all([pool.query(`SELECT COUNT(*)::int AS count FROM (${ELIGIBLE}) eligible`),pool.query(`SELECT c.*,COUNT(r.id)::int AS total,
 COUNT(r.id) FILTER(WHERE r.status='pending')::int AS pending,COUNT(r.id) FILTER(WHERE r.status='sending')::int AS sending,
 COUNT(r.id) FILTER(WHERE r.status='sent')::int AS sent,COUNT(r.id) FILTER(WHERE r.status='failed')::int AS failed,
 COUNT(r.id) FILTER(WHERE r.status='unknown')::int AS unknown,COUNT(r.id) FILTER(WHERE r.status='skipped')::int AS skipped
 FROM smartclass_feedback_campaigns c LEFT JOIN smartclass_feedback_email_recipients r ON r.campaign_id=c.id WHERE c.campaign_key=$1 GROUP BY c.id`,[KEY])]);return {configured:!!mail,sender:mail?.sender||null,eligible:audience.rows[0].count,subject:SUBJECT,body:textFor('[First name]'),link:LINK,campaign:campaign.rows[0]||null};}
 async function queue(adminId){if(!mail)throw Error('Email is not configured.');await ensure();const db=await pool.connect();try{await db.query('BEGIN');const inserted=await db.query('INSERT INTO smartclass_feedback_campaigns(campaign_key,created_by) VALUES($1,$2) ON CONFLICT(campaign_key) DO NOTHING RETURNING id',[KEY,adminId]);if(inserted.rows[0]){const users=await db.query(ELIGIBLE);const recipients=users.rows.map(u=>({...u,token:crypto.randomBytes(32).toString('hex')}));await db.query(`INSERT INTO smartclass_feedback_email_recipients(campaign_id,email,full_name,unsubscribe_token) SELECT $1,x.email,x.full_name,x.token FROM jsonb_to_recordset($2::jsonb) AS x(email text,full_name text,token text) ON CONFLICT(campaign_id,email) DO NOTHING`,[inserted.rows[0].id,JSON.stringify(recipients)]);}await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}return snapshot();}
 async function tick(){if(!mail)return;await ensure();
  const daily=await pool.query("SELECT COUNT(*)::int AS count FROM smartclass_feedback_email_recipients WHERE sent_at>NOW()-INTERVAL '24 hours'");
  if(daily.rows[0].count>=400)return;
  // An interrupted SMTP attempt may already have delivered. Never automatically resend it.
  await pool.query("UPDATE smartclass_feedback_email_recipients SET status='unknown' WHERE status='sending' AND claimed_at<NOW()-INTERVAL '5 minutes'");
  const claimed=await pool.query(`UPDATE smartclass_feedback_email_recipients SET status='sending',claimed_at=NOW() WHERE id=(
 SELECT r.id FROM smartclass_feedback_email_recipients r JOIN smartclass_feedback_campaigns c ON c.id=r.campaign_id
 WHERE r.status='pending' AND c.status='sending' ORDER BY r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1) RETURNING *`);
  const recipient=claimed.rows[0];if(recipient){const opted=await pool.query('SELECT 1 FROM smartclass_feedback_email_optouts WHERE email=$1',[recipient.email]);if(opted.rows.length){await pool.query("UPDATE smartclass_feedback_email_recipients SET status='skipped' WHERE id=$1",[recipient.id]);return;}
   let accepted=false;try{const result=await mail.client.sendMail(message(recipient,mail.sender));if(!result.accepted?.some(e=>String(e).toLowerCase()===recipient.email))throw Error('Recipient not accepted');accepted=true;await pool.query("UPDATE smartclass_feedback_email_recipients SET status='sent',sent_at=NOW() WHERE id=$1",[recipient.id]);}catch(error){if(accepted){console.warn('Feedback delivery status could not be saved; manual review required.');return;}const status=error.responseCode>=400||error.code==='EAUTH'||error.code==='EENVELOPE'?'failed':'unknown';await pool.query('UPDATE smartclass_feedback_email_recipients SET status=$2 WHERE id=$1',[recipient.id,status]);}
  }
  await pool.query("UPDATE smartclass_feedback_campaigns c SET status='complete' WHERE status='sending' AND NOT EXISTS(SELECT 1 FROM smartclass_feedback_email_recipients r WHERE r.campaign_id=c.id AND r.status IN ('pending','sending'))");
 }
 async function test(admin){if(!mail)throw Error('Email is not configured.');const result=await mail.client.sendMail(message({email:admin.email,full_name:admin.full_name},mail.sender,{test:true}));if(!result.accepted?.length)throw Error('Test email was not accepted.');}
 async function cancel(){await ensure();await pool.query("UPDATE smartclass_feedback_campaigns SET status='cancelled' WHERE campaign_key=$1 AND status='sending'",[KEY]);await pool.query("UPDATE smartclass_feedback_email_recipients SET status='skipped' WHERE status='pending' AND campaign_id IN(SELECT id FROM smartclass_feedback_campaigns WHERE campaign_key=$1 AND status='cancelled')",[KEY]);return snapshot();}
 async function unsubscribe(token){await ensure();const result=await pool.query('INSERT INTO smartclass_feedback_email_optouts(email) SELECT email FROM smartclass_feedback_email_recipients WHERE unsubscribe_token=$1 ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING email',[token]);if(!result.rows.length)return false;await pool.query("UPDATE smartclass_feedback_email_recipients SET status='skipped' WHERE email=$1 AND status='pending'",[result.rows[0].email]);return true;}
 return {ensure,snapshot,queue,tick,test,cancel,unsubscribe};
}
function startFeedbackCampaigns(pool){const worker=service(pool);let running=false;const tick=async()=>{if(running)return;running=true;try{await worker.tick();}catch{console.warn('Feedback campaign worker will check again shortly.');}finally{running=false;}};void tick();const timer=setInterval(tick,15000);timer.unref?.();return()=>clearInterval(timer);}
module.exports={service,startFeedbackCampaigns,message,textFor,SCHEMA,ELIGIBLE};

