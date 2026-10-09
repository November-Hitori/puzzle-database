import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const alice='reviewer-z',bea='reviewer-a',inactive='reviewer-m',legacy='reviewer-legacy',eve='reviewer-e';
const people={
  [alice]:{name:'Alice',username:'alice'},[bea]:{name:'Bea',username:'bea'},
  [inactive]:{name:'Inactive',username:'inactive'},[legacy]:{name:'Legacy',username:null},[eve]:{name:'Eve',username:'eve'}
};
const ruleInput=(title,extra={})=>({titleZh:title,titleEn:`${title} English`,rulesZh:['中文说明'],rulesEn:['English description'],
  category:'其它',isVariant:false,baseRuleId:null,exampleUrl:'https://penpa-edit.com/?m=edit&p=fixture',exampleAuthor:'Fixture author',...extra});

async function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'puzarchive-rule-query-'));
  const previousDb=process.env.PUZARCHIVE_DB_PATH;
  const previousGuidelines=process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH;
  let api;
  t.after(()=>{
    api?.database.close();fs.rmSync(directory,{recursive:true,force:true});
    if (previousGuidelines===undefined) delete process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH;
    else process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH=previousGuidelines;
  });
  try {
    process.env.PUZARCHIVE_DB_PATH=path.join(directory,'synthetic.sqlite');
    process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH=path.join(directory,'penpa.md');
    fs.writeFileSync(process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH,'Synthetic drawing guideline: keep problem and solution layers separate.');
    const url=new URL('../db.mjs',import.meta.url);
    url.searchParams.set('fixture',path.basename(directory));
    api=await import(url.href);
  } finally {
    if (previousDb===undefined) delete process.env.PUZARCHIVE_DB_PATH;
    else process.env.PUZARCHIVE_DB_PATH=previousDb;
  }
  const insert=api.database.prepare('INSERT INTO trusted_users(id,name,username,username_key,password_hash) VALUES(?,?,?,?,?)');
  for (const [id,person] of Object.entries(people)) insert.run(id,person.name,person.username,person.username,person.username?'synthetic-password-hash':null);
  return api;
}

function edit(api,rule,patch,user=alice) {
  const result=api.updateRule(rule.id,patch,user,{...rule.revisions,expectedEditVersion:rule.editVersion});
  assert.equal(result.changed,true);
  return result.rule;
}

function audit(api,rule,item,decision,user,suggestion='') {
  const result=api.submitRuleAudit(rule.id,item,decision,suggestion,rule.revisions[item],user);
  assert.equal(result.error,undefined);
  return result.rule;
}

function assertRuleList(api,user) {
  const rules=api.getRules(user);
  const ids=api.database.prepare('SELECT id FROM rules ORDER BY id').all().map((row)=>row.id);
  // Compare the serialized API response; sqlite rows themselves have null prototypes.
  const response=(value)=>JSON.parse(JSON.stringify(value));
  assert.deepEqual(response(rules),response(ids.map((id)=>api.getRule(id,user))));
  return rules;
}

