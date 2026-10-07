const SUBJECTS=new Set(['mathematics','physical-sciences','life-sciences','economics','mathematical-literacy','accounting','business-studies','geography','history','english']);
const failure=(message,status=400)=>Object.assign(new Error(message),{status});
function active(sub){return !!sub&&['active','cancelled'].includes(sub.status)&&new Date(sub.end_date).getTime()>Date.now();}
async function validateSwap(pool,userId,oldSubject,newSubject){
  if(!SUBJECTS.has(oldSubject)||!SUBJECTS.has(newSubject)||oldSubject===newSubject)throw failure('Choose two different supported subjects.');
  const {rows}=await pool.query('SELECT u.subjects, s.status, s.end_date FROM users u JOIN smartclass_subscriptions s ON s.user_id = u.id::text WHERE u.id = $1',[userId]);
  const current=rows[0];if(!active(current))throw failure('An active paid plan is required.',403);
  if(!Array.isArray(current.subjects)||!current.subjects.includes(oldSubject)||current.subjects.includes(newSubject))throw failure('Your subjects have changed. Refresh and choose again.',409);
}
async function changePlan(pool,userId,kind){
 const client=await pool.connect();try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[String(userId)]);
  const {rows}=await client.query('SELECT * FROM smartclass_subscriptions WHERE user_id = $1 FOR UPDATE',[String(userId)]);const sub=rows[0];
  if(!active(sub))throw failure('No current paid plan was found.',404);
  if(kind==='cancel'){
   await client.query("UPDATE smartclass_subscriptions SET status = 'cancelled', updated_at = NOW() WHERE user_id = $1",[String(userId)]);
  }else{
   if(sub.package!=='Standard'||sub.status!=='active')throw failure('Only an active Standard plan can be changed to Basic.');
   const user=await client.query('SELECT subjects FROM users WHERE id = $1 FOR UPDATE',[userId]);
   const subjects=(user.rows[0]?.subjects||[]).slice(0,2);
   await client.query("UPDATE smartclass_subscriptions SET package = 'Basic', amount = 39, subjects = $2::jsonb, updated_at = NOW() WHERE user_id = $1",[String(userId),JSON.stringify(subjects)]);
   await client.query('UPDATE users SET subjects = $2::jsonb, updated_at = NOW() WHERE id = $1',[userId,JSON.stringify(subjects)]);
  }
  await client.query('COMMIT');return{success:true,endDate:new Date(sub.end_date).toISOString()};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function paymentStatus(pool,userId,checkoutId){
 if(typeof checkoutId!=='string'||!/^ch_[A-Za-z0-9_-]+$/.test(checkoutId))throw failure('Invalid checkout reference.');
 const {rows}=await pool.query('SELECT checkout_id, package, status FROM smartclass_subscription_payments WHERE checkout_id = $1 AND user_id = $2',[checkoutId,String(userId)]);
 if(!rows[0])throw failure('Payment not found for this account.',404);
 return{success:true,checkoutId:rows[0].checkout_id,package:rows[0].package,status:rows[0].status};
}
async function saveSubjects(pool,userId,subjects){
 if(!Array.isArray(subjects)||!subjects.length||new Set(subjects).size!==subjects.length||subjects.some(id=>!SUBJECTS.has(id)))throw failure('Choose distinct supported subjects.');
 const client=await pool.connect();try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[String(userId)]);
  const {rows}=await client.query('SELECT * FROM smartclass_subscriptions WHERE user_id = $1 FOR UPDATE',[String(userId)]);const sub=rows[0];
  if(!active(sub))throw failure('Confirm your payment before choosing subjects.',403);
  const cap=sub.package==='Standard'?4:sub.package==='Basic'?2:0;
  if(subjects.length>cap)throw failure('Your plan allows '+cap+' subjects.',403);
  const previous=Array.isArray(sub.subjects)?sub.subjects:[];
  const replaces=previous.length>cap ? subjects.length!==cap||subjects.some(id=>!previous.includes(id)) : previous.some(id=>!subjects.includes(id));
  if(replaces)throw failure('Use Edit Subjects in your profile for a paid subject swap.',409);
  const json=JSON.stringify(subjects);
  const result=await client.query('UPDATE users SET subjects = $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING id, email, subjects',[userId,json]);
  await client.query('UPDATE smartclass_subscriptions SET subjects = $2::jsonb, updated_at = NOW() WHERE user_id = $1',[String(userId),json]);
  await client.query('COMMIT');return{status:'success',user:result.rows[0]};
 }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
}
module.exports={changePlan,validateSwap,paymentStatus,saveSubjects};
