import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'puzarchive-api-'));
const dbPath=path.join(tempDir,'legacy.sqlite');
const usersPath=path.join(tempDir,'trusted-users.json');
const members=[
  {id:'trusted-1',name:'Ada',accessCode:'test-invitation-code-ada-001'}
];
fs.writeFileSync(usersPath,JSON.stringify(members));
const legacy=new DatabaseSync(dbPath);
legacy.exec(`CREATE TABLE puzzles (id INTEGER PRIMARY KEY,number INTEGER NOT NULL UNIQUE,title TEXT NOT NULL,type TEXT NOT NULL,author TEXT NOT NULL,source TEXT NOT NULL,url TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',rules TEXT NOT NULL DEFAULT '',input_mode TEXT NOT NULL DEFAULT 'external',answer TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO puzzles(number,title,type,author,source,url,note,rules,input_mode,answer) VALUES(777,'Legacy puzzle','逻辑题','Old author','puzz.link','https://puzz.link/','','old rule','external','');`);
legacy.exec(`CREATE TABLE trusted_users (id TEXT PRIMARY KEY,name TEXT NOT NULL,access_code_hash TEXT NOT NULL DEFAULT '');
CREATE TABLE member_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
const sha256=(value)=>createHash('sha256').update(value).digest('hex');
legacy.prepare('INSERT INTO trusted_users(id,name,access_code_hash) VALUES (?,?,?)').run('trusted-1','Old Ada',sha256('stale-ada-code-before-rotation'));
legacy.prepare('INSERT INTO trusted_users(id,name,access_code_hash) VALUES (?,?,?)').run('removed-user','Removed Member',sha256('removed-member-invite'));
legacy.prepare('INSERT INTO member_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha256('old-invitation-session'), 'trusted-1', Date.now()+60*60*1000);
legacy.close();
process.env.PUZARCHIVE_DB_PATH=dbPath;
process.env.PUZARCHIVE_USERS_PATH=usersPath;
const {createServer}=await import('../server.mjs');
const {authBootstrapComplete,bootstrapLegacyAuth,database,findSession,setRegistrationGate}=await import('../db.mjs');

test('one-time invite migration preserves identities, invalidates old sessions, and supports username-password accounts',async(t)=>{
  assert.equal(authBootstrapComplete(),true);
  assert.equal(findSession(sha256('old-invitation-session')),null);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM puzzles WHERE number=777').get().count,1);
  assert.equal(database.prepare('SELECT is_active FROM trusted_users WHERE id=?').get('removed-user').is_active,0);
  assert.equal(database.prepare('SELECT pending_legacy_user_id FROM registration_gate WHERE id=1').get().pending_legacy_user_id,'trusted-1');
  assert.equal(bootstrapLegacyAuth([{id:'trusted-1',name:'Ada',accessCodeHash:sha256(members[0].accessCode)}]),false);

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

  const rotatedCode=await request('/api/register',{method:'POST',body:JSON.stringify({inviteCode:'stale-ada-code-before-rotation',username:'Ada',password:'correct horse battery staple'})});
  assert.equal(rotatedCode.response.status,400);
  const removedCode=await request('/api/register',{method:'POST',body:JSON.stringify({inviteCode:'removed-member-invite',username:'Removed',password:'correct horse battery staple'})});
  assert.equal(removedCode.response.status,400);
  const tooShort=await request('/api/register',{method:'POST',body:JSON.stringify({inviteCode:members[0].accessCode,username:'Ada',password:'short'})});
  assert.equal(tooShort.response.status,400);
  assert.equal(database.prepare('SELECT pending_legacy_user_id FROM registration_gate WHERE id=1').get().pending_legacy_user_id,'trusted-1');
  const gateHash=database.prepare('SELECT token_hash FROM registration_gate WHERE id=1').get().token_hash;
  const legacyClaimRace=await Promise.all(['Ada','Ａda'].map((username)=>request('/api/register',{method:'POST',body:JSON.stringify({inviteCode:members[0].accessCode,username,password:'correct horse battery staple'})})));
  assert.deepEqual(legacyClaimRace.map((result)=>result.response.status).sort(),[201,409]);
  const adaRegistration=legacyClaimRace.find((result)=>result.response.status===201);
  assert.equal(adaRegistration.body.user.id,'trusted-1');
  assert.equal(adaRegistration.body.user.name,'Ada');
  assert.equal(adaRegistration.body.user.username,'Ada');
  assert.equal(database.prepare('SELECT pending_legacy_user_id FROM registration_gate WHERE id=1').get().pending_legacy_user_id,null);
  assert.equal(database.prepare('SELECT token_hash FROM registration_gate WHERE id=1').get().token_hash,gateHash);
  assert.match(adaRegistration.response.headers.get('set-cookie'),/HttpOnly/);
  assert.match(adaRegistration.response.headers.get('set-cookie'),/SameSite=Strict/);
  const ada=adaRegistration.cookie;
  const reusableCode=await request('/api/register',{method:'POST',body:JSON.stringify({inviteCode:members[0].accessCode,username:'Ada2',password:'correct horse battery staple'})});
  assert.equal(reusableCode.response.status,201);
  const wrongPassword=await request('/api/session',{method:'POST',body:JSON.stringify({username:'ada',password:'incorrect horse battery staple'})});
  assert.equal(wrongPassword.response.status,401);
  const oldLogin=await request('/api/session',{method:'POST',body:JSON.stringify({accessCode:members[0].accessCode})});
  assert.equal(oldLogin.response.status,400);
  const adaLogin=await request('/api/session',{method:'POST',body:JSON.stringify({username:'ada',password:'correct horse battery staple'})});
  assert.equal(adaLogin.response.status,200);
  assert.equal(adaLogin.body.user.id,'trusted-1');
  assert.equal(adaLogin.body.user.username,'Ada');
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

  const linPayload=Buffer.from(JSON.stringify({inviteCode:members[0].accessCode,username:'林晓',password:'密码 another correct horse battery staple'}));
  const splitAt=linPayload.indexOf(Buffer.from('密'))+1;
  async function* fragmentedBody() {
    yield linPayload.subarray(0,splitAt);
    await new Promise((resolve)=>setTimeout(resolve,1));
    yield linPayload.subarray(splitAt);
  }
  const linResponse=await fetch(`${base}/api/register`,{method:'POST',headers:{host:`127.0.0.1:${server.address().port}`,origin:base,'content-type':'application/json'},body:fragmentedBody(),duplex:'half'});
  const linRegistration={response:linResponse,body:await linResponse.json(),cookie:linResponse.headers.get('set-cookie')?.split(';')[0]||''};
  assert.equal(linRegistration.response.status,201);
  assert.equal(linRegistration.body.user.username,'林晓');
  const lin=linRegistration.cookie;
  const forbidden=await request(`/api/calendar/puzzles/${number}`,{method:'PATCH',body:JSON.stringify({suggestedDate:'2026-01-01'})},lin);
  assert.equal(forbidden.response.status,403);
  assert.equal((await request(`/api/calendar/puzzles/${number}/complete-rating`,{method:'POST',body:JSON.stringify({logic:3,intuition:2,enjoyment:4})},lin)).response.status,200);
  const rateUpdate=await request(`/api/calendar/puzzles/${number}/complete-rating`,{method:'POST',body:JSON.stringify({logic:1,intuition:1,enjoyment:2})},lin);
  assert.equal(rateUpdate.body.puzzles[0].votes,1);
  assert.deepEqual(rateUpdate.body.puzzles[0].ratings,[1,1,2]);
  assert.deepEqual(rateUpdate.body.puzzles[0].userRating,[1,1,2]);
  const linCalendar=await request('/api/calendar/puzzles',{},lin);
  const adaCalendar=await request('/api/calendar/puzzles',{},ada);
  assert.equal(linCalendar.body.puzzles[0].completed,true);
  assert.deepEqual(linCalendar.body.puzzles[0].userRating,[1,1,2]);
  assert.equal(adaCalendar.body.puzzles[0].completed,false);
  assert.equal(adaCalendar.body.puzzles[0].userRating,null);
  assert.equal((await request(`/api/calendar/puzzles/${number}`,{method:'PATCH',body:JSON.stringify({suggestedDate:null})},ada)).response.status,200);
  assert.equal((await request('/api/collections',{},ada)).body.collections.length,2);
  const unauthLogout=await request('/api/session',{method:'DELETE'});
  assert.equal(unauthLogout.response.status,200);
  assert.equal((await request('/api/session',{},ada)).body.user.id,'trusted-1');
  const logout=await request('/api/session',{method:'DELETE'},ada);
  assert.equal(logout.body.user,null);
  assert.equal((await request('/api/session',{},logout.cookie)).body.user,null);
});

test('shared registration code is reusable and concurrent usernames remain unique',async(t)=>{
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise((resolve)=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(url,options={}) {
    return fetch(`${base}${url}`,{...options,headers:{host:`127.0.0.1:${server.address().port}`,origin:base,...(options.headers||{}),...(options.method&&options.method!=='GET'?{origin:base}:{})}});
  }
  const gateCode='shared-registration-gate-race-code';
  setRegistrationGate(sha256(gateCode));
  const distinctAccounts=await Promise.all([1,2].map((suffix)=>request('/api/register',{method:'POST',body:JSON.stringify({inviteCode:gateCode,username:`Puzzle${suffix}`,password:'enough password words for test'})})));
  assert.deepEqual(distinctAccounts.map((response)=>response.status).sort(),[201,201]);
  const sameUsername=await Promise.all(['Same_User','same_user'].map((username)=>request('/api/register',{method:'POST',body:JSON.stringify({inviteCode:gateCode,username,password:'enough password words for test'})})));
  assert.deepEqual(sameUsername.map((response)=>response.status).sort(),[201,409]);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM trusted_users WHERE username_key=?').get('same_user').count,1);
  assert.equal(database.prepare('SELECT token_hash FROM registration_gate WHERE id=1').get().token_hash,sha256(gateCode));
  assert.equal(bootstrapLegacyAuth([{id:'trusted-1',name:'Ada',accessCodeHash:sha256(members[0].accessCode)}]),false);
  const afterRestart=await request('/api/register',{method:'POST',body:JSON.stringify({inviteCode:gateCode,username:'AfterRestart',password:'enough password words for test'})});
  assert.equal(afterRestart.status,201);
  assert.equal(database.prepare('SELECT token_hash FROM registration_gate WHERE id=1').get().token_hash,sha256(gateCode));
  const restarted=spawnSync(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync(${JSON.stringify(dbPath)},{readOnly:true}); console.log(d.prepare('SELECT token_hash FROM registration_gate WHERE id=1').get().token_hash); d.close();`],{encoding:'utf8'});
  assert.equal(restarted.status,0,restarted.stderr);
  assert.equal(restarted.stdout.trim(),sha256(gateCode));
});