test('batched rule reads preserve per-rule quality, ordering and user context after writes',async(t)=>{
  const api=await fixture(t);
  assert.deepEqual(api.getRules(alice),[]);
  let base=api.addRule(ruleInput('主规则'),alice);
  const variant=api.addRule(ruleInput('变体',{isVariant:true,baseRuleId:base.id}),bea);
  const draft=api.addRule(ruleInput('草稿',{titleEn:'',rulesZh:[],exampleUrl:''}),null);
  const draftNameError=draft.quality.errors.find((error)=>error.code==='missingEnName');
  assert.equal(api.setQualityErrorIgnored('rule',draft.id,alice,{key:draftNameError.key,revision:draftNameError.revision,ignored:true,reason:'Draft exception'}).error,undefined);
  audit(api,base,'name','reject',alice,'旧名称建议');
  audit(api,variant,'description','approve',bea);
  base=edit(api,base,{titleZh:'修订主规则'},bea);
  audit(api,base,'name','approve',bea);
  audit(api,variant,'name','reject',bea,'变体名称建议');
  audit(api,base,'name','approve',alice);
  audit(api,base,'name','approve',legacy);
  audit(api,base,'name','reject',inactive,'保留的拒绝建议');
  for (const user of [alice,bea,eve]) audit(api,base,'description','approve',user);
  base=edit(api,base,{exampleAuthor:'Updated author'});
  audit(api,base,'example','approve',alice);
  api.database.prepare('UPDATE trusted_users SET is_active=0 WHERE id=?').run(inactive);
  api.database.exec("UPDATE rule_item_votes SET created_at='2026-01-01T00:00:00Z'; UPDATE rule_item_audit_events SET created_at=printf('2026-01-%02dT00:00:00Z',30-id)");
  api.database.prepare("UPDATE rule_item_revisions SET content_json=? WHERE rule_id=? AND item='example' AND revision=1")
    .run(JSON.stringify({exampleUrl:base.exampleUrl}),base.id);

  for (const user of [alice,bea,inactive,legacy,eve,null]) assertRuleList(api,user);
  const prepare=api.database.prepare;
  let reads=0;
  api.database.prepare=function(...args) {reads++;return prepare.apply(this,args);};
  try {api.getRules(alice);} finally {api.database.prepare=prepare;}
  assert.ok(reads<=5,'rule quality must be fetched in bulk rather than once per rule');
  const snapshot=api.getRules(alice);
  const current=snapshot.find((rule)=>rule.id===base.id);
  const name=current.quality.groups.name;
  assert.equal(name.status,'rejected');
  assert.equal(name.approvalCount,2);
  assert.equal(name.rejectionSuggestion,'保留的拒绝建议');
  assert.deepEqual(name.currentReviews.map((review)=>[review.userId,review.active]),[[bea,true],[legacy,false],[inactive,false],[alice,true]]);
  assert.deepEqual(name.history.map((review)=>[review.revision,review.userId,review.decision]),
    [[1,alice,'reject'],[2,bea,'approve'],[2,alice,'approve'],[2,legacy,'approve'],[2,inactive,'reject']]);
  assert.deepEqual(name.revisions.map((revision)=>revision.revision),[1,2]);
  assert.equal(name.revisions[1].changedBy.userId,bea);
  assert.equal(current.quality.groups.description.status,'approved');
  assert.equal(current.quality.groups.example.revisions[0].content.exampleAuthor,'');
  assert.equal(current.quality.groups.example.revisions[1].content.exampleAuthor,'Updated author');
  assert.equal(snapshot.find((rule)=>rule.id===variant.id).baseRuleTitleZh,'修订主规则');
  assert.equal(snapshot.find((rule)=>rule.id===draft.id).quality.groups.example.status,'incomplete');
  assert.equal(snapshot.find((rule)=>rule.id===draft.id).quality.errors.find((error)=>error.code==='missingEnName').ignored,true);
  assert.equal(api.getRules(eve).find((rule)=>rule.id===base.id).quality.groups.name.reviewedByCurrentUser,false);
  assert.equal(api.getRules(alice).find((rule)=>rule.id===base.id).quality.groups.name.reviewedByCurrentUser,true);
  assert.equal(api.submitRuleAudit(base.id,'name','approve','',2,inactive).error,'sticky');
  const rejection={key:'auditRejected:name',revision:2};
  base=api.setQualityErrorIgnored('rule',base.id,bea,{...rejection,ignored:true,reason:'Accepted rejection exception'}).rule;
  const ignoredBase=assertRuleList(api,alice).find((rule)=>rule.id===base.id);
  assert.equal(ignoredBase.quality.groups.name.status,'pending');
  assert.equal(ignoredBase.quality.errors.find((error)=>error.code==='auditRejected').ignored,true);
  assert.equal(ignoredBase.errorIgnores[0].reason,'Accepted rejection exception');
  base=api.setQualityErrorIgnored('rule',base.id,alice,{...rejection,ignored:false}).rule;
  assert.equal(assertRuleList(api,alice).find((rule)=>rule.id===base.id).quality.groups.name.status,'rejected');

  api.database.prepare('UPDATE trusted_users SET is_active=0 WHERE id=?').run(bea);
  const deactivated=assertRuleList(api,alice).find((rule)=>rule.id===base.id);
  assert.equal(deactivated.quality.groups.description.approvalCount,2);
  assert.equal(deactivated.quality.groups.description.status,'pending');
  assert.equal(current.quality.groups.description.status,'approved');
  base=edit(api,base,{titleZh:'再修订主规则'});
  const reset=assertRuleList(api,alice).find((rule)=>rule.id===base.id).quality.groups.name;
  assert.equal(reset.revision,3);
  assert.equal(reset.status,'pending');
  assert.deepEqual(reset.currentReviews,[]);
  assert.equal(reset.reviewedByCurrentUser,false);
  audit(api,base,'name','approve',alice);
  const after=assertRuleList(api,alice).find((rule)=>rule.id===base.id).quality.groups.name;
  assert.equal(after.approvalCount,1);
  assert.equal(after.reviewedByCurrentUser,true);
  assert.equal(after.history.length,6);
  assert.equal(assertRuleList(api,bea).find((rule)=>rule.id===base.id).quality.groups.name.reviewedByCurrentUser,false);
});

