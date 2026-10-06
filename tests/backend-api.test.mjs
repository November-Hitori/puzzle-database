import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'puzarchive-api-'));
const dbPath=path.join(tempDir,'legacy.sqlite');
const usersPath=path.join(tempDir,'trusted-users.json');
const members=[
  {id:'trusted-1',name:'Ada',accessCode:'test-invitation-code-ada-001'},
  {id:'trusted-2',name:'Lin',accessCode:'test-invitation-code-lin-002'}
];
fs.writeFileSync(usersPath,JSON.stringify(members));
const legacy=new DatabaseSync(dbPath);
legacy.exec(`CREATE TABLE puzzles (id INTEGER PRIMARY KEY,number INTEGER NOT NULL UNIQUE,title TEXT NOT NULL,type TEXT NOT NULL,author TEXT NOT NULL,source TEXT NOT NULL,url TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',rules TEXT NOT NULL DEFAULT '',input_mode TEXT NOT NULL DEFAULT 'external',answer TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO puzzles(number,title,type,author,source,url,note,rules,input_mode,answer) VALUES(777,'Legacy puzzle','逻辑题','Old author','puzz.link','https://puzz.link/','','old rule','external','');`);
legacy.close();
process.env.PUZARCHIVE_DB_PATH=dbPath;
process.env.PUZARCHIVE_USERS_PATH=usersPath;
const {createServer}=await import('../server.mjs');

