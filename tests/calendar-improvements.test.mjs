import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { removeNeutralCalendarReviews } from '../calendar-review-migration.mjs';

const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'puzarchive-improvements-'));
process.env.PUZARCHIVE_DB_PATH=path.join(tempDir,'test.sqlite');
process.env.PUZARCHIVE_USERS_PATH=path.join(tempDir,'users.json');
fs.writeFileSync(process.env.PUZARCHIVE_USERS_PATH,JSON.stringify([{id:'owner',name:'Owner',accessCode:'isolated-test-invitation-001'}]));
const {createServer}=await import('../server.mjs');
const {database,addRule,addCalendarPuzzle}=await import('../db.mjs');

test('comments, spoiler reads, creator edits and review clearing are independent of votes',async(t)=>{
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{await new Promise((resolve)=>server.close(resolve));database.close();fs.rmSync(tempDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const cookies={};
  for (const id of ['owner','supporter','opposer','vetoer','unfinished']) {
    database.prepare(`INSERT INTO trusted_users(id,name,username,username_key,password_hash,is_active)
      VALUES (?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET username=excluded.username,username_key=excluded.username_key,password_hash=excluded.password_hash`).run(id,id,id,id,'isolated-test-hash');
    const token=`isolated-session-${id}`;
    database.prepare('INSERT INTO member_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+60000);
    cookies[id]=`puzarchive_session=${token}`;
  }
  async function request(url,method='GET',body=null,id='owner') {
    const response=await fetch(`${base}${url}`,{method,headers:{origin:base,...(id?{cookie:cookies[id]}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  }
  const rule=addRule({titleZh:'测试规则',titleEn:'Test rule',category:'其它',rulesZh:['测试'],rulesEn:[],isVariant:false,baseRuleId:null,exampleUrl:'',exampleAuthor:''},'owner');
  const {puzzle}=addCalendarPuzzle({title:'Original',author:'Author',source:'puzz.link',inputMode:'external',url:'https://puzz.link/p?slither/3/3/0000',ruleId:rule.id}, {id:'owner'});
  const url=`/api/calendar/puzzles/${puzzle.number}`;
  assert.equal((await request(`${url}/comments`,'GET',null,null)).status,401);
  assert.equal((await request(`${url}/comments`,'POST',{body:'   '})).status,400);
  assert.equal((await request(`${url}/comments`,'POST',{body:'x'.repeat(2001)})).status,400);
  assert.equal((await request(`${url}/complete-rating`,'POST',{difficulty:3,tags:[],vote:'neutral',expectedReviewRound:1},'supporter')).status,400);
  const votes=[['supporter','support'],['opposer','oppose'],['vetoer','veto']];
  for (const [id,vote] of votes) {
    assert.equal((await request(`${url}/complete-rating`,'POST',{difficulty:4,tags:['美观'],vote,expectedReviewRound:1},id)).status,200);
    assert.equal((await request(`${url}/comments`,'POST',{body:`${vote}: <script>alert(1)</script>\n解题思路`,userId:'forged'},id)).status,201);
  }
  const hidden=await request(`${url}/comments`,'GET',null,'unfinished');
  assert.deepEqual(hidden.body,{hidden:true,comments:[]});
  const revealed=await request(`${url}/comments?reveal=1`,'GET',null,'unfinished');
  assert.equal(revealed.body.comments.length,3);
  assert.equal(revealed.body.comments[2].username,'vetoer');
  assert.equal((await request(`${url}/comments`,'GET',null,'supporter')).body.comments.length,3);
  assert.equal((await request(`${url}/comments`,'POST',{body:'否决后仍可补充留言'},'vetoer')).status,201);
  const latest=(await request(url)).body.puzzle;
  const edit={title:'Updated',url:'https://puzz.link/p?slither/4/4/0000',expectedEditVersion:latest.editVersion,expectedReviewRound:latest.reviewRound};
  assert.equal((await request(url,'PATCH',edit,'supporter')).status,403);
  assert.equal((await request(url,'PATCH',{...edit,url:'javascript:alert(1)'})).status,400);
  assert.equal((await request(url,'PATCH',{...edit,clearReviews:'true'})).status,400);
  const preserved=await request(url,'PATCH',edit);
  assert.equal(preserved.status,200);
  assert.equal(preserved.body.puzzle.title,'Updated');
  assert.equal(preserved.body.puzzle.url,edit.url);
  assert.equal(preserved.body.puzzle.calendarStatus,'leftover');
  assert.equal(preserved.body.puzzle.votes,3);
  assert.equal(preserved.body.puzzle.reviewRound,1);
  assert.equal((await request(url,'PATCH',edit)).status,409);
  const reset=await request(url,'PATCH',{...edit,expectedEditVersion:preserved.body.puzzle.editVersion,clearReviews:true});
  assert.equal(reset.status,200);
  assert.equal(reset.body.puzzle.reviewRound,2);
  assert.equal(reset.body.puzzle.calendarStatus,'pending');
  assert.equal(reset.body.puzzle.votes,0);
  const resetId=database.prepare('SELECT id FROM puzzles WHERE number=?').get(puzzle.number).id;
  for (const table of ['puzzle_ratings','calendar_evaluations','calendar_review_votes','calendar_review_vote_events']) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE puzzle_id=?`).get(resetId).count,0,table);
  }
  assert.equal(reset.body.puzzle.evaluationSummary.averageDifficulty,null);
  assert.equal((await request(url,'GET',null,'vetoer')).body.puzzle.completed,true);
  assert.equal((await request(`${url}/comments`,'GET',null,'vetoer')).body.comments.length,4);
  assert.equal((await request(`${url}/complete-rating`,'POST',{difficulty:2,tags:[],vote:'support',expectedReviewRound:1},'supporter')).status,409);
  assert.equal((await request(`${url}/complete-rating`,'POST',{difficulty:2,tags:[],vote:'support',expectedReviewRound:2},'supporter')).status,200);
  assert.equal((await request(url,'DELETE',{deleteToken:puzzle.deleteToken})).status,200);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM calendar_comments').get().count,0);
  assert.equal((await request(`${url}/comments?reveal=1`)).status,404);
});

test('neutral migration removes associated evaluations once and preserves completions and non-neutral reviews',()=>{
  const fixture=new DatabaseSync(':memory:');
  try {
    fixture.exec(`CREATE TABLE puzzles(id INTEGER PRIMARY KEY,scope TEXT);
      CREATE TABLE puzzle_ratings(puzzle_id INTEGER,user_id TEXT);
      CREATE TABLE calendar_review_schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE calendar_evaluations(puzzle_id INTEGER,user_id TEXT,review_round INTEGER,difficulty INTEGER);
      CREATE TABLE calendar_review_votes(puzzle_id INTEGER,user_id TEXT,review_round INTEGER,vote TEXT);
      CREATE TABLE calendar_review_vote_events(puzzle_id INTEGER,user_id TEXT,review_round INTEGER,vote TEXT);
      CREATE TABLE puzzle_completions(puzzle_id INTEGER,user_id TEXT);
      INSERT INTO puzzles VALUES(100,'calendar'),(101,'public');
      INSERT INTO puzzle_ratings VALUES(100,'neutral-user'),(100,'support-user'),(101,'neutral-user');
      INSERT INTO calendar_evaluations VALUES(100,'neutral-user',1,3),(100,'support-user',1,5),(100,'neutral-user',2,4);
      INSERT INTO calendar_review_votes VALUES(100,'neutral-user',1,'neutral'),(100,'support-user',1,'support'),(100,'neutral-user',2,'oppose');
      INSERT INTO calendar_review_vote_events VALUES(100,'neutral-user',1,'neutral'),(100,'support-user',1,'neutral'),(100,'support-user',1,'support');
      INSERT INTO puzzle_completions VALUES(100,'neutral-user'),(100,'support-user');`);
    assert.equal(removeNeutralCalendarReviews(fixture),true);
    assert.deepEqual(fixture.prepare('SELECT vote FROM calendar_review_votes ORDER BY vote').all().map(r=>r.vote),['oppose','support']);
    assert.deepEqual(fixture.prepare('SELECT difficulty FROM calendar_evaluations ORDER BY difficulty').all().map(r=>r.difficulty),[4,5]);
    assert.equal(fixture.prepare('SELECT COUNT(*) AS count FROM puzzle_completions').get().count,2);
    assert.equal(fixture.prepare("SELECT COUNT(*) AS count FROM calendar_review_vote_events WHERE vote='neutral'").get().count,0);
    assert.equal(fixture.prepare('SELECT COUNT(*) AS count FROM puzzle_ratings WHERE puzzle_id=101').get().count,1);
    fixture.exec("INSERT INTO calendar_evaluations VALUES(100,'neutral-user',1,2)");
    assert.equal(removeNeutralCalendarReviews(fixture),false);
    assert.equal(fixture.prepare('SELECT COUNT(*) AS count FROM calendar_evaluations').get().count,3);
  } finally { fixture.close(); }
});
