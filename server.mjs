import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  addCalendarPuzzle, addFolder, addPuzzle, addPuzzleTag, addRule, calendarPuzzleExists,
  completeAndRate, createSession, deleteSession, findSession, getCalendarPuzzle,
  getCalendarPuzzles, getCollection, getCollections, getFolders, getPuzzles, getRule,
  getRules, getTags, retainTrustedUsers, updateCalendarSuggestedDate, upsertTrustedUser
} from './db.mjs';
import { parseTrustedPuzzleUrl, TRUSTED_PUZZLE_FRAME_SOURCES } from './puzzle-url.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(rootDir,'data');
const usersPath = process.env.PUZARCHIVE_USERS_PATH || path.join(dataDir,'trusted-users.json');
const port = Number(process.env.PORT || 4173);
const categories = new Set(['涂黑','填数','分区','置物','路径','其它']);
const mimeTypes = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml' };
const allowedAssets = new Set(['index.html','app.js','styles.css','puzzle-url.mjs','puzzle-tool-links.mjs']);
const contentSecurityPolicy = ["default-src 'self'","script-src 'self'","style-src 'self' 'unsafe-inline' https://fonts.googleapis.com","font-src 'self' https://fonts.gstatic.com","img-src 'self' data:","connect-src 'self'",`frame-src ${TRUSTED_PUZZLE_FRAME_SOURCES.join(' ')}`,"object-src 'none'","base-uri 'self'","form-action 'self'","frame-ancestors 'self'"].join('; ');
const SESSION_COOKIE='puzarchive_session';
const SESSION_MS=1000*60*60*24*14;
const loginAttempts=new Map();