test('calendar lists reuse shared rules within a read and refresh rules and participant history on subsequent reads',async(t)=>{
  const api=await fixture(t);
  let rule=api.addRule(ruleInput('共享规则'),alice);
  audit(api,rule,'name','approve',alice);
  audit(api,rule,'description','reject',bea,'Drawing description exception');
  rule=api.setQualityErrorIgnored('rule',rule.id,alice,{key:'auditRejected:description',revision:1,ignored:true}).rule;
  const input={title:'First',author:'Fixture',source:'Fixture',inputMode:'external',ruleId:rule.id,suggestedDate:null,
    penpaEditUrl:'https://penpa-edit.com/?m=edit&p=fixture',penpaSolveUrl:'https://penpa-edit.com/?m=solve&p=fixture',puzzlinkUrl:''};
  const first=api.addCalendarPuzzle(input,{id:alice}).puzzle;
  const second=api.addCalendarPuzzle({...input,title:'Second'},{id:bea}).puzzle;
  const review=(number,user,vote,difficulty=3,round=1)=>{
    const result=api.completeCalendarReview(number,user,{vote,difficulty,tags:['美观'],expectedReviewRound:round});
    assert.equal(result.error,undefined);
  };
  review(first.number,alice,1,2);
  review(first.number,bea,'veto',5);
  assert.equal(api.reenterCalendarPuzzle(first.number,alice,1).error,undefined);
  review(first.number,alice,2,4,2);
  review(second.number,bea,-1);
  const read=(method,user)=>{
    const puzzles=api[method](user);
    assert.equal(puzzles.length,2);
    for (const puzzle of puzzles) {
      assert.deepEqual(puzzle,api.getCalendarPuzzle(puzzle.number,user));
      for (const group of Object.values(puzzle.rule.quality.groups)) assert.equal(group.reviewedByCurrentUser,false);
      assert.equal(puzzle.penpaEditUrl,input.penpaEditUrl);
      assert.equal(puzzle.penpaSolveUrl,input.penpaSolveUrl);
      const inherited=puzzle.quality.errors.find((error)=>error.key===`rule:${rule.id}:auditRejected:description`);
      assert.equal(inherited.ignored,true);
      assert.equal(inherited.inheritedIgnore,true);
    }
    return puzzles;
  };
  const aliceRead=read('getCalendarPuzzles',alice);
  const beaRead=read('getCalendarPuzzles',bea);
  const a=aliceRead.find((puzzle)=>puzzle.number===first.number),b=beaRead.find((puzzle)=>puzzle.number===first.number);
  assert.equal(a.userVote,2);
  assert.equal(b.userVote,null);
  assert.equal(a.evaluation.difficulty,4);
  assert.equal(b.evaluation.difficulty,5);
  assert.deepEqual(a.ratingParticipants,[people[alice],people[bea]]);
  assert.equal(a.votes,2);
  assert.deepEqual(a.review.participants,{support:[people[alice]],oppose:[],veto:[]});
  assert.deepEqual(a.reviewHistory[0].participants,{support:[people[alice]],oppose:[],veto:[people[bea]]});
  assert.deepEqual(a.reviewHistory.map((round)=>round.evaluationCount),[2,1]);
  assert.equal(a.calendarArea,'review');
  assert.equal(a.review.totalScore,2);
  assert.deepEqual(a.review.scoreParticipants,{'-2':[],'-1':[],'0':[],'1':[],'2':[people[alice]],veto:[]});
  assert.deepEqual(a.reviewHistory[0].scoreParticipants,{'-2':[],'-1':[],'0':[],'1':[people[alice]],'2':[],veto:[people[bea]]});
  assert.equal(aliceRead.find((puzzle)=>puzzle.number===second.number).completed,false);
  assert.equal(beaRead.find((puzzle)=>puzzle.number===second.number).completed,true);
  assert.deepEqual(beaRead.find((puzzle)=>puzzle.number===second.number).review.scoreParticipants['-1'],[people[bea]]);
  const puzzleRejection=a.quality.errors.find((error)=>error.key===`rule:${rule.id}:auditRejected:description`);
  assert.equal(api.setQualityErrorIgnored('puzzle',first.number,bea,{key:puzzleRejection.key,revision:puzzleRejection.revision,ignored:true,reason:'Puzzle-specific exception'}).error,undefined);
  const ignoredPuzzle=read('getCalendarPuzzles',alice).find((puzzle)=>puzzle.number===first.number);
  assert.equal(ignoredPuzzle.quality.errors.find((error)=>error.key===puzzleRejection.key).ignore.reason,'Puzzle-specific exception');

  rule=edit(api,rule,{titleZh:'更新后的共享规则'});
  audit(api,rule,'name','approve',bea);
  for (const user of [alice,bea]) for (const puzzle of read('getCalendarPuzzles',user)) {
    assert.equal(puzzle.rule.titleZh,'更新后的共享规则');
    assert.deepEqual(puzzle.rule.quality.groups.name.currentReviews.map((review)=>review.userId),[bea]);
  }
  assert.equal(a.rule.titleZh,'共享规则');
  review(second.number,alice,2);
  review(second.number,eve,0);
  const allocated=read('getCalendarPuzzles',alice).find((puzzle)=>puzzle.number===second.number);
  assert.equal(allocated.calendarArea,'allocation');
  assert.equal(allocated.review.scoredCount,3);
  assert.equal(allocated.review.totalScore,1);
  assert.deepEqual(allocated.review.scoreParticipants['0'],[people[eve]]);
  assert.deepEqual(allocated.review.scoreParticipants['2'],[people[alice]]);
  assert.deepEqual(allocated.review.scoreParticipants['-1'],[people[bea]]);
  review(first.number,alice,'veto',4,2);
  review(second.number,bea,'veto');
  assert.deepEqual(api.getCalendarPuzzles(alice),[]);
  const leftovers=read('getCalendarLeftovers',alice);
  assert.ok(leftovers.every((puzzle)=>puzzle.calendarArea==='leftover'));
  read('getCalendarLeftovers',bea);
  rule=edit(api,rule,{exampleAuthor:'Fresh author'});
  for (const user of [bea,alice]) for (const puzzle of read('getCalendarLeftovers',user)) assert.equal(puzzle.rule.exampleAuthor,'Fresh author');
  assert.equal(leftovers[0].rule.exampleAuthor,'Fixture author');
  const firstAfter=api.getCalendarPuzzle(first.number,bea);
  assert.deepEqual(firstAfter.ratingParticipants,[people[alice],people[bea]]);
  assert.deepEqual(firstAfter.reviewHistory[0].participants,a.reviewHistory[0].participants);
  assert.deepEqual(firstAfter.review.participants,{support:[],oppose:[],veto:[people[alice]]});
});
