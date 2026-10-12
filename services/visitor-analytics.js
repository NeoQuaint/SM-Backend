const STAGES = {welcome:'Welcome page',personalise:'Name & study buddy',subjects:'Tutorial subjects',grade:'Grade',review:'Personalisation ready',tutorial:'Free tutorial',account:'Create account / sign in',paywall:'Choose package',checkout:'Checkout opened',payment:'Payment return',subject_selection:'Paid subject selection',dashboard:'Dashboard',other:'Other page'};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEMA=`CREATE TABLE IF NOT EXISTS smartclass_visits (
 id UUID PRIMARY KEY, visitor_id UUID NOT NULL, user_id UUID REFERENCES users(id) ON DELETE SET NULL,
 started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 entry_stage TEXT NOT NULL, last_stage TEXT NOT NULL, source TEXT NOT NULL, device TEXT NOT NULL,
 reached JSONB NOT NULL DEFAULT '{}', active_seconds INTEGER NOT NULL DEFAULT 0,
 interacted BOOLEAN NOT NULL DEFAULT FALSE, form_started BOOLEAN NOT NULL DEFAULT FALSE,
 checkout_error BOOLEAN NOT NULL DEFAULT FALSE, tutorial_skipped BOOLEAN NOT NULL DEFAULT FALSE,
 last_event BIGINT NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS smartclass_visits_started ON smartclass_visits(started_at);
 CREATE TABLE IF NOT EXISTS smartclass_visit_receipts (
 id UUID PRIMARY KEY, visit_id UUID NOT NULL REFERENCES smartclass_visits(id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS smartclass_visit_settings(id INTEGER PRIMARY KEY CHECK(id=1), enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 INSERT INTO smartclass_visit_settings(id) VALUES(1) ON CONFLICT DO NOTHING;`;
