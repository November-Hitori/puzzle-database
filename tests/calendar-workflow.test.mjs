import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'puzarchive-workflow-'));
process.env.PUZARCHIVE_DB_PATH=path.join(tempDir,'test.sqlite');
process.env.PUZARCHIVE_USERS_PATH=path.join(tempDir,'users.json');
process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH=path.join(tempDir,'penpa.md');
fs.writeFileSync(process.env.PUZARCHIVE_USERS_PATH,JSON.stringify([{id:'owner',name:'Owner',accessCode:'isolated-workflow-invite-001'}]));
fs.writeFileSync(process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH,'Test drawing rules: use separate problem and solution layers.');
const {createServer}=await import('../server.mjs');
const db=await import('../db.mjs');

test('four areas, link supplementation, date reservations, three-person audits and ignores work together',async(t)=>{
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.database.close();fs.rmSync(tempDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const cookies={};
  for (const id of ['owner','a','b','c','d']) {
    db.database.prepare(`INSERT INTO trusted_users(id,name,username,username_key,password_hash) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username,username_key=excluded.username_key,password_hash=excluded.password_hash`).run(id,id,id,id,'isolated-test-hash');
    const token=`workflow-test-${id}`;
    db.createSession(createHash('sha256').update(token).digest('hex'),id,Date.now()+60000);
    cookies[id]=`puzarchive_session=${token}`;
  }
  async function request(url,method='GET',body=null,user='owner') {
    const response=await fetch(base+url,{method,headers:{origin:base,'content-type':'application/json',...(user?{cookie:cookies[user]}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  }
  const rule=db.addRule({titleZh:'规则',titleEn:'Rule',rulesZh:['说明'],rulesEn:[],category:'其它',isVariant:false,baseRuleId:null,exampleUrl:'https://penpa-edit.com/?m=edit&p=example',exampleAuthor:''},'owner');
  for (const item of ['name','description','example']) for (const user of ['a','b','c']) assert.ok(db.submitRuleAudit(rule.id,item,'approve','',1,user).rule);
  const puzz='https://puzz.link/p?slither/3/3/000';
  const create=await request('/api/calendar/puzzles','POST',{title:'New',source:'puzz.link',ruleId:rule.id,inputMode:'external',puzzlinkUrl:puzz,suggestedDate:'2028-02-29'});
  assert.equal(create.status,201);
  const number=create.body.puzzle.number;
  const url=`/api/calendar/puzzles/${number}`;
  assert.equal(create.body.puzzle.calendarArea,'review');
  assert.equal(create.body.puzzle.assignedDate,null);
  assert.equal(create.body.puzzle.penpaSolveUrl,'');
  assert.equal((await request(`${url}/assignment`,'POST',{assignedDate:'2028-02-29',expectedEditVersion:1,expectedReviewRound:1})).status,409);
  for (const [user,vote] of [['a',2],['b',1],['c',0]]) assert.equal((await request(`${url}/complete-rating`,'POST',{difficulty:3,tags:[],vote,expectedReviewRound:1},user)).status,200);
  let latest=(await request(url)).body.puzzle;
  assert.equal(latest.calendarArea,'allocation');
  assert.equal(latest.quality.errors.filter(e=>!e.ignored).length,2);
  const inbox=(await request('/api/inbox')).body.notifications;
  const linkNotice=inbox.find(item=>item.type==='calendar-links-required');
  assert.ok(linkNotice);assert.match(linkNotice.body,/Penpa 编辑链接和Penpa 解题链接/);
  const auditInput=(puzzle,decision='approve')=>({decision,revision:puzzle.quality.penpa.revision,guidelinesRevision:puzzle.quality.penpa.guidelinesRevision});
  assert.equal((await request(`${url}/penpa-audits`,'POST',auditInput(latest),'a')).status,400);
  // An ignored link error still needs audits and a date; restoring it blocks completion.
  for (const error of latest.quality.errors) assert.equal((await request(`${url}/error-ignores`,'POST',{key:error.key,revision:error.revision,ignored:true,reason:'accepted exception'})).status,200);
  latest=(await request(url)).body.puzzle;
  assert.ok(latest.quality.errors.every(e=>e.ignored));assert.equal(latest.calendarArea,'allocation');
  for (const user of ['a','a','b','c']) assert.equal((await request(`${url}/penpa-audits`,'POST',auditInput(latest),user)).status,200);
  latest=(await request(url)).body.puzzle;
  assert.equal(latest.quality.penpa.approvalCount,3);assert.equal(latest.calendarArea,'allocation');
  const assigned=await request(`${url}/assignment`,'POST',{assignedDate:'2028-02-29',expectedEditVersion:latest.editVersion,expectedReviewRound:latest.reviewRound},'d');
  assert.equal(assigned.status,200);assert.equal(assigned.body.puzzle.calendarArea,'finished');
  latest=assigned.body.puzzle;
  const restored=await request(`${url}/error-ignores`,'POST',{key:latest.quality.errors[0].key,revision:latest.quality.errors[0].revision,ignored:false});
  assert.equal(restored.body.puzzle.calendarArea,'allocation');
  // Filling the independent URLs resets only the drawing audit; voting and solving records remain.
  latest=restored.body.puzzle;
  const fill=await request(url,'PATCH',{penpaEditUrl:'https://penpa-edit.com/?m=edit&p=diagram',penpaSolveUrl:'https://penpa-edit.com/?m=solve&p=diagram',puzzlinkUrl:'',expectedEditVersion:latest.editVersion,expectedReviewRound:latest.reviewRound});
  assert.equal(fill.status,200);assert.equal(fill.body.puzzle.userVote,null);assert.equal(fill.body.puzzle.review.totalScore,3);
  assert.equal(fill.body.puzzle.penpaRevision,2);assert.equal(fill.body.puzzle.quality.penpa.approvalCount,0);
  assert.equal(fill.body.puzzle.quality.errors.length,0);
  latest=fill.body.puzzle;
  for (const user of ['a','b','c']) assert.equal((await request(`${url}/penpa-audits`,'POST',auditInput(latest),user)).status,200);
  latest=(await request(url)).body.puzzle;assert.equal(latest.calendarArea,'finished');
  // A second puzzle cannot reserve an occupied date, including concurrent attempts.
  const second=await request('/api/calendar/puzzles','POST',{title:'Second',source:'puzz.link',ruleId:rule.id,inputMode:'external',puzzlinkUrl:puzz});
  const secondUrl=`/api/calendar/puzzles/${second.body.puzzle.number}`;
  for (const [user,vote] of [['a',2],['b',1],['c',0]]) await request(`${secondUrl}/complete-rating`,'POST',{difficulty:3,tags:[],vote,expectedReviewRound:1},user);
  const secondLatest=(await request(secondUrl)).body.puzzle;
  assert.equal((await request(`${secondUrl}/assignment`,'POST',{assignedDate:'2028-02-29',expectedEditVersion:secondLatest.editVersion,expectedReviewRound:1})).status,409);
  assert.equal((await request(`${url}/assignment`,'POST',{assignedDate:'2028-02-30',expectedEditVersion:latest.editVersion,expectedReviewRound:1})).status,400);
  const cancelled=await request(`${url}/assignment`,'POST',{assignedDate:null,expectedEditVersion:latest.editVersion,expectedReviewRound:1});
  assert.equal(cancelled.body.puzzle.calendarArea,'allocation');assert.equal(cancelled.body.puzzle.quality.penpa.approvalCount,3);
  const race=await Promise.all([url,secondUrl].map((endpoint,index)=>request(`${endpoint}/assignment`,'POST',{assignedDate:'2028-03-01',expectedEditVersion:index?secondLatest.editVersion:cancelled.body.puzzle.editVersion,expectedReviewRound:1})));
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
  // Changing the guidelines invalidates approvals from the old specification.
  fs.writeFileSync(process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH,'Updated drawing rules.');
  latest=(await request(url)).body.puzzle;assert.equal(latest.calendarArea,'allocation');assert.equal(latest.quality.penpa.approvalCount,0);
  assert.equal((await request(`${url}/penpa-audits`,'POST',auditInput(fill.body.puzzle),'a')).status,409);
  const rejected=await request(`${url}/penpa-audits`,'POST',{...auditInput(latest,'reject'),suggestion:'Wrong grid'},'d');
  assert.equal(rejected.status,200);
  assert.equal((await request(`${url}/penpa-audits`,'POST',auditInput(latest),'a')).status,409);
  latest=(await request(url)).body.puzzle;
  const reserved=await request(`${url}/assignment`,'POST',{assignedDate:'2028-03-03',expectedEditVersion:latest.editVersion,expectedReviewRound:1});
  assert.equal(reserved.status,200);
  const withdrawn=await request(`${url}/complete-rating`,'POST',{difficulty:3,tags:[],vote:-2,expectedReviewRound:1});
  assert.equal(withdrawn.body.puzzle.calendarArea,'allocation');assert.equal(withdrawn.body.puzzle.assignedDate,'2028-03-03');
  const secondWithdrawal=await request(`${url}/complete-rating`,'POST',{difficulty:3,tags:[],vote:-2,expectedReviewRound:1},'a');
  assert.equal(secondWithdrawal.body.puzzle.calendarArea,'review');assert.equal(secondWithdrawal.body.puzzle.assignedDate,null);
  const supportedAgain=await request(`${url}/complete-rating`,'POST',{difficulty:3,tags:[],vote:2,expectedReviewRound:1});
  assert.equal(supportedAgain.body.puzzle.calendarArea,'allocation');
  const veto=await request(`${url}/complete-rating`,'POST',{difficulty:3,tags:[],vote:'veto',expectedReviewRound:1},'d');
  assert.equal(veto.body.puzzle.calendarArea,'leftover');assert.equal(veto.body.puzzle.assignedDate,null);
  assert.equal((await request(`${url}/reenter`,'POST',{expectedReviewRound:1})).body.puzzle.calendarArea,'review');
  assert.equal((await request(`${url}/error-ignores`,'POST',{key:'forged',revision:1,ignored:true})).status,409);
  assert.equal((await request(`${url}/assignment`,'POST',{assignedDate:null,expectedEditVersion:1,expectedReviewRound:1},null)).status,401);
  // Rule errors may be ignored, but all three audit groups still require three accounts.
  const draft=db.addRule({titleZh:'草稿',titleEn:'',rulesZh:[],rulesEn:[],category:'其它',isVariant:false,baseRuleId:null,exampleUrl:'',exampleAuthor:''},'owner');
  assert.equal(db.submitRuleAudit(draft.id,'name','approve','',1,'a').error,'incomplete');
  for (const error of draft.quality.errors) assert.ok(db.setQualityErrorIgnored('rule',draft.id,'owner',{key:error.key,revision:error.revision,ignored:true,reason:'draft exception'}).rule);
  for (const item of ['name','description','example']) for (const user of ['a','b','c']) assert.ok(db.submitRuleAudit(draft.id,item,'approve','',1,user).rule);
  assert.equal(db.getRule(draft.id).quality.warnings.length,0);
  const approvedDraft=db.getRule(draft.id);
  const edited=db.updateRule(draft.id,{...approvedDraft,titleZh:'新名字'},'owner',{...approvedDraft.revisions,expectedEditVersion:approvedDraft.editVersion});
  assert.equal(edited.rule.quality.errors.find(e=>e.code==='missingEnName').ignored,false);
  const reject=db.submitRuleAudit(draft.id,'description','reject','Need rewrite',1,'d');
  const rejection=reject.rule.quality.errors.find(e=>e.code==='auditRejected');
  assert.ok(db.setQualityErrorIgnored('rule',draft.id,'owner',{key:rejection.key,revision:rejection.revision,ignored:true}).rule);
  assert.ok(db.submitRuleAudit(draft.id,'description','approve','',1,'d').rule);
  // Deleting entities removes current ignores but retains ignore history.
  const deleteSecond=await request(secondUrl,'DELETE',{deleteToken:second.body.puzzle.deleteToken});assert.equal(deleteSecond.status,200);
  assert.ok(db.database.prepare('SELECT COUNT(*) AS count FROM quality_error_ignore_events').get().count>0);
});