function loadMembers() {
  fs.mkdirSync(path.dirname(usersPath),{recursive:true});
  if (!fs.existsSync(usersPath)) {
    const member={id:randomUUID(),name:'Trusted Member',accessCode:randomBytes(18).toString('base64url')};
    fs.writeFileSync(usersPath,`${JSON.stringify([member],null,2)}\n`,{mode:0o600,flag:'wx'});
    try { fs.chmodSync(usersPath,0o600); } catch {}
  }
  const parsed=JSON.parse(fs.readFileSync(usersPath,'utf8'));
  if (!Array.isArray(parsed) || !parsed.length || parsed.some((m)=>!m || typeof m.id!=='string' || !m.id || typeof m.name!=='string' || !m.name.trim() || typeof m.accessCode!=='string' || m.accessCode.length<16)) throw new Error(`Invalid trusted member configuration at ${usersPath}`);
  const ids=new Set(),codes=new Set();
  for (const member of parsed) {
    if (ids.has(member.id)||codes.has(member.accessCode)) throw new Error('Trusted member ids and invitation codes must be unique');
    ids.add(member.id); codes.add(member.accessCode);
    upsertTrustedUser(member.id,member.name.trim(),createHash('sha256').update(member.accessCode).digest('hex'));
  }
  retainTrustedUsers([...ids]);
  return parsed.map((m)=>({...m,name:m.name.trim()}));
}
const members=loadMembers();
const codeCandidates=members.map((member)=>({member,hash:createHash('sha256').update(member.accessCode).digest()}));
const tokenHash=(token)=>createHash('sha256').update(token).digest('hex');
const cookies=(request)=>Object.fromEntries(String(request.headers.cookie||'').split(';').map((part)=>part.trim()).filter(Boolean).map((part)=>{const at=part.indexOf('=');return [part.slice(0,at),decodeURIComponent(part.slice(at+1))]}));
function currentUser(request) { const token=cookies(request)[SESSION_COOKIE]; return token ? findSession(tokenHash(token)) : null; }
function sendJson(response,status,payload,extra={}) {
  response.writeHead(status,{ 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin',...extra });
  response.end(JSON.stringify(payload));
}
async function readJson(request,limit=128*1024) {
  let body='';
  for await (const chunk of request) { body+=chunk; if (Buffer.byteLength(body)>limit) throw Object.assign(new Error('request body too large'),{status:413}); }
  if (!body) return {};
  try { const value=JSON.parse(body); if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw Object.assign(new Error('invalid JSON body'),{status:400}); }
}
function sameOrigin(request) {
  const origin=request.headers.origin;
  if (!origin) return false;
  try { const source=new URL(origin); return source.host.toLowerCase()===String(request.headers.host||'').toLowerCase() && ['http:','https:'].includes(source.protocol); }
  catch { return false; }
}
function validText(value,max=300,required=false) { return typeof value==='string' && value.trim().length <= max && (!required || value.trim().length>0); }
function validDate(value) {
  if (value === null || value === '') return true;
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y,m,d]=value.split('-').map(Number); const dt=new Date(Date.UTC(y,m-1,d));
  return dt.getUTCFullYear()===y && dt.getUTCMonth()===m-1 && dt.getUTCDate()===d;
}
function validateRule(input) {
  if (!validText(input.titleZh,160,true)||!validText(input.titleEn,160,true)) return 'titleZh and titleEn are required';
  for (const key of ['rulesZh','rulesEn']) if (!Array.isArray(input[key])||!input[key].length||input[key].length>30||input[key].some((v)=>!validText(v,1000,true))) return `${key} must contain non-empty clauses`;
  if (input.rulesZh.length!==input.rulesEn.length) return 'Chinese and English clause counts must match';
  if (!categories.has(input.category)) return 'invalid category';
  if (typeof input.isVariant!=='boolean') return 'isVariant must be boolean';
  if (input.isVariant) { const base=Number(input.baseRuleId); const rule=Number.isInteger(base)?getRule(base):null; if (!rule||rule.isVariant) return 'variant must reference an existing original rule'; }
  else if (input.baseRuleId!==undefined && input.baseRuleId!==null && input.baseRuleId!=='') return 'original rules cannot have a base rule';
  return null;
}
function ensurePublicPuzzle(number) { return Boolean(getPuzzles('scope-check').some((p)=>p.number===number)); }
function validateRatings(input) { return ['logic','intuition','enjoyment'].every((key)=>Number.isInteger(input[key])&&input[key]>=1&&input[key]<=5); }

async function handleSession(request,response,pathname) {
  if (request.method==='GET' && pathname==='/api/session') return sendJson(response,200,{user:currentUser(request)});
  if (request.method==='POST' && pathname==='/api/session') {
    if (!sameOrigin(request)) return sendJson(response,403,{error:'same-origin request required'});
    const address=request.socket.remoteAddress||'unknown', now=Date.now(), attempts=loginAttempts.get(address)||[];
    const recent=attempts.filter((time)=>now-time<15*60*1000);
    if (recent.length>=12) return sendJson(response,429,{error:'too many login attempts'});
    const input=await readJson(request,16*1024);
    if (typeof input.accessCode!=='string'||input.accessCode.length>256) return sendJson(response,400,{error:'accessCode is required'});
    const supplied=createHash('sha256').update(input.accessCode).digest();
    let match=null;
    for (const candidate of codeCandidates) if (timingSafeEqual(candidate.hash,supplied)) match=candidate;
    if (!match) { recent.push(now); loginAttempts.set(address,recent); return sendJson(response,401,{error:'invalid invitation code'}); }
    loginAttempts.delete(address);
    const token=randomBytes(32).toString('base64url'), expires=Date.now()+SESSION_MS;
    createSession(tokenHash(token),match.member.id,expires);
    const secure=request.socket.encrypted || request.headers['x-forwarded-proto']==='https';
    const cookie=`${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS/1000)}${secure?'; Secure':''}`;
    return sendJson(response,200,{user:{id:match.member.id,name:match.member.name}},{'Set-Cookie':cookie});
  }
  if (request.method==='DELETE' && pathname==='/api/session') {
    if (!sameOrigin(request)) return sendJson(response,403,{error:'same-origin request required'});
    const token=cookies(request)[SESSION_COOKIE]; if (token) deleteSession(tokenHash(token));
    return sendJson(response,200,{user:null},{'Set-Cookie':`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`});
  }
  return null;
}

async function handleApi(request,response,pathname) {
  const sessionResult=await handleSession(request,response,pathname); if (sessionResult!==null) return;
  const user=currentUser(request); if (!user) return sendJson(response,401,{error:'authentication required'});
  if (['POST','PATCH','PUT','DELETE'].includes(request.method) && !sameOrigin(request)) return sendJson(response,403,{error:'same-origin request required'});
  if (request.method==='GET' && pathname==='/api/puzzles') return sendJson(response,200,{puzzles:getPuzzles(user.id)});
  if (request.method==='GET' && pathname==='/api/folders') return sendJson(response,200,{folders:getFolders()});
  if (request.method==='GET' && pathname==='/api/collections') return sendJson(response,200,{collections:getCollections()});
  if (request.method==='GET' && pathname==='/api/tags') return sendJson(response,200,{tags:getTags()});
  const collectionMatch=pathname.match(/^\/api\/collections\/(\d+)$/);
  if (request.method==='GET' && collectionMatch) { const collection=getCollection(Number(collectionMatch[1]),user.id); return collection?sendJson(response,200,{collection}):sendJson(response,404,{error:'collection not found'}); }

  if (request.method==='GET' && pathname==='/api/rules') return sendJson(response,200,{rules:getRules()});
  const ruleMatch=pathname.match(/^\/api\/rules\/(\d+)$/);
  if (request.method==='GET' && ruleMatch) { const rule=getRule(Number(ruleMatch[1])); return rule?sendJson(response,200,{rule}):sendJson(response,404,{error:'rule not found'}); }
  if (request.method==='POST' && pathname==='/api/rules') {
    const input=await readJson(request), error=validateRule(input); if (error) return sendJson(response,400,{error});
    const rule=addRule(input); return sendJson(response,201,{rule,rules:getRules()});
  }

  if (request.method==='GET' && pathname==='/api/calendar/puzzles') return sendJson(response,200,{puzzles:getCalendarPuzzles(user.id)});
  const calendarMatch=pathname.match(/^\/api\/calendar\/puzzles\/(\d+)$/);
  if (request.method==='GET' && calendarMatch) { const puzzle=getCalendarPuzzle(Number(calendarMatch[1]),user.id); return puzzle?sendJson(response,200,{puzzle}):sendJson(response,404,{error:'puzzle not found'}); }
  if (request.method==='POST' && pathname==='/api/calendar/puzzles') {
    const input=await readJson(request);
    if (!validText(input.title,200,true)||!validText(input.author,200,true)||!validText(input.source,120,true)||(input.url!==undefined&&!validText(input.url,3000))||(input.note!==undefined&&!validText(input.note,2000))||!['external','blank'].includes(input.inputMode)) return sendJson(response,400,{error:'invalid puzzle fields'});
    if (!getRule(Number(input.ruleId))) return sendJson(response,400,{error:'a valid ruleId is required'});
    if (input.inputMode==='external' && !parseTrustedPuzzleUrl(input.url)) return sendJson(response,400,{error:'only supported puzzle tool URLs are allowed'});
    if (!validDate(input.suggestedDate)) return sendJson(response,400,{error:'suggestedDate must be a real YYYY-MM-DD date or null'});
    if (input.inputMode==='blank' && !validText(input.answer||'',2000)) return sendJson(response,400,{error:'invalid answer'});
    const created=addCalendarPuzzle(input,user), puzzles=getCalendarPuzzles(user.id);
    return sendJson(response,201,{...created,puzzles});
  }
  const calendarRating=pathname.match(/^\/api\/calendar\/puzzles\/(\d+)\/complete-rating$/);
  if (request.method==='POST' && calendarRating) {
    const number=Number(calendarRating[1]); if (!calendarPuzzleExists(number)) return sendJson(response,404,{error:'puzzle not found'});
    const input=await readJson(request); if (!validateRatings(input)) return sendJson(response,400,{error:'ratings must be integers from 1 to 5'});
    completeAndRate(number,user.id,[input.logic,input.intuition,input.enjoyment],'calendar'); return sendJson(response,200,{puzzles:getCalendarPuzzles(user.id)});
  }
  const calendarTag=pathname.match(/^\/api\/calendar\/puzzles\/(\d+)\/tags$/);
  if (request.method==='POST' && calendarTag) {
    const number=Number(calendarTag[1]); if (!calendarPuzzleExists(number)) return sendJson(response,404,{error:'puzzle not found'});
    const input=await readJson(request); if (!validText(input.tag,40,true)) return sendJson(response,400,{error:'tag must be 1 to 40 characters'});
    addPuzzleTag(number,input.tag.trim(),'calendar'); return sendJson(response,200,{puzzles:getCalendarPuzzles(user.id)});
  }
  if (request.method==='PATCH' && calendarMatch) {
    const number=Number(calendarMatch[1]), input=await readJson(request);
    if (!validDate(input.suggestedDate)) return sendJson(response,400,{error:'suggestedDate must be a real YYYY-MM-DD date or null'});
    const result=updateCalendarSuggestedDate(number,user.id,input.suggestedDate||null);
    if (result.missing) return sendJson(response,404,{error:'puzzle not found'});
    if (result.forbidden) return sendJson(response,403,{error:'only the uploader may change suggestedDate'});
    return sendJson(response,200,{puzzle:result.puzzle,puzzles:getCalendarPuzzles(user.id)});
  }

  if (request.method==='POST' && pathname==='/api/puzzles') {
    const input=await readJson(request);
    if (!validText(input.title,200,true)||!validText(input.author||'',200)||!validText(input.source||'',120)||(input.url!==undefined&&!validText(input.url,3000))||(input.note!==undefined&&!validText(input.note,2000))||!['external','blank'].includes(input.inputMode)) return sendJson(response,400,{error:'invalid puzzle fields'});
    if (!getRule(Number(input.ruleId))) return sendJson(response,400,{error:'a valid ruleId is required'});
    if (input.inputMode==='external' && !parseTrustedPuzzleUrl(input.url)) return sendJson(response,400,{error:'only supported puzzle tool URLs are allowed'});
    const rule=getRule(Number(input.ruleId));
    input.type=rule.category; input.rules=rule.rulesZh.join('\n');
    const id=addPuzzle(input); return sendJson(response,201,{id,puzzles:getPuzzles(user.id)});
  }
  const ratingMatch=pathname.match(/^\/api\/puzzles\/(\d+)\/complete-rating$/);
  if (request.method==='POST' && ratingMatch) {
    const number=Number(ratingMatch[1]); if (!ensurePublicPuzzle(number)) return sendJson(response,404,{error:'puzzle not found'});
    const input=await readJson(request); if (!validateRatings(input)) return sendJson(response,400,{error:'ratings must be integers from 1 to 5'});
    completeAndRate(number,user.id,[input.logic,input.intuition,input.enjoyment]); return sendJson(response,200,{puzzles:getPuzzles(user.id)});
  }
  if (request.method==='POST' && pathname==='/api/folders') {
    const input=await readJson(request); if (!validText(input.name,120,true)) return sendJson(response,400,{error:'name is required'});
    const id=addFolder(input.name.trim(),input.parentId); return sendJson(response,201,{id,folders:getFolders()});
  }
  const tagMatch=pathname.match(/^\/api\/puzzles\/(\d+)\/tags$/);
  if (request.method==='POST' && tagMatch) {
    const number=Number(tagMatch[1]); if (!ensurePublicPuzzle(number)) return sendJson(response,404,{error:'puzzle not found'});
    const input=await readJson(request); if (!validText(input.tag,40,true)) return sendJson(response,400,{error:'tag must be 1 to 40 characters'});
    addPuzzleTag(number,input.tag.trim()); return sendJson(response,200,{puzzles:getPuzzles(user.id),tags:getTags()});
  }
  return sendJson(response,404,{error:'API route not found'});
}

function serveStatic(response,pathname) {
  const relative=pathname==='/'?'index.html':pathname.replace(/^\/+/,''), normalized=path.posix.normalize(relative);
  if (normalized!==relative || !allowedAssets.has(normalized)) return sendJson(response,404,{error:'Not found'});
  const filePath=path.join(rootDir,normalized);
  if (!fs.existsSync(filePath)||fs.statSync(filePath).isDirectory()) return sendJson(response,404,{error:'Not found'});
  response.writeHead(200,{'Content-Type':mimeTypes[path.extname(filePath)]||'application/octet-stream','Content-Security-Policy':contentSecurityPolicy,'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','X-Frame-Options':'SAMEORIGIN'});
  fs.createReadStream(filePath).pipe(response);
}
export function createServer() {
  return http.createServer(async(request,response)=>{
    try {
      const url=new URL(request.url,`http://${request.headers.host||'localhost'}`);
      if (url.pathname.startsWith('/api/')) return await handleApi(request,response,url.pathname);
      return serveStatic(response,url.pathname);
    } catch(error) {
      if (error.status) return sendJson(response,error.status,{error:error.message});
      console.error('Request failed:',error.message);
      return sendJson(response,500,{error:'Internal server error'});
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const host=process.env.HOST||'127.0.0.1';
  const server=createServer();
  server.listen(port,host,()=>console.log(`PuzArchive server listening at http://${host}:${server.address().port}`));
}