test('forwarded headers are ignored by default and accepted only in trusted loopback proxy mode',async(t)=>{
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise((resolve)=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={host:`127.0.0.1:${server.address().port}`,origin:base,'content-type':'application/json','x-forwarded-proto':'https','x-real-ip':'203.0.113.20'};
  const directCode='direct-proxy-mode-invite-code';
  setRegistrationGate(sha256(directCode));
  const directPayload={inviteCode:directCode,username:'DirectUser',password:'direct user password long'};
  const spoofed=await fetch(`${base}/api/register`,{method:'POST',headers,body:JSON.stringify(directPayload)});
  assert.equal(spoofed.status,201);
  assert.doesNotMatch(spoofed.headers.get('set-cookie'),/; Secure(?:;|$)/);
  const wrongScheme=await fetch(`${base}/api/register`,{method:'POST',headers:{...headers,origin:base.replace('http:','https:')},body:JSON.stringify(directPayload)});
  assert.equal(wrongScheme.status,403);

  const proxyServer=createServer({trustLoopbackProxy:true});
  await new Promise((resolve,reject)=>{proxyServer.once('error',reject);proxyServer.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise((resolve)=>proxyServer.close(resolve)));
  const proxyBase=`http://127.0.0.1:${proxyServer.address().port}`;
  const proxyCode='trusted-proxy-mode-invite-code';
  setRegistrationGate(sha256(proxyCode));
  const proxyPayload={inviteCode:proxyCode,username:'ProxyUser',password:'proxy user password long'};
  const proxyHeaders={...headers,host:`127.0.0.1:${proxyServer.address().port}`,origin:proxyBase.replace('http:','https:')};
  const proxied=await fetch(`${proxyBase}/api/register`,{method:'POST',headers:proxyHeaders,body:JSON.stringify(proxyPayload)});
  assert.equal(proxied.status,201);
  assert.match(proxied.headers.get('set-cookie'),/; Secure(?:;|$)/);
  const proxyCookie=proxied.headers.get('set-cookie').split(';')[0];
  const secureLogout=await fetch(`${proxyBase}/api/session`,{method:'DELETE',headers:{...proxyHeaders,cookie:proxyCookie}});
  assert.match(secureLogout.headers.get('set-cookie'),/; Secure(?:;|$)/);
  const invalidForwardedIp=await fetch(`${proxyBase}/api/session`,{method:'POST',headers:{...proxyHeaders,'x-real-ip':'203.0.113.20, 198.51.100.4'},body:JSON.stringify({username:'proxyuser',password:'proxy user password long'})});
  assert.equal(invalidForwardedIp.status,403);

  const addressA={...proxyHeaders,'x-real-ip':'198.51.100.31'};
  for (let attempt=0;attempt<12;attempt++) {
    const failed=await fetch(`${proxyBase}/api/session`,{method:'POST',headers:addressA,body:JSON.stringify({username:'UnknownUser',password:'wrong password that is long'})});
    assert.equal(failed.status,401);
  }
  assert.equal((await fetch(`${proxyBase}/api/session`,{method:'POST',headers:addressA,body:JSON.stringify({username:'UnknownUser',password:'wrong password that is long'})})).status,429);
  const addressB={...addressA,'x-real-ip':'198.51.100.32'};
  assert.equal((await fetch(`${proxyBase}/api/session`,{method:'POST',headers:addressB,body:JSON.stringify({username:'proxyuser',password:'proxy user password long'})})).status,200);
});
