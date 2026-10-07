const test=require('node:test'),assert=require('node:assert/strict');const {saveSubjects}=require('../services/profile-actions');
function db(previous=[],pkg='Basic',status='active') {
 const sub={subjects:previous,package:pkg,status,end_date:'2099-01-01'},calls=[];
 return {calls,connect:async()=>({
  release(){},
  query:async(sql,args)=>{calls.push({sql,args});if(sql.startsWith('SELECT *'))return{rows:[sub]};return{rows:[]};}
 })};
}
test('initial selection and filling upgraded slots are allowed',async()=>{await saveSubjects(db(),'u',['mathematics','english']);await saveSubjects(db(['mathematics','english'],'Standard'),'u',['mathematics','english','history','geography']);});
test('direct replacement or removal cannot bypass paid swaps',async()=>{for(const subjects of [['history','english'],['english']])await assert.rejects(saveSubjects(db(['mathematics','english']),'u',subjects),{status:409});});
test('duplicates, unsupported subjects, plan limits and inactive access are rejected',async()=>{for(const subjects of [['mathematics','mathematics'],['unknown'],['mathematics','english','history']])await assert.rejects(saveSubjects(db(),'u',subjects));await assert.rejects(saveSubjects(db([],'Basic','expired'),'u',['mathematics']),{status:403});});
test('reducing existing subjects to a smaller paid plan retains only selected existing subjects',async()=>{await saveSubjects(db(['mathematics','english','history','geography']),'u',['english','history']);await assert.rejects(saveSubjects(db(['mathematics','english','history','geography']),'u',['english','accounting']),{status:409});});
