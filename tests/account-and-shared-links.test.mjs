import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'puzarchive-account-links-'));
process.env.PUZARCHIVE_DB_PATH=path.join(directory,'fixture.sqlite');
process.env.PUZARCHIVE_USERS_PATH=path.join(directory,'members.json');
const code='only-an-isolated-fixture-invitation';
fs.writeFileSync(process.env.PUZARCHIVE_USERS_PATH,JSON.stringify([{id:'fixture-owner',name:'Trusted Member',accessCode:code}]));
const {createServer}=await import('../server.mjs');
const {database}=await import('../db.mjs');

test('rename preserves identity and history; any member can change Penpa links only in allocation',async(t)=>{
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));database.close();fs.rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(route,method='GET',body=null,cookie='',origin=base) {
    const response=await fetch(base+route,{method,headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]||cookie};
  }
  const password='isolated-account-test-password';
  const members=[];
  for(const username of ['Owner','Helper','Third']) {
    const registration=await request('/api/register','POST',{username,password,inviteCode:code});assert.equal(registration.status,201);
    members.push({username,...registration});
  }
  const [owner,helper,third]=members;
  const rule=await request('/api/rules','POST',{titleZh:'账号与链接测试规则',titleEn:'Account and Link Rule',category:'其它',rulesZh:['测试'],exampleUrl:'https://penpa-edit.com/?m=solve&p=rule-example'},owner.cookie);
  const input={title:'Pzplus 投稿',source:'pzplus',inputMode:'external',ruleId:rule.body.rule.id,puzzlinkUrl:'https://pzplus.tck.mn/p.html?slither/3/3/000'};
  const submitted=await request('/api/calendar/puzzles','POST',input,owner.cookie);assert.equal(submitted.status,201);
  const number=submitted.body.puzzle.number,route=`/api/calendar/puzzles/${number}`;
  const penpa={penpaEditUrl:'https://penpa-edit.com/?m=edit&p=shared',penpaSolveUrl:'https://penpa-edit.com/?m=solve&p=shared',expectedEditVersion:submitted.body.puzzle.editVersion,expectedReviewRound:1};
  assert.equal((await request(route+'/penpa-links','PATCH',penpa)).status,401);
  assert.equal((await request(route+'/penpa-links','PATCH',penpa,helper.cookie)).status,409);
  for(const member of members) assert.equal((await request(route+'/complete-rating','POST',{difficulty:3,tags:[],vote:'support',expectedReviewRound:1},member.cookie)).status,200);
  const approved=(await request(route,'GET',null,helper.cookie)).body.puzzle;assert.equal(approved.calendarArea,'allocation');
  const payload={...penpa,expectedEditVersion:approved.editVersion};
  assert.equal((await request(route+'/penpa-links','PATCH',{...payload,title:'forged'},helper.cookie)).status,400);
  assert.equal((await request(route+'/penpa-links','PATCH',{...payload,clearReviews:true},helper.cookie)).status,400);
  assert.equal((await request(route+'/penpa-links','PATCH',{...payload,puzzlinkUrl:'https://puzz.link/p?slither/2/2/'},helper.cookie)).status,400);
  assert.equal((await request(route+'/penpa-links','PATCH',{...payload,penpaEditUrl:penpa.penpaSolveUrl},helper.cookie)).status,400);
  const changed=await request(route+'/penpa-links','PATCH',payload,helper.cookie);assert.equal(changed.status,200);
  assert.equal(changed.body.puzzle.penpaRevision,approved.penpaRevision+1);
  assert.equal(changed.body.puzzle.submittedBy.id,owner.body.user.id);
  assert.equal(changed.body.puzzle.title,input.title);assert.equal(changed.body.puzzle.puzzlinkUrl,input.puzzlinkUrl);
  assert.equal(changed.body.puzzle.review.support,3);assert.equal(changed.body.puzzle.votes,3);
  assert.equal((await request(route+'/penpa-links','PATCH',payload,third.cookie)).status,409);
  assert.equal((await request(route,'PATCH',{title:'not owner',expectedEditVersion:changed.body.puzzle.editVersion,expectedReviewRound:1},helper.cookie)).status,403);
  const assigned=await request(route+'/assignment','POST',{assignedDate:'2028-03-01',expectedEditVersion:changed.body.puzzle.editVersion,expectedReviewRound:1},helper.cookie);assert.equal(assigned.status,200);
  let revision=(await request(route,'GET',null,helper.cookie)).body.puzzle;
  assert.equal((await request(route+'/penpa-audits','POST',{decision:'approve',revision:revision.penpaRevision,guidelinesRevision:revision.quality.penpa.guidelinesRevision},owner.cookie)).status,200);
  revision=(await request(route,'GET',null,helper.cookie)).body.puzzle;
  const amended=await request(route+'/penpa-links','PATCH',{penpaSolveUrl:'https://penpa-edit.com/?m=solve&p=shared-revised',expectedEditVersion:revision.editVersion,expectedReviewRound:1},third.cookie);
  assert.equal(amended.status,200);assert.equal(amended.body.puzzle.assignedDate,'2028-03-01');
  assert.equal(amended.body.puzzle.quality.penpa.approvalCount,0);assert.equal(amended.body.puzzle.quality.penpa.history.length,1);
  assert.equal(amended.body.puzzle.review.support,3);assert.equal(amended.body.puzzle.penpaEditUrl,penpa.penpaEditUrl);
  for (const item of ['name','description','example']) for (const member of members) {
    assert.equal((await request(`/api/rules/${rule.body.rule.id}/audits`,'POST',{item,decision:'approve',revision:1},member.cookie)).status,200);
  }
  for (const member of members) assert.equal((await request(route+'/penpa-audits','POST',{decision:'approve',revision:amended.body.puzzle.penpaRevision,guidelinesRevision:amended.body.puzzle.quality.penpa.guidelinesRevision},member.cookie)).status,200);
  const finished=(await request(route,'GET',null,helper.cookie)).body.puzzle;assert.equal(finished.calendarArea,'finished');
  assert.equal((await request(route+'/penpa-links','PATCH',{...payload,expectedEditVersion:finished.editVersion},helper.cookie)).status,409);
  const id=owner.body.user.id;
  const credentialsBefore=database.prepare('SELECT password_hash,is_active FROM trusted_users WHERE id=?').get(id);
  const completionsBefore=database.prepare('SELECT * FROM puzzle_completions WHERE user_id=?').all(id);
  const evaluationsBefore=database.prepare('SELECT * FROM calendar_evaluations WHERE user_id=?').all(id);
  assert.equal((await request('/api/account/username','PATCH',{username:'NewOwner',expectedUsername:'Owner'})).status,401);
  assert.equal((await request('/api/account/username','PATCH',{username:'NewOwner',expectedUsername:'Owner'},owner.cookie,'https://other.example')).status,403);
  assert.equal((await request('/api/account/username','PATCH',{username:'ＨＥＬＰＥＲ',expectedUsername:'Owner'},owner.cookie)).status,409);
  assert.equal((await request('/api/account/username','PATCH',{username:'<script>',expectedUsername:'Owner'},owner.cookie)).status,400);
  assert.equal((await request('/api/account/username','PATCH',{username:'NewOwner',expectedUsername:'Owner',userId:helper.body.user.id},owner.cookie)).status,400);
  const renamed=await request('/api/account/username','PATCH',{username:'ＮｅｗＯｗｎｅｒ',expectedUsername:'Owner'},owner.cookie);
  assert.equal(renamed.status,200);assert.deepEqual(renamed.body.user,{id,name:'NewOwner',username:'NewOwner'});
  assert.deepEqual(database.prepare('SELECT password_hash,is_active FROM trusted_users WHERE id=?').get(id),credentialsBefore);
  assert.deepEqual(database.prepare('SELECT * FROM puzzle_completions WHERE user_id=?').all(id),completionsBefore);
  assert.deepEqual(database.prepare('SELECT * FROM calendar_evaluations WHERE user_id=?').all(id),evaluationsBefore);
  assert.equal((await request('/api/session','GET',null,owner.cookie)).body.user.username,'NewOwner');
  assert.equal((await request('/api/account/username','PATCH',{username:'AnotherOwner',expectedUsername:'Owner'},owner.cookie)).status,409);
  assert.equal((await request('/api/session','POST',{username:'Owner',password})).status,401);
  const login=await request('/api/session','POST',{username:'newowner',password});assert.equal(login.status,200);assert.equal(login.body.user.id,id);
  const latest=(await request(route,'GET',null,helper.cookie)).body.puzzle;
  assert.equal(latest.submittedBy.username,'NewOwner');
  assert.ok(latest.review.participants.support.some(p=>p.username==='NewOwner'));
  const fork=await request('/api/calendar/puzzles','POST',{...input,title:'Pzprxs 投稿',puzzlinkUrl:'https://pzprxs.vercel.app/p?slither/3/3/000'},helper.cookie);assert.equal(fork.status,201);
  assert.equal(fork.body.puzzle.puzzlinkUrl,'https://pzprxs.vercel.app/p?slither/3/3/000');
  assert.equal((await request('/api/calendar/puzzles','POST',{...input,puzzlinkUrl:'https://pzplus.tck.mn.evil.example/p.html?slither/3/3/000'},helper.cookie)).status,400);
});
