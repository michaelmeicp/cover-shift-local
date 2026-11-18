import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';

async function open(t,dbPath=':memory:'){
  const {server,db}=createApp({dbPath,seed:false});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let done=false;
  async function close(){if(!done){done=true;await new Promise(resolve=>server.close(resolve));db.close();}} 
  t.after(close);
  async function req(path,method='GET',body,cookie=''){
    const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/'+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});
    return {s:r.status,b:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(persona){const r=await req('login','POST',{persona});assert.ok(r.cookie);return (p,m,b)=>req(p,m,b,r.cookie);}
  return {close,req,login};
}
const shift={location:'示範東廳',start:'2037-08-01T23:00',end:'2037-08-02T01:30',timezone:'Asia/Macau',task:'盤點展品',skills:[]};
const ok=r=>{assert.ok(r.s>=200&&r.s<300,JSON.stringify(r));return r.b;};
const bad=r=>assert.ok(r.s>=400&&r.s<500,JSON.stringify(r));
async function post(m,fields={}){const b=ok(await m('shifts','POST',{...shift,...fields}));return b.shifts.find(x=>x.location===(fields.location??shift.location)).id;}
const apply=(w,id)=>w('shifts/'+id+'/apply','POST',{});
async function decision(m,id,workerId,verb='confirm'){
  const state=ok(await m('state'));const c=state.shifts.find(s=>s.id===id).candidates.find(x=>x.workerId===workerId);
  assert.ok(c);return m('shifts/'+id+'/candidates/'+c.id+'/'+verb,'POST',{});
}

test('access boundaries, voluntary application, withdrawal and candidate privacy',async t=>{
 const a=await open(t),m=await a.login('manager'),w=await a.login('worker1'),v=await a.login('worker2'); 
 bad(await a.req('shifts','POST',shift));bad(await w('shifts','POST',{...shift,role:'manager'}));const id=await post(m);
 ok(await apply(w,id));bad(await apply(w,id));
 const cand=ok(await m('state')).shifts.find(s=>s.id===id).candidates;assert.equal(cand.length,1);
 const vs=ok(await v('state'));assert.ok(!vs.shifts.find(s=>s.id===id).candidates);assert.ok(!vs.shifts.find(s=>s.id===id).application);
 bad(await v('shifts/'+id+'/withdraw','POST',{workerId:cand[0].workerId}));bad(await w('shifts/'+id+'/candidates/'+cand[0].id+'/confirm','POST',{}));bad(await w('shifts/'+id,'PATCH',shift));
 ok(await w('shifts/'+id+'/withdraw','POST',{}));bad(await w('shifts/'+id+'/withdraw','POST',{}));ok(await apply(w,id));
 ok(await decision(m,id,cand[0].workerId,'decline'));assert.equal(ok(await w('state')).shifts.find(s=>s.id===id).application.status,'declined');
});

test('concurrent confirmation selects exactly one worker; edits locked after selection',async t=>{
 const a=await open(t),m=await a.login('manager'),w=await a.login('worker1'),v=await a.login('worker2');const id=await post(m);ok(await apply(w,id));ok(await apply(v,id));
 const dest='shifts/'+id+'/candidates/';const cs=ok(await m('state')).shifts.find(s=>s.id===id).candidates;
 const rs=await Promise.all(cs.map(c=>m(dest+c.id+'/confirm','POST',{})));assert.equal(rs.filter(r=>r.s<300).length,1);assert.equal(rs.filter(r=>r.s===409).length,1);
 const s=ok(await m('state')).shifts.find(s=>s.id===id);assert.equal(s.status,'filled');assert.equal(s.candidates.filter(c=>c.status==='confirmed').length,1);
 bad(await m('shifts/'+id,'PATCH',{...shift,task:'事後修改'}));
});

test('actual instants, cross-midnight duration, adjacent endpoint, cancellation and audit',async t=>{
 const a=await open(t),m=await a.login('manager'),w=await a.login('worker1');const uid=ok(await w('state')).user.id;
 const x=await post(m),y=await post(m,{location:'西廳',timezone:'UTC',start:'2037-08-01T17:00',end:'2037-08-01T17:30'}),z=await post(m,{location:'南廳',start:'2037-08-02T01:30',end:'2037-08-02T02:30'});
 for(const id of [x,y,z])ok(await apply(w,id));ok(await decision(m,x,uid));
 const state=ok(await m('state'));assert.equal(state.shifts.find(s=>s.id===x).duration,150);assert.ok(state.shifts.find(s=>s.id===y).candidates[0].conflict);
 bad(await decision(m,y,uid));ok(await decision(m,z,uid));
 bad(await m('shifts/'+x+'/cancel','POST',{reason:''}));ok(await m('shifts/'+x+'/cancel','POST',{reason:'展廳暫停開放'}));
 ok(await decision(m,y,uid));const after=ok(await m('state'));assert.equal(after.shifts.find(s=>s.id===x).cancelReason,'展廳暫停開放');assert.ok(after.audit.some(e=>e.shiftId===x&&e.actor&&e.time&&e.action));assert.ok(ok(await w('state')).notifications.length);
});

test('database survives clean server restart',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cover-shift-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const p=join(dir,'qa.db');
 let a=await open(t,p),m=await a.login('manager');const id=await post(m);await a.close();
 a=await open(t,p);m=await a.login('manager');assert.equal(ok(await m('state')).shifts.find(s=>s.id===id).location,shift.location);
});

test('editing terms requires fresh worker opt-in; mismatch advisory and old decision rejected',async t=>{
 const a=await open(t),m=await a.login('manager'),w=await a.login('worker1');
 const id=await post(m);ok(await apply(w,id));
 const stale=ok(await m('state')).shifts[0].candidates[0];
 const updated={...shift,skills:['一般示範技能'],task:'更新任務'};
 ok(await m('shifts/'+id,'PATCH',updated));bad(await m('shifts/'+id+'/candidates/'+stale.id+'/confirm','POST',{}));
 const state=ok(await w('state'));assert.equal(state.shifts[0].application.status,'withdrawn');assert.ok(state.notifications.some(n=>n.message.includes('重新')));
 ok(await apply(w,id));ok(await m('shifts/'+id,'PATCH',updated));
 const current=ok(await m('state')).shifts[0].candidates[0];assert.deepEqual(current.mismatch,updated.skills);ok(await decision(m,id,current.workerId));
});

test('reject unsupported zone, impossible day, inverted dates and malformed session',async t=>{
 const a=await open(t),m=await a.login('manager');
 for(const fields of [{timezone:'local'},{start:'2037-02-30T09:00'},{end:shift.start},{end:'2037-08-01T18:30'}]){
   bad(await m('shifts','POST',{...shift,...fields}));
 }
 bad(await a.req('shifts','POST',shift,'cover_session=fake'));
 assert.equal(ok(await m('state')).shifts.length,0);
});

test('two managers racing on different overlapping shifts cannot double-book one worker',async t=>{
 const a=await open(t),m=await a.login('manager'),m2=await a.login('manager'),w=await a.login('worker2');
 const x=await post(m),y=await post(m,{location:'展廳二'});for(const id of [x,y])ok(await apply(w,id));
 const run=(manager,s)=>manager('shifts/'+s.id+'/candidates/'+s.candidates[0].id+'/confirm','POST',{});
 const [s1,s2]=ok(await m('state')).shifts;
 const rs=await Promise.all([run(m,s1),run(m2,s2)]);assert.equal(rs.filter(r=>r.s<300).length,1);assert.equal(rs.filter(r=>r.s===409).length,1);
});
