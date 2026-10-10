import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'puzarchive-calendar-pages-'));
process.env.PUZARCHIVE_DB_PATH=path.join(tempDir,'test.sqlite');
process.env.PUZARCHIVE_USERS_PATH=path.join(tempDir,'users.json');
process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH=path.join(tempDir,'penpa.md');
fs.writeFileSync(process.env.PUZARCHIVE_USERS_PATH,JSON.stringify([{id:'owner',name:'Owner',accessCode:'isolated-calendar-page-invite'}]));
fs.writeFileSync(process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH,'Isolated pagination drawing guideline.');
const {createServer}=await import('../server.mjs');
const db=await import('../db.mjs');
const {getPenpaGuidelines}=await import('../penpa-guidelines.mjs');

test('calendar pages filter and sort before hydrating ten items and keep the complete month grid',async(t)=>{
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{
    await new Promise((resolve)=>server.close(resolve));
    db.database.close();fs.rmSync(tempDir,{recursive:true,force:true});
  });
  const base=`http://127.0.0.1:${server.address().port}`;
  const cookies={};
  for(const id of ['owner','a','b','c','d']) {
    db.database.prepare(`INSERT INTO trusted_users(id,name,username,username_key,password_hash,is_active) VALUES(?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username,username_key=excluded.username_key,password_hash=excluded.password_hash`).run(id,id,id,id,'isolated-page-test-hash');
    const token=`isolated-calendar-page-${id}`;
    db.createSession(createHash('sha256').update(token).digest('hex'),id,Date.now()+120000);
    cookies[id]=`puzarchive_session=${token}`;
  }
  async function request(query='',user='owner') {
    const response=await fetch(`${base}/api/calendar/page${query}`,{headers:user?{cookie:cookies[user]}:{}});
    return {status:response.status,body:await response.json()};
  }
  const rule=db.addRule({titleZh:'分页规则',titleEn:'Pagination rule',rulesZh:['规则'],rulesEn:[],category:'其它',isVariant:false,baseRuleId:null,exampleUrl:'https://penpa-edit.com/?m=edit&p=example',exampleAuthor:''},'owner');
  for(const item of ['name','description','example']) for(const user of ['a','b','c']) assert.ok(db.submitRuleAudit(rule.id,item,'approve','',1,user).rule);
  let number=1000;
  function seed({status='pending',suggestedDate=null,assignedDate=null,calendarYear=2028,links=true,audited=false,completed=false}={}) {
    const current=number++;
    const result=db.database.prepare(`INSERT INTO puzzles(number,title,type,author,source,input_mode,scope,rule_id,suggested_date,assigned_date,calendar_year,calendar_status,submitted_by,delete_token,penpa_edit_url,penpa_solve_url)
      VALUES(?,?,'其它','Author','puzz.link','external','calendar',?,?,?,?,?,'owner',?,?,?)`)
      .run(current,`Puzzle ${current}`,rule.id,suggestedDate,assignedDate,calendarYear,status,`isolated-delete-${current}`,
        links?'https://penpa-edit.com/?m=edit&p=page':'',links?'https://penpa-edit.com/?m=solve&p=page':'');
    const id=Number(result.lastInsertRowid);
    if(audited) for(const user of ['a','b','c']) db.database.prepare(`INSERT INTO calendar_penpa_votes(puzzle_id,revision,guidelines_revision,user_id,decision) VALUES(?,1,?,?,'approve')`).run(id,getPenpaGuidelines().revision,user);
    if(completed) db.database.prepare('INSERT INTO puzzle_completions(puzzle_id,user_id) VALUES(?,?)').run(id,'owner');
    return {id,number:current};
  }
  for(let index=0;index<24;index++) seed({suggestedDate:index<22?`2028-02-${String(1+Math.floor(index/2)).padStart(2,'0')}`:null,completed:index%3===0});
  const yearOnly=seed({calendarYear:2027});
  for(let index=0;index<12;index++) seed({status:'leftover',suggestedDate:`2028-03-${String(index+1).padStart(2,'0')}`});
  for(let index=0;index<14;index++) seed({status:'approved',suggestedDate:`2028-04-${String(index+1).padStart(2,'0')}`,audited:index%2===0,links:index%2===0});
  for(let index=0;index<13;index++) seed({status:'approved',assignedDate:`2028-01-${String(index+1).padStart(2,'0')}`,suggestedDate:'2028-12-31',audited:true,completed:index%4===0});
  seed({status:'approved',assignedDate:'2028-02-29',audited:true});
  seed({status:'approved',assignedDate:'2029-01-01',calendarYear:2029,audited:true});
  const ignoredLinks=seed({status:'approved',assignedDate:'2028-01-14',audited:true,links:false});
  for(const key of ['missingPenpaEdit:links','missingPenpaSolve:links']) db.database.prepare(`INSERT INTO quality_error_ignores(entity_type,entity_id,error_key,revision,ignored_by) VALUES('puzzle',?,?,1,'owner')`).run(ignoredLinks.id,key);

  await t.test('authorization and query boundaries',async()=>{
    assert.equal((await request('',null)).status,401);
    for(const query of ['limit=0','limit=51','limit=-1','limit=1.5','limit=','offset=-1','offset=1.2','offset=9007199254740992','offset=','view=review','view=','sort=bad','sort=','year=999','year=10000','year=2028.5','month=0','month=13','month=1.2'])
      assert.equal((await request(`?${query}`)).status,400,query);
    assert.equal((await request('?limit=50&offset=9007199254740991')).status,200);
    const empty=(await request('?offset=1000')).body;
    assert.deepEqual(empty.puzzles,[]);assert.equal(empty.nextOffset,null);
  });

  await t.test('each view and sort matches the legacy complete records without missing or repeating entries',async()=>{
    const all=[...db.getCalendarPuzzles('owner'),...db.getCalendarLeftovers('owner')];
    const counts=all.reduce((value,puzzle)=>{value[puzzle.calendarArea]++;return value;},{review:0,leftover:0,allocation:0,finished:0});
    assert.deepEqual(counts,{review:25,leftover:12,allocation:14,finished:16});
    for(const view of ['calendar','pending','leftovers','allocation','finished']) for(const sort of ['date','newest']) {
      const area=({calendar:'review',leftovers:'leftover',allocation:'allocation',finished:'finished'})[view];
      const selected=all.filter((puzzle)=>view==='pending'?!puzzle.completed&&puzzle.calendarArea!=='leftover':
        puzzle.calendarArea===area&&(view!=='finished'||puzzle.assignedDate.startsWith('2028-01')));
      const dateKey=(puzzle)=>puzzle.assignedDate||puzzle.suggestedDate||`${puzzle.calendarYear}-99-99`;
      selected.sort((a,b)=>sort==='newest'?b.number-a.number:dateKey(a).localeCompare(dateKey(b))||b.number-a.number);
      const actual=[];
      let offset=0;
      do {
        const result=await request(`?view=${view}&sort=${sort}&offset=${offset}`);
        assert.equal(result.status,200);assert.deepEqual(result.body.counts,counts);
        assert.equal(result.body.total,selected.length);assert.ok(result.body.puzzles.length<=10);
        assert.equal(result.body.puzzles.length,Math.min(10,selected.length-offset));
        actual.push(...result.body.puzzles.map((puzzle)=>puzzle.number));
        offset=result.body.nextOffset;
      } while(offset!==null);
      assert.deepEqual(actual,selected.map((puzzle)=>puzzle.number),`${view}/${sort}`);
    }
    assert.equal((await request()).body.puzzles[0].number,yearOnly.number);
    const anotherUser=(await request('?view=pending','d')).body;
    assert.equal(anotherUser.total,25+14+16);
    const month=(await request('?view=finished')).body;
    assert.equal(month.total,14);assert.equal(month.puzzles.length,10);
    assert.equal(month.monthEntries.length,14);
    assert.deepEqual(Object.keys(month.monthEntries[0]).sort(),['assignedDate','number','rule','title']);
    assert.deepEqual(month.monthEntries[0].rule,{titleZh:'分页规则',titleEn:'Pagination rule'});
    assert.equal((await request('?view=finished&month=2')).body.total,1);
    assert.equal((await request('?view=finished&year=2029')).body.total,1);
    assert.deepEqual((await request('?view=finished&month=3')).body.monthEntries,[]);
  });

  await t.test('only the requested page loads detailed puzzle and audit histories',async()=>{
    const originalPrepare=db.database.prepare;
    const statements=[];
    db.database.prepare=function(sql){statements.push(sql);return originalPrepare.call(this,sql);};
    try {
      assert.equal((await request()).body.puzzles.length,10);
      assert.equal(statements.filter((sql)=>sql.includes('WHERE p.number=? AND p.scope=?')).length,10);
      assert.equal(statements.filter((sql)=>sql.includes('FROM calendar_penpa_audit_events')).length,10);
      statements.length=0;
      assert.equal((await request('?view=finished&offset=10')).body.puzzles.length,4);
      assert.equal(statements.filter((sql)=>sql.includes('WHERE p.number=? AND p.scope=?')).length,4);
      assert.equal(statements.filter((sql)=>sql.includes('FROM calendar_penpa_audit_events')).length,4);
    } finally {db.database.prepare=originalPrepare;}
  });

  await t.test('current revisions, rejections, inactive approvals and ignored rule fields control area counts',async()=>{
    const baseline=(await request()).body.counts;
    const restore=(sql,...params)=>db.database.prepare(sql).run(...params);
    restore("DELETE FROM quality_error_ignores WHERE entity_type='puzzle' AND entity_id=?",ignoredLinks.id);
    assert.equal((await request()).body.counts.finished,baseline.finished-1);
    restore("INSERT INTO calendar_penpa_votes(puzzle_id,revision,guidelines_revision,user_id,decision) VALUES(?,1,?,'d','reject')",ignoredLinks.id,getPenpaGuidelines().revision);
    for(const key of ['missingPenpaEdit:links','missingPenpaSolve:links']) restore("INSERT INTO quality_error_ignores(entity_type,entity_id,error_key,revision,ignored_by) VALUES('puzzle',?,?,1,'owner')",ignoredLinks.id,key);
    assert.equal((await request()).body.counts.finished,baseline.finished-1);
    restore("DELETE FROM calendar_penpa_votes WHERE puzzle_id=? AND user_id='d'",ignoredLinks.id);
    restore("UPDATE trusted_users SET is_active=0 WHERE id='c'");
    assert.equal((await request()).body.counts.finished,0);
    restore("UPDATE trusted_users SET is_active=1 WHERE id='c'");
    restore('UPDATE rules SET name_revision=name_revision+1 WHERE id=?',rule.id);
    assert.equal((await request()).body.counts.finished,0);
    restore('UPDATE rules SET name_revision=name_revision-1 WHERE id=?',rule.id);
    fs.writeFileSync(process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH,'Changed isolated drawing guideline.');
    assert.equal((await request()).body.counts.finished,0);
    fs.writeFileSync(process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH,'Isolated pagination drawing guideline.');
    restore("UPDATE rules SET title_en='' WHERE id=?",rule.id);
    assert.equal((await request()).body.counts.finished,0);
    restore("INSERT INTO quality_error_ignores(entity_type,entity_id,error_key,revision,ignored_by) VALUES('rule',?,'missingEnName:name',1,'owner')",rule.id);
    assert.equal((await request()).body.counts.finished,baseline.finished);
  });
});