test('authenticated calendar, catalog, scope isolation, ownership and migration',async(t)=>{
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise((resolve)=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(url,options={},cookie='') {
    const method=options.method||'GET';
    const response=await fetch(`${base}${url}`,{...options,headers:{...(options.headers||{}),host:`127.0.0.1:${server.address().port}`,...(method!=='GET'?{origin:base}:{}),...(cookie?{cookie}:{}),...(options.body?{'content-type':'application/json'}:{})}});
    const body=await response.json().catch(()=>null);
    return {response,body,cookie:response.headers.get('set-cookie')?.split(';')[0]||cookie};
  }
  const anonymous=await request('/api/calendar/puzzles');
  assert.equal(anonymous.response.status,401);
  assert.equal((await request('/api/puzzles')).response.status,401);
  assert.equal((await request('/data/trusted-users.json')).response.status,404);
  assert.equal((await request('/db.mjs')).response.status,404);

  const badLogin=await request('/api/session',{method:'POST',body:JSON.stringify({accessCode:'wrong-code'})});
  assert.equal(badLogin.response.status,401);
  const adaLogin=await request('/api/session',{method:'POST',body:JSON.stringify({accessCode:members[0].accessCode})});
  assert.equal(adaLogin.response.status,200);
  assert.equal(adaLogin.body.user.name,'Ada');
  assert.match(adaLogin.response.headers.get('set-cookie'),/HttpOnly/);
  assert.match(adaLogin.response.headers.get('set-cookie'),/SameSite=Strict/);
  const ada=adaLogin.cookie;
  const rules0=await request('/api/rules',{},ada);
  assert.deepEqual(rules0.body.rules,[]);
  const original=await request('/api/rules',{method:'POST',body:JSON.stringify({titleZh:'填字',titleEn:'Fillomino',rulesZh:['每个区域包含指定数量的格子。'],rulesEn:['Each region contains its numbered number of cells.'],category:'分区',isVariant:false})},ada);
  assert.equal(original.response.status,201);
  const variant=await request('/api/rules',{method:'POST',body:JSON.stringify({titleZh:'奇数变体',titleEn:'Odd Variant',rulesZh:['新条款'],rulesEn:['New clause'],category:'分区',isVariant:true,baseRuleId:original.body.rule.id})},ada);
  assert.equal(variant.response.status,201);
  const invalidVariant=await request('/api/rules',{method:'POST',body:JSON.stringify({titleZh:'错误变体',titleEn:'Bad Variant',rulesZh:['条款'],rulesEn:['Clause'],category:'其它',isVariant:true,baseRuleId:variant.body.rule.id})},ada);
  assert.equal(invalidVariant.response.status,400);
  const badRule=await request('/api/rules',{method:'POST',body:JSON.stringify({titleZh:'缺英文条款',titleEn:'Missing clause',rulesZh:['中文'],rulesEn:[],category:'其它',isVariant:false})},ada);
  assert.equal(badRule.response.status,400);

  const invalidDate=await request('/api/calendar/puzzles',{method:'POST',body:JSON.stringify({title:'Calendar',author:'Ada',source:'Fill-in',inputMode:'blank',ruleId:original.body.rule.id,suggestedDate:'2025-02-29'})},ada);
  assert.equal(invalidDate.response.status,400);
  const created=await request('/api/calendar/puzzles',{method:'POST',body:JSON.stringify({title:'Calendar puzzle',author:'Ada',source:'Fill-in',note:'First entry',inputMode:'blank',answer:'four',ruleId:original.body.rule.id,suggestedDate:'2024-02-29'})},ada);
  assert.equal(created.response.status,201);
  const number=created.body.puzzle.number;
  assert.equal(created.body.puzzle.scope,'calendar');
  assert.equal(created.body.puzzle.rule.titleEn,'Fillomino');
  assert.deepEqual(created.body.puzzle.submittedBy,{id:'trusted-1',name:'Ada'});
  assert.equal(created.body.puzzle.suggestedDate,'2024-02-29');
  const legacyList=await request('/api/puzzles',{},ada);
  assert.deepEqual(legacyList.body.puzzles.map((p)=>p.number),[777]);
  assert.equal((await request('/api/tags',{},ada)).body.tags.length,0);
  assert.equal((await request('/api/calendar/puzzles',{},ada)).body.puzzles.length,1);
  assert.equal((await request(`/api/puzzles/${number}/complete-rating`,{method:'POST',body:JSON.stringify({logic:5,intuition:4,enjoyment:5})},ada)).response.status,404);

  const linLogin=await request('/api/session',{method:'POST',body:JSON.stringify({accessCode:members[1].accessCode})});
  const lin=linLogin.cookie;
  const forbidden=await request(`/api/calendar/puzzles/${number}`,{method:'PATCH',body:JSON.stringify({suggestedDate:'2026-01-01'})},lin);
  assert.equal(forbidden.response.status,403);
  assert.equal((await request(`/api/calendar/puzzles/${number}/complete-rating`,{method:'POST',body:JSON.stringify({logic:3,intuition:2,enjoyment:4})},lin)).response.status,200);
  const rateUpdate=await request(`/api/calendar/puzzles/${number}/complete-rating`,{method:'POST',body:JSON.stringify({logic:1,intuition:1,enjoyment:2})},lin);
  assert.equal(rateUpdate.body.puzzles[0].votes,1);
  assert.deepEqual(rateUpdate.body.puzzles[0].ratings,[1,1,2]);
  assert.deepEqual(rateUpdate.body.puzzles[0].userRating,[1,1,2]);
  assert.equal((await request(`/api/calendar/puzzles/${number}`,{method:'PATCH',body:JSON.stringify({suggestedDate:null})},ada)).response.status,200);
  assert.equal((await request('/api/collections',{},ada)).body.collections.length,2);
  const unauthLogout=await request('/api/session',{method:'DELETE'});
  assert.equal(unauthLogout.response.status,200);
  assert.equal((await request('/api/session',{},ada)).body.user.id,'trusted-1');
  const logout=await request('/api/session',{method:'DELETE'},ada);
  assert.equal(logout.body.user,null);
  assert.equal((await request('/api/session',{},logout.cookie)).body.user,null);
});

test('forwarded headers are ignored by default and accepted only in trusted loopback proxy mode',async(t)=>{
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise((resolve)=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={host:`127.0.0.1:${server.address().port}`,origin:base,'content-type':'application/json','x-forwarded-proto':'https','x-real-ip':'203.0.113.20'};
  const spoofed=await fetch(`${base}/api/session`,{method:'POST',headers,body:JSON.stringify({accessCode:members[0].accessCode})});
  assert.equal(spoofed.status,200);
  assert.doesNotMatch(spoofed.headers.get('set-cookie'),/; Secure(?:;|$)/);
  const wrongScheme=await fetch(`${base}/api/session`,{method:'POST',headers:{...headers,origin:base.replace('http:','https:')},body:JSON.stringify({accessCode:members[0].accessCode})});
  assert.equal(wrongScheme.status,403);

  const proxyServer=createServer({trustLoopbackProxy:true});
  await new Promise((resolve,reject)=>{proxyServer.once('error',reject);proxyServer.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise((resolve)=>proxyServer.close(resolve)));
  const proxyBase=`http://127.0.0.1:${proxyServer.address().port}`;
  const proxied=await fetch(`${proxyBase}/api/session`,{method:'POST',headers:{...headers,host:`127.0.0.1:${proxyServer.address().port}`,origin:proxyBase.replace('http:','https:')},body:JSON.stringify({accessCode:members[1].accessCode})});
  assert.equal(proxied.status,200);
  assert.match(proxied.headers.get('set-cookie'),/; Secure(?:;|$)/);
  const secureLogout=await fetch(`${proxyBase}/api/session`,{method:'DELETE',headers:{...headers,host:`127.0.0.1:${proxyServer.address().port}`,origin:proxyBase.replace('http:','https:')}});
  assert.match(secureLogout.headers.get('set-cookie'),/; Secure(?:;|$)/);
  const invalidForwardedIp=await fetch(`${proxyBase}/api/session`,{method:'POST',headers:{...headers,host:`127.0.0.1:${proxyServer.address().port}`,origin:proxyBase.replace('http:','https:'),'x-real-ip':'203.0.113.20, 198.51.100.4'},body:JSON.stringify({accessCode:members[1].accessCode})});
  assert.equal(invalidForwardedIp.status,403);

  const addressA={...headers,host:`127.0.0.1:${proxyServer.address().port}`,origin:proxyBase.replace('http:','https:'),'x-real-ip':'198.51.100.31'};
  for (let attempt=0;attempt<12;attempt++) {
    const failed=await fetch(`${proxyBase}/api/session`,{method:'POST',headers:addressA,body:JSON.stringify({accessCode:'wrong-code'})});
    assert.equal(failed.status,401);
  }
  assert.equal((await fetch(`${proxyBase}/api/session`,{method:'POST',headers:addressA,body:JSON.stringify({accessCode:'wrong-code'})})).status,429);
  const addressB={...addressA,'x-real-ip':'198.51.100.32'};
  assert.equal((await fetch(`${proxyBase}/api/session`,{method:'POST',headers:addressB,body:JSON.stringify({accessCode:'wrong-code'})})).status,401);
  assert.equal((await fetch(`${proxyBase}/api/session`,{method:'POST',headers:addressB,body:JSON.stringify({accessCode:members[1].accessCode})})).status,200);
});