function validate(body){
 if(!body||!UUID.test(body.id)||!UUID.test(body.session)||!UUID.test(body.visitor)||!Object.hasOwn(STAGES,body.stage)||!['view','interact','form','heartbeat','checkout_error','tutorial_skip'].includes(body.action))return null;
 return {id:body.id,session:body.session,visitor:body.visitor,stage:body.stage,action:body.action,at:Math.min(Date.now()+5000,Math.max(Date.now()-300000,Number(body.at)||Date.now())),
 seconds:Math.min(30,Math.max(0,Math.floor(Number(body.seconds)||0))),
 source:typeof body.source==='string'&&/^[a-zA-Z0-9.-]{1,100}$/.test(body.source)?body.source:'direct',
 device:['mobile','tablet','desktop'].includes(body.device)?body.device:'desktop'};
}
function createStore(pool){
 let ready,cleanupAt=0;
 const ensure=()=>ready||(ready=pool.query(SCHEMA).catch(e=>{ready=null;throw e;}));
 async function record(event,userId){
  await ensure();
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   await client.query(`INSERT INTO smartclass_visits(id,visitor_id,user_id,entry_stage,last_stage,source,device) VALUES($1,$2,$3,$4,$4,$5,$6) ON CONFLICT DO NOTHING`,[event.session,event.visitor,userId,event.stage,event.source,event.device]);
   const inserted=await client.query(`INSERT INTO smartclass_visit_receipts(id,visit_id) SELECT $1,id FROM smartclass_visits WHERE id=$2 AND visitor_id=$3 ON CONFLICT DO NOTHING RETURNING id`,[event.id,event.session,event.visitor]);
   if(inserted.rowCount)await client.query(`UPDATE smartclass_visits SET last_seen=NOW(),last_stage=CASE WHEN $9>=last_event THEN $2 ELSE last_stage END,last_event=GREATEST(last_event,$9),user_id=COALESCE(user_id,$3),reached=reached || jsonb_build_object($2::text,true),active_seconds=LEAST(86400,active_seconds+$4),interacted=interacted OR $5,form_started=form_started OR $6,checkout_error=checkout_error OR $7,tutorial_skipped=tutorial_skipped OR $8 WHERE id=$1`,[event.session,event.stage,userId,event.seconds,['interact','form','tutorial_skip'].includes(event.action),event.action==='form',event.action==='checkout_error',event.action==='tutorial_skip',event.at]);
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  if(Date.now()-cleanupAt>3600000){cleanupAt=Date.now();await pool.query("DELETE FROM smartclass_visits WHERE started_at < NOW()-INTERVAL '90 days'");}
 }
 async function report(days,offset){
  await ensure();
  // Only completed subscription payments in this visit's time window count as paid.
  const cte=`WITH visits AS (SELECT v.*, EXISTS(SELECT 1 FROM smartclass_subscription_payments p WHERE p.user_id::text=v.user_id::text AND p.status='completed' AND p.package IN ('Basic','Standard') AND p.completed_at BETWEEN v.started_at AND v.last_seen+INTERVAL '30 minutes') AS paid,
   v.last_seen < NOW()-INTERVAL '30 minutes' AS ended FROM smartclass_visits v WHERE v.started_at >= NOW()-($1::int*INTERVAL '1 day')) `;
  const [summary,stages,recent,sources,daily,settings]=await Promise.all([
   pool.query(cte+`SELECT COUNT(*)::int AS sessions,COUNT(DISTINCT visitor_id)::int AS visitors,COUNT(*) FILTER(WHERE NOT ended)::int AS active,COUNT(*) FILTER(WHERE ended)::int AS ended,COUNT(*) FILTER(WHERE ended AND NOT interacted AND active_seconds<10 AND (SELECT COUNT(*) FROM jsonb_object_keys(reached))=1)::int AS bounces,COUNT(*) FILTER(WHERE form_started)::int AS forms,COUNT(*) FILTER(WHERE paid)::int AS paid,COUNT(*) FILTER(WHERE checkout_error)::int AS errors,COUNT(*) FILTER(WHERE tutorial_skipped)::int AS skipped,COALESCE(ROUND(AVG(active_seconds)),0)::int AS average_seconds FROM visits`,[days]),
   pool.query(cte+`SELECT s.stage,COUNT(*) FILTER(WHERE v.reached ? s.stage)::int AS reached,COUNT(*) FILTER(WHERE v.ended AND v.last_stage=s.stage AND NOT (v.reached ? 'dashboard'))::int AS stopped FROM visits v CROSS JOIN unnest($2::text[]) AS s(stage) GROUP BY s.stage`,[days,Object.keys(STAGES)]),
   pool.query(cte+`SELECT v.*,u.full_name,u.email FROM visits v LEFT JOIN users u ON u.id=v.user_id ORDER BY v.started_at DESC LIMIT 50 OFFSET $2`,[days,offset]),
   pool.query(cte+`SELECT source,COUNT(*)::int AS sessions FROM visits GROUP BY source ORDER BY sessions DESC LIMIT 10`,[days]),
   pool.query(cte+`SELECT (started_at AT TIME ZONE 'Africa/Johannesburg')::date AS day,COUNT(*)::int AS sessions,COUNT(DISTINCT visitor_id)::int AS visitors FROM visits GROUP BY day ORDER BY day`,[days]),
   pool.query('SELECT enabled_at FROM smartclass_visit_settings WHERE id=1')
  ]);
  return {success:true,days,summary:summary.rows[0],stages:Object.entries(STAGES).map(([stage,label])=>({stage,label,...stages.rows.find(s=>s.stage===stage),reached:stages.rows.find(s=>s.stage===stage)?.reached||0,stopped:stages.rows.find(s=>s.stage===stage)?.stopped||0})),recent:recent.rows,sources:sources.rows,daily:daily.rows,enabledAt:settings.rows[0]?.enabled_at};
 }
 return {record,report};
}
module.exports={STAGES,validate,createStore};
