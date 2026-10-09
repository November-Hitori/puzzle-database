import http from 'node:http';
import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  addCalendarPuzzle, addFolder, addPuzzle, addPuzzleTag, addRule, calendarPuzzleExists,
  authBootstrapComplete, bootstrapLegacyAuth, completeAndRate, createSession, deleteSession, findSession, findUserByUsernameKey, getCalendarPuzzle,
  getCalendarPuzzles, getCollection, getCollections, getFolders, getPuzzles, getRule,
  getRules, getTags, registerAccountWithGate, renameAccount, ruleHasVariants, submitRuleAudit, updateCalendarSuggestedDate,
  updateRule, deleteRule, deleteCalendarPuzzle, getCalendarLeftovers, completeCalendarReview,
  setQualityErrorIgnored, assignCalendarDate, submitCalendarPenpaAudit, updateCalendarPuzzle, updateCalendarPenpaLinks, getCalendarComments, addCalendarComment, reenterCalendarPuzzle, getInbox, markInboxNotificationRead, markAllInboxNotificationsRead
} from './db.mjs';
import { getPenpaGuidelines } from './penpa-guidelines.mjs';
import { normalizeCalendarLinks } from './calendar-workflow-policy.mjs';
import { getPuzzleSource, parseTrustedPuzzleUrl, TRUSTED_PUZZLE_FRAME_SOURCES } from './puzzle-url.mjs';
import { RULE_EXAMPLE_URL_MAX_LENGTH, validateRuleExampleUrl } from './rule-policy.mjs';
import { hashPassword, verifyPassword } from './password-hash.mjs';
import { normalizeUsername, validateAccountPassword } from './auth-policy.mjs';
import { CALENDAR_REVIEW_TAGS, CALENDAR_REVIEW_VOTES, CALENDAR_APPROVAL_NET_SUPPORT, normalizeCalendarReviewInput } from './calendar-review-policy.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(rootDir,'data');
const usersPath = process.env.PUZARCHIVE_USERS_PATH || path.join(dataDir,'trusted-users.json');
const port = Number(process.env.PORT || 4173);
const categories = new Set(['涂黑','填数','分区','置物','路径','其它']);
const mimeTypes = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml' };
const allowedAssets = new Set(['index.html','app.js','styles.css','puzzle-url.mjs','puzzle-tool-links.mjs','auth-policy.mjs','rule-policy.mjs','calendar-review-policy.mjs','calendar-workflow-policy.mjs']);
const contentSecurityPolicy = ["default-src 'self'","script-src 'self'","style-src 'self' 'unsafe-inline' https://fonts.googleapis.com","font-src 'self' https://fonts.gstatic.com","img-src 'self' data:","connect-src 'self'",`frame-src ${TRUSTED_PUZZLE_FRAME_SOURCES.join(' ')}`,"object-src 'none'","base-uri 'self'","form-action 'self'","frame-ancestors 'self'"].join('; ');
const SESSION_COOKIE='puzarchive_session';
const SESSION_MS=1000*60*60*24*14;
const loginAttempts=new Map();
const LOGIN_WINDOW_MS=15*60*1000;
const LOGIN_ATTEMPT_IP_LIMIT=5000;

function pruneLoginAttempts(now) {
  for (const [address,attempts] of loginAttempts) {
    const recent=attempts.filter((time)=>now-time<LOGIN_WINDOW_MS);
    if (recent.length) loginAttempts.set(address,recent);
    else loginAttempts.delete(address);
  }
  while (loginAttempts.size>=LOGIN_ATTEMPT_IP_LIMIT) loginAttempts.delete(loginAttempts.keys().next().value);
}
function reserveLoginAttempt(address,now=Date.now()) {
  pruneLoginAttempts(now);
  const recent=loginAttempts.get(address)||[];
  if (recent.length>=12) return false;
  recent.push(now);
  loginAttempts.set(address,recent);
  return true;
}

function migrateLegacyInvites() {
  const bootstrapComplete=authBootstrapComplete();
  if (bootstrapComplete) return;
  fs.mkdirSync(path.dirname(usersPath),{recursive:true});
  if (!fs.existsSync(usersPath)) {
    const member={id:randomUUID(),name:'Trusted Member',accessCode:randomBytes(18).toString('base64url')};
    fs.writeFileSync(usersPath,`${JSON.stringify([member],null,2)}\n`,{mode:0o600,flag:'wx'});
    try { fs.chmodSync(usersPath,0o600); } catch {}
  }
  const parsed=JSON.parse(fs.readFileSync(usersPath,'utf8'));
  if (!Array.isArray(parsed) || parsed.length!==1 || parsed.some((m)=>!m || typeof m.id!=='string' || !m.id || typeof m.name!=='string' || !m.name.trim() || typeof m.accessCode!=='string' || m.accessCode.length<16)) throw new Error(`Expected exactly one bootstrap member with a valid registration code in ${usersPath}`);
  const ids=new Set(),codes=new Set();
  const seeds=[];
  for (const member of parsed) {
    if (ids.has(member.id)||codes.has(member.accessCode)) throw new Error('Trusted member ids and invitation codes must be unique');
    ids.add(member.id); codes.add(member.accessCode);
    seeds.push({id:member.id,name:member.name.trim(),accessCodeHash:createHash('sha256').update(member.accessCode).digest('hex')});
  }
  bootstrapLegacyAuth(seeds);
}
migrateLegacyInvites();
const tokenHash=(token)=>createHash('sha256').update(token).digest('hex');
const cookies=(request)=>Object.fromEntries(String(request.headers.cookie||'').split(';').map((part)=>part.trim()).filter(Boolean).map((part)=>{const at=part.indexOf('=');return [part.slice(0,at),decodeURIComponent(part.slice(at+1))]}));
const dummyPasswordHash=hashPassword(randomBytes(32).toString('base64url'));
function currentUser(request) { const token=cookies(request)[SESSION_COOKIE]; return token ? findSession(tokenHash(token)) : null; }
function sendJson(response,status,payload,extra={}) {
  response.writeHead(status,{ 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin',...extra });
  response.end(JSON.stringify(payload));
}
async function readJson(request,limit=128*1024) {
  const chunks=[];
  let size=0;
  for await (const chunk of request) {
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=bytes.length;
    if (size>limit) throw Object.assign(new Error('request body too large'),{status:413});
    chunks.push(bytes);
  }
  if (size===0) return {};
  let body;
  try { body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)); }
  catch { throw Object.assign(new Error('request body must be UTF-8'),{status:400}); }
  try { const value=JSON.parse(body); if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw Object.assign(new Error('invalid JSON body'),{status:400}); }
}
function isLoopback(address) {
  return address === '::1' || /^127\./.test(address) || /^::ffff:127\./i.test(address);
}
function proxyContext(request, trustLoopbackProxy) {
  if (!trustLoopbackProxy || !isLoopback(request.socket.remoteAddress || '')) return null;
  const protocol=request.headers['x-forwarded-proto'];
  const address=request.headers['x-real-ip'];
  if ((protocol!=='http'&&protocol!=='https') || typeof address!=='string' || address.includes(',') || address.trim()!==address || isIP(address)===0) return null;
  return { protocol, address };
}
function sameOrigin(request, trustLoopbackProxy) {
  const origin=request.headers.origin;
  if (!origin) return false;
  try {
    const source=new URL(origin), proxy=proxyContext(request,trustLoopbackProxy);
    const protocol=proxy?.protocol || (request.socket.encrypted?'https':'http');
    return source.host.toLowerCase()===String(request.headers.host||'').toLowerCase() && source.protocol===`${protocol}:`;
  }
  catch { return false; }
}
function validText(value,max=300,required=false) { return typeof value==='string' && value.trim().length <= max && (!required || value.trim().length>0); }
function validDate(value) {
  if (value === null || value === '') return true;
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y,m,d]=value.split('-').map(Number); const dt=new Date(Date.UTC(y,m-1,d));
  return dt.getUTCFullYear()===y && dt.getUTCMonth()===m-1 && dt.getUTCDate()===d;
}
function normalizeCalendarDateFields(input) {
  const legacyDate=Object.hasOwn(input,'suggestedDate')&&input.suggestedDate!==null&&input.suggestedDate!==''?input.suggestedDate:null;
  if (legacyDate!==null&&!validDate(legacyDate)) return {error:'suggestedDate must be a real YYYY-MM-DD date or null'};
  const suggestedMonthDay=Object.hasOwn(input,'suggestedMonthDay')
    ? (input.suggestedMonthDay===null||input.suggestedMonthDay===''?'':input.suggestedMonthDay)
    : (legacyDate?legacyDate.slice(5):'');
  if (typeof suggestedMonthDay!=='string'||(suggestedMonthDay!==''&&!/^\d{2}-\d{2}$/.test(suggestedMonthDay))) return {error:'suggestedMonthDay must be MM-DD or empty'};
  const legacyYear=legacyDate?Number(legacyDate.slice(0,4)):null;
  const calendarYear=input.calendarYear===undefined?(legacyYear??2028):input.calendarYear;
  if (!Number.isInteger(calendarYear)||calendarYear<1000||calendarYear>9999) return {error:'calendarYear must be an integer from 1000 to 9999'};
  if (legacyYear!==null&&legacyYear!==calendarYear) return {error:'suggestedDate year must match calendarYear'};
  if (suggestedMonthDay&&!validDate(`${calendarYear}-${suggestedMonthDay}`)) return {error:'suggestedMonthDay is not a valid date in calendarYear'};
  return {value:{calendarYear,suggestedMonthDay,suggestedDate:suggestedMonthDay?`${calendarYear}-${suggestedMonthDay}`:null}};
}
function normalizeRuleInput(input,previous=null,ruleId=null) {
  const takeText=(key,max,fallback='')=>{
    const value=Object.hasOwn(input,key)?input[key]:(previous?.[key]??fallback);
    if (value===null&&key==='exampleUrl') return {value:''};
    if (!validText(value,max)) return {error:`invalid ${key}`};
    return {value:value.trim()};
  };
  const titleZh=takeText('titleZh',160),titleEn=takeText('titleEn',160),exampleUrl=takeText('exampleUrl',RULE_EXAMPLE_URL_MAX_LENGTH),exampleAuthor=takeText('exampleAuthor',200);
  if (titleZh.error||titleEn.error||exampleUrl.error||exampleAuthor.error) return {error:titleZh.error||titleEn.error||exampleUrl.error||exampleAuthor.error};
  if (!titleZh.value&&!titleEn.value) return {error:'at least one Chinese or English name is required'};
  const clauses={};
  for (const key of ['rulesZh','rulesEn']) {
    const value=Object.hasOwn(input,key)?input[key]:(previous?.[key]??[]);
    if (!Array.isArray(value)||value.length>30||value.some((clause)=>!validText(clause,1000))) return {error:`invalid ${key}`};
    clauses[key]=value.map((clause)=>clause.trim()).filter(Boolean);
  }
  const category=Object.hasOwn(input,'category')?input.category:(previous?.category??'');
  if (!categories.has(category)) return {error:'category is required'};
  let isVariant=Object.hasOwn(input,'isVariant')?input.isVariant:(previous?.isVariant??false);
  if (typeof isVariant!=='boolean') return {error:'isVariant must be boolean'};
  let baseRuleId=Object.hasOwn(input,'baseRuleId')?input.baseRuleId:(previous?.baseRuleId??null);
  if (input.isVariant===false&&!Object.hasOwn(input,'baseRuleId')) baseRuleId=null;
  if (!isVariant) {
    if (baseRuleId!==undefined&&baseRuleId!==null&&baseRuleId!=='') return {error:'original rules cannot have a base rule'};
    baseRuleId=null;
  } else if (baseRuleId!==undefined&&baseRuleId!==null&&baseRuleId!=='') {
    baseRuleId=Number(baseRuleId);
    const base=Number.isInteger(baseRuleId)?getRule(baseRuleId):null;
    if (!base||base.isVariant||baseRuleId===ruleId) return {error:'variant base must be an existing original rule'};
  } else baseRuleId=null;
  if (previous&&!previous.isVariant&&isVariant&&ruleHasVariants(ruleId)) return {error:'a rule used as another variant base cannot itself become a variant'};
  if (exampleUrl.value&&!validateRuleExampleUrl(exampleUrl.value)) return {error:'exampleUrl must be a concrete Penpa puzzle URL'};
  return {value:{titleZh:titleZh.value,titleEn:titleEn.value,...clauses,category,isVariant,baseRuleId,exampleUrl:exampleUrl.value,exampleAuthor:exampleAuthor.value}};
}
function ensurePublicPuzzle(number) { return Boolean(getPuzzles('scope-check').some((p)=>p.number===number)); }
function validateRatings(input) { return ['logic','intuition','enjoyment'].every((key)=>Number.isInteger(input[key])&&input[key]>=1&&input[key]<=5); }

function setSessionCookie(request,response,token,trustLoopbackProxy,status,user,maxAge=Math.floor(SESSION_MS/1000)) {
  const secure=request.socket.encrypted || proxyContext(request,trustLoopbackProxy)?.protocol==='https';
  const cookie=`${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?'; Secure':''}`;
  return sendJson(response,status,{user},{'Set-Cookie':cookie});
}
function authBusy(response) { return sendJson(response,503,{error:'authentication service is busy; retry shortly'},{'Retry-After':'2'}); }
function authAddress(request,trustLoopbackProxy) { return proxyContext(request,trustLoopbackProxy)?.address || request.socket.remoteAddress || 'unknown'; }

async function handleRegistration(request,response,pathname,trustLoopbackProxy) {
  if (request.method!=='POST' || pathname!=='/api/register') return null;
  if (!sameOrigin(request,trustLoopbackProxy)) return sendJson(response,403,{error:'same-origin request required'});
  const address=authAddress(request,trustLoopbackProxy);
  if (!reserveLoginAttempt(address)) return sendJson(response,429,{error:'too many authentication attempts'});
  const input=await readJson(request,16*1024);
  const normalized=normalizeUsername(input.username);
  if (!normalized) return sendJson(response,400,{error:'username must be 2–32 letters, numbers, underscores, or hyphens'});
  if (!validateAccountPassword(input.password)) return sendJson(response,400,{error:'password must be 12–128 characters and at most 512 UTF-8 bytes'});
  if (typeof input.inviteCode!=='string' || input.inviteCode.length<16 || input.inviteCode.length>256) return sendJson(response,400,{error:'invitation code is required'});

  let passwordHash;
  try { passwordHash=await hashPassword(input.password); }
  catch (error) { if (error.code==='PASSWORD_KDF_BUSY') return authBusy(response); throw error; }
  const token=randomBytes(32).toString('base64url');
  const result=registerAccountWithGate(tokenHash(input.inviteCode),normalized.username,normalized.key,passwordHash,tokenHash(token),Date.now()+SESSION_MS);
  if (result.error==='username') return sendJson(response,409,{error:'username is unavailable'});
  if (result.error) return sendJson(response,400,{error:'registration code is invalid'});
  loginAttempts.delete(address);
  return setSessionCookie(request,response,token,trustLoopbackProxy,201,result.user);
}

async function handleSession(request,response,pathname,trustLoopbackProxy) {
  if (request.method==='GET' && pathname==='/api/session') return sendJson(response,200,{user:currentUser(request)});
  if (request.method==='POST' && pathname==='/api/session') {
    if (!sameOrigin(request,trustLoopbackProxy)) return sendJson(response,403,{error:'same-origin request required'});
    const address=authAddress(request,trustLoopbackProxy);
    if (!reserveLoginAttempt(address)) return sendJson(response,429,{error:'too many authentication attempts'});
    const input=await readJson(request,16*1024), normalized=normalizeUsername(input.username);
    if (!normalized || !validateAccountPassword(input.password)) return sendJson(response,400,{error:'username and password are required'});
    const user=findUserByUsernameKey(normalized.key);
    let passwordHash;
    if (user?.active && user.passwordHash) passwordHash=user.passwordHash;
    else passwordHash=await dummyPasswordHash;
    let matches;
    try { matches=await verifyPassword(input.password,passwordHash); }
    catch (error) { if (error.code==='PASSWORD_KDF_BUSY') return authBusy(response); throw error; }
    if (!user || !user.active || !user.passwordHash || !matches) return sendJson(response,401,{error:'invalid username or password'});
    loginAttempts.delete(address);
    const token=randomBytes(32).toString('base64url'), expires=Date.now()+SESSION_MS;
    createSession(tokenHash(token),user.id,expires);
    return setSessionCookie(request,response,token,trustLoopbackProxy,200,{id:user.id,name:user.name,username:user.username});
  }
  if (request.method==='DELETE' && pathname==='/api/session') {
    if (!sameOrigin(request,trustLoopbackProxy)) return sendJson(response,403,{error:'same-origin request required'});
    const token=cookies(request)[SESSION_COOKIE]; if (token) deleteSession(tokenHash(token));
    const secure=request.socket.encrypted || proxyContext(request,trustLoopbackProxy)?.protocol==='https';
    return sendJson(response,200,{user:null},{'Set-Cookie':`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure?'; Secure':''}`});
  }
  return null;
}

async function handleApi(request,response,pathname,trustLoopbackProxy) {
  const registrationResult=await handleRegistration(request,response,pathname,trustLoopbackProxy); if (registrationResult!==null) return;
  const sessionResult=await handleSession(request,response,pathname,trustLoopbackProxy); if (sessionResult!==null) return;
  const user=currentUser(request); if (!user) return sendJson(response,401,{error:'authentication required'});
  if (['POST','PATCH','PUT','DELETE'].includes(request.method) && !sameOrigin(request,trustLoopbackProxy)) return sendJson(response,403,{error:'same-origin request required'});
  if (request.method==='PATCH' && pathname==='/api/account/username') {
    const input=await readJson(request,4096);
    const normalized=normalizeUsername(input.username);
    if (!normalized||!normalizeUsername(input.expectedUsername)||Object.keys(input).some(key=>!['username','expectedUsername'].includes(key))) return sendJson(response,400,{error:'用户名需为 2–32 个字符，可使用字母、数字、下划线和连字符；请提供当前用户名'});
    const result=renameAccount(user.id,normalized.username,normalized.key,input.expectedUsername);
    if (result.error==='inactive') return sendJson(response,401,{error:'authentication required'});
    if (result.error) return sendJson(response,409,{error:result.error==='duplicate'?'该用户名已被使用，请换一个':'用户名已变化，请刷新后重试',reason:result.error});
    return sendJson(response,200,result);
  }
  if (request.method==='GET' && pathname==='/api/puzzles') return sendJson(response,200,{puzzles:getPuzzles(user.id)});
  if (request.method==='GET' && pathname==='/api/folders') return sendJson(response,200,{folders:getFolders()});
  if (request.method==='GET' && pathname==='/api/collections') return sendJson(response,200,{collections:getCollections()});
  if (request.method==='GET' && pathname==='/api/tags') return sendJson(response,200,{tags:getTags()});
  const collectionMatch=pathname.match(/^\/api\/collections\/(\d+)$/);
  if (request.method==='GET' && collectionMatch) { const collection=getCollection(Number(collectionMatch[1]),user.id); return collection?sendJson(response,200,{collection}):sendJson(response,404,{error:'collection not found'}); }

  if (request.method==='GET' && pathname==='/api/rules') return sendJson(response,200,{rules:getRules(user.id)});
  if (request.method==='GET' && pathname==='/api/calendar/policy') return sendJson(response,200,{tags:CALENDAR_REVIEW_TAGS,votes:CALENDAR_REVIEW_VOTES,approvalNetSupport:CALENDAR_APPROVAL_NET_SUPPORT});
  if (request.method==='GET' && pathname==='/api/inbox') {
    const url=new URL(request.url,`http://${request.headers.host||'localhost'}`);
    const rawLimit=url.searchParams.get('limit'),rawBefore=url.searchParams.get('before');
    const limit=rawLimit===null?30:Number(rawLimit),before=rawBefore===null?null:Number(rawBefore);
    if (!Number.isInteger(limit)||limit<1||limit>50||(before!==null&&(!Number.isSafeInteger(before)||before<1))) return sendJson(response,400,{error:'invalid inbox cursor'});
    return sendJson(response,200,getInbox(user.id,{limit,before}));
  }
  if (request.method==='POST'&&pathname==='/api/inbox/read-all') {
    markAllInboxNotificationsRead(user.id);
    return sendJson(response,200,{read:true,...getInbox(user.id,{limit:1})});
  }
  const inboxReadMatch=pathname.match(/^\/api\/inbox\/(\d+)\/read$/);
  if (request.method==='POST'&&inboxReadMatch) {
    const id=Number(inboxReadMatch[1]);
    if (!Number.isSafeInteger(id)||id<1) return sendJson(response,404,{error:'notification not found'});
    if (!markInboxNotificationRead(user.id,id)) return sendJson(response,404,{error:'notification not found'});
    return sendJson(response,200,{read:true,...getInbox(user.id,{limit:1})});
  }
  const ruleMatch=pathname.match(/^\/api\/rules\/(\d+)$/);
  if (request.method==='GET' && ruleMatch) { const rule=getRule(Number(ruleMatch[1]),user.id); return rule?sendJson(response,200,{rule}):sendJson(response,404,{error:'rule not found'}); }
  if (request.method==='POST' && pathname==='/api/rules') {
    const input=await readJson(request), normalized=normalizeRuleInput(input);
    if (normalized.error) return sendJson(response,400,{error:normalized.error});
    const rule=addRule(normalized.value,user.id);
    if (rule.error==='invalid-base') return sendJson(response,409,{error:'variant base changed; reload before creating the rule'});
    return sendJson(response,201,{rule,rules:getRules(user.id)});
  }
  if (request.method==='DELETE'&&ruleMatch) {
    const id=Number(ruleMatch[1]),input=await readJson(request);
    if (!Number.isSafeInteger(id)||id<1) return sendJson(response,404,{error:'rule not found'});
    if (typeof input.deleteToken!=='string'||!input.deleteToken||!Number.isInteger(input.expectedEditVersion)||input.expectedEditVersion<1) return sendJson(response,400,{error:'deleteToken and expectedEditVersion are required'});
    const result=deleteRule(id,input.deleteToken,input.expectedEditVersion);
    if (result.error==='missing') return sendJson(response,404,{error:'rule not found'});
    if (result.error==='referenced') return sendJson(response,409,{error:'rule is still in use',reason:'referenced',references:result.references});
    if (result.error) return sendJson(response,409,{error:'rule changed; reload before deleting',reason:'stale'});
    return sendJson(response,200,{rules:getRules(user.id)});
  }
  if (request.method==='PATCH'&&ruleMatch) {
    const id=Number(ruleMatch[1]),input=await readJson(request),previous=getRule(id,user.id);
    if (!previous) return sendJson(response,404,{error:'rule not found'});
    const expected=input.expectedRevisions;
    if (!expected||typeof expected!=='object'||!Number.isInteger(input.expectedEditVersion)||input.expectedEditVersion<1||['name','description','example'].some((item)=>!Number.isInteger(expected[item])||expected[item]<1)) return sendJson(response,400,{error:'expectedEditVersion and expectedRevisions for name, description, and example are required'});
    expected.expectedEditVersion=input.expectedEditVersion;
    const fields={...input}; delete fields.expectedRevisions;
    const normalized=normalizeRuleInput(fields,previous,id);
    if (normalized.error) return sendJson(response,400,{error:normalized.error});
    const result=updateRule(id,normalized.value,user.id,expected);
    if (result.error==='missing') return sendJson(response,404,{error:'rule not found'});
    if (result.error==='invalid-base') return sendJson(response,409,{error:'variant base changed; reload before editing'});
    if (result.error==='has-variants') return sendJson(response,409,{error:'a rule used as another variant base cannot become a variant'});
    if (result.error) return sendJson(response,409,{error:'rule revisions changed; reload before editing'});
    return sendJson(response,200,{rule:result.rule,rules:getRules(user.id)});
  }
  const ignoreMatch=pathname.match(/^\/api\/(rules|calendar\/puzzles)\/(\d+)\/error-ignores$/);
  if (ignoreMatch&&request.method==='POST') {
    const input=await readJson(request);
    if (!validText(input.key,240,true)||!Number.isSafeInteger(input.revision)||input.revision<1||typeof input.ignored!=='boolean'||!validText(input.reason??'',500)) return sendJson(response,400,{error:'invalid error ignore fields'});
    const result=setQualityErrorIgnored(ignoreMatch[1]==='rules'?'rule':'puzzle',Number(ignoreMatch[2]),user.id,{...input,reason:(input.reason||'').trim()});
    if (result.error==='missing') return sendJson(response,404,{error:'entity not found'});
    if (result.error) return sendJson(response,409,{error:'quality error changed; reload before ignoring'});
    return sendJson(response,200,result);
  }
  const auditMatch=pathname.match(/^\/api\/rules\/(\d+)\/audits$/);
  if (request.method==='POST'&&auditMatch) {
    const input=await readJson(request),suggestion=input.suggestion===undefined?'':input.suggestion;
    if (!['name','description','example'].includes(input.item)||!['approve','reject'].includes(input.decision)||!Number.isInteger(input.revision)||input.revision<1||!validText(suggestion,2000)) return sendJson(response,400,{error:'invalid rule audit'});
    const result=submitRuleAudit(Number(auditMatch[1]),input.item,input.decision,suggestion.trim(),input.revision,user.id);
    if (result.error==='missing') return sendJson(response,404,{error:'rule not found'});
    if (result.error==='stale') return sendJson(response,409,{error:'rule revision changed; reload before auditing'});
    if (result.error==='incomplete') return sendJson(response,400,{error:'cannot approve an incomplete rule item'});
    if (result.error==='sticky'||result.error==='rejected') return sendJson(response,409,{error:'rejected item requires a content edit before further approval'});
    if (result.error) return sendJson(response,400,{error:'invalid rule audit'});
    return sendJson(response,200,{rule:result.rule});
  }

  if (request.method==='GET' && pathname==='/api/penpa-guidelines') return sendJson(response,200,getPenpaGuidelines());
  if (request.method==='GET' && pathname==='/api/calendar/puzzles') return sendJson(response,200,{puzzles:getCalendarPuzzles(user.id)});
  if (request.method==='GET' && pathname==='/api/calendar/leftovers') return sendJson(response,200,{puzzles:getCalendarLeftovers(user.id)});
  const calendarMatch=pathname.match(/^\/api\/calendar\/puzzles\/(\d+)$/);
  if (request.method==='GET' && calendarMatch) { const puzzle=getCalendarPuzzle(Number(calendarMatch[1]),user.id); return puzzle?sendJson(response,200,{puzzle}):sendJson(response,404,{error:'puzzle not found'}); }
  if (request.method==='POST' && pathname==='/api/calendar/puzzles') {
    const input=await readJson(request);
    if (!validText(input.title,200,true)||(input.author!==undefined&&!validText(input.author,200))||!validText(input.source,120,true)||(input.url!==undefined&&!validText(input.url,4096))||(input.note!==undefined&&!validText(input.note,2000))||!['external','blank'].includes(input.inputMode)) return sendJson(response,400,{error:'invalid puzzle fields'});
    if (!getRule(Number(input.ruleId))) return sendJson(response,400,{error:'a valid ruleId is required'});
    const links=normalizeCalendarLinks(input);
    if (links.error||(input.inputMode==='external'&&!links.value.url)) return sendJson(response,400,{error:links.error||'a solver link is required'});
    const dateFields=normalizeCalendarDateFields(input);
    if (dateFields.error) return sendJson(response,400,{error:dateFields.error});
    if (input.inputMode==='blank' && !validText(input.answer||'',2000)) return sendJson(response,400,{error:'invalid answer'});
    const author=(input.author===undefined||!input.author.trim())?(user.username||user.name):input.author.trim();
    const created=addCalendarPuzzle({...input,...links.value,author,...dateFields.value},user);
    if (created.error==='missing-rule') return sendJson(response,409,{error:'rule is no longer available; reload before submitting'});
    const puzzles=getCalendarPuzzles(user.id);
    return sendJson(response,201,{...created,puzzles});
  }
  const assignmentMatch=pathname.match(/^\/api\/calendar\/puzzles\/(\d+)\/assignment$/);
  const sharedPenpaMatch=pathname.match(/^\/api\/calendar\/puzzles\/(\d+)\/penpa-links$/);
  if (request.method==='PATCH' && sharedPenpaMatch) {
    const input=await readJson(request);
    if (!['penpaEditUrl','penpaSolveUrl'].some(key=>Object.hasOwn(input,key))
      ||Object.keys(input).some(key=>!['penpaEditUrl','penpaSolveUrl','expectedEditVersion','expectedReviewRound'].includes(key))
      ||!Number.isSafeInteger(input.expectedEditVersion)||input.expectedEditVersion<1
      ||!Number.isSafeInteger(input.expectedReviewRound)||input.expectedReviewRound<1) return sendJson(response,400,{error:'只可提交 Penpa 编辑或解题链接，并需提供当前题目版本'});
    for (const key of ['penpaEditUrl','penpaSolveUrl']) if (Object.hasOwn(input,key)&&!validText(input[key],4096)) return sendJson(response,400,{error:'invalid Penpa link'});
    const current=getCalendarPuzzle(Number(sharedPenpaMatch[1]),user.id);
    if (!current) return sendJson(response,404,{error:'puzzle not found'});
    if (current.calendarArea!=='allocation') return sendJson(response,409,{error:'只有待分配区题目允许共同补充 Penpa 链接'});
    const links=normalizeCalendarLinks({...input,inputMode:current.inputMode},current);
    if (links.error) return sendJson(response,400,{error:links.error});
    const result=updateCalendarPenpaLinks(Number(sharedPenpaMatch[1]),user.id,input);
    if (result.error==='forbidden') return sendJson(response,403,{error:'authentication required'});
    if (result.error) return sendJson(response,409,{error:'题目版本或所在区域已变化，请刷新后重试',reason:result.error});
    return sendJson(response,200,result);
  }
  if (assignmentMatch&&request.method==='POST') {
    const input=await readJson(request);
    if (!Object.hasOwn(input,'assignedDate')||!validDate(input.assignedDate)||!Number.isSafeInteger(input.expectedEditVersion)||input.expectedEditVersion<1||!Number.isSafeInteger(input.expectedReviewRound)||input.expectedReviewRound<1) return sendJson(response,400,{error:'a valid assignedDate and current versions are required'});
    const result=assignCalendarDate(Number(assignmentMatch[1]),user.id,input);
    if (result.error==='missing') return sendJson(response,404,{error:'puzzle not found'});
    if (result.error==='wrong-year') return sendJson(response,400,{error:'assigned date must match the puzzle year'});
    if (result.error) return sendJson(response,409,{error:result.error==='occupied'?'该日期已被其他题目占用':result.error==='not-approved'?'题目尚未取得三票净支持':'题目版本已变化，请刷新后分配',reason:result.error});
    return sendJson(response,200,result);
  }
  const penpaAuditMatch=pathname.match(/^\/api\/calendar\/puzzles\/(\d+)\/penpa-audits$/);
  if (penpaAuditMatch&&request.method==='POST') {
    const input=await readJson(request);
    if (!['approve','reject'].includes(input.decision)||!Number.isSafeInteger(input.revision)||input.revision<1||!validText(input.guidelinesRevision,64,true)||!validText(input.suggestion??'',2000)) return sendJson(response,400,{error:'invalid Penpa audit fields'});
    const result=submitCalendarPenpaAudit(Number(penpaAuditMatch[1]),user.id,{...input,suggestion:(input.suggestion||'').trim()});
    if (result.error==='missing') return sendJson(response,404,{error:'puzzle not found'});
    if (result.error) return sendJson(response,['guidelines-missing','incomplete'].includes(result.error)?400:409,{error:result.error==='incomplete'?'请补齐或明确忽略缺少的 Penpa 链接后再审计':result.error==='rejected'?'制图审计已被打回，请先修改 Penpa 链接':result.error==='guidelines-missing'?'制图规范正文尚未提供':'制图版本或题目状态已变化，请刷新后重新审核',reason:result.error});
    return sendJson(response,200,result);
  }
  const calendarComments=pathname.match(/^\/api\/calendar\/puzzles\/(\d+)\/comments$/);
  if (calendarComments&&request.method==='GET') {
    const result=getCalendarComments(Number(calendarComments[1]),user.id,new URL(request.url,'http://localhost').searchParams.get('reveal')==='1');
    return result.error?sendJson(response,404,{error:'puzzle not found'}):sendJson(response,200,result);
  }
  if (calendarComments&&request.method==='POST') {
    const input=await readJson(request);
    if (!validText(input.body,2000,true)) return sendJson(response,400,{error:'comment must be 1 to 2000 characters'});
    const result=addCalendarComment(Number(calendarComments[1]),user.id,input.body.trim());
    return result.error?sendJson(response,404,{error:'puzzle not found'}):sendJson(response,201,result);
  }
  const calendarRating=pathname.match(/^\/api\/calendar\/puzzles\/(\d+)\/complete-rating$/);
  if (request.method==='POST' && calendarRating) {
    const number=Number(calendarRating[1]);
    if (!Number.isSafeInteger(number)||number<1||!calendarPuzzleExists(number)) return sendJson(response,404,{error:'puzzle not found'});
    const input=await readJson(request),normalized=normalizeCalendarReviewInput(input);
    if (normalized.error) return sendJson(response,400,{error:'difficulty, tags, vote, and expectedReviewRound are required and must be valid'});
    const result=completeCalendarReview(number,user.id,normalized.value);
    if(result.error==='missing') return sendJson(response,404,{error:'puzzle not found'});
    if(result.error==='stale-round') return sendJson(response,409,{error:'review round changed; reload the puzzle'});
    if(result.error==='reentry-required') return sendJson(response,409,{error:'puzzle needs explicit reentry before another review round'});
    if(result.error==='veto-locked') return sendJson(response,409,{error:'a veto is final for this review round'});
    if(result.error) return sendJson(response,401,{error:'active member session required'});
    return sendJson(response,200,{puzzle:result.puzzle});
  }
  const calendarReenter=pathname.match(/^\/api\/calendar\/puzzles\/(\d+)\/reenter$/);
  if(request.method==='POST'&&calendarReenter){
    const number=Number(calendarReenter[1]),input=await readJson(request);
    if(!Number.isSafeInteger(number)||number<1||!Number.isSafeInteger(input.expectedReviewRound)||input.expectedReviewRound<1) return sendJson(response,400,{error:'expectedReviewRound is required'});
    const result=reenterCalendarPuzzle(number,user.id,input.expectedReviewRound);
    if(result.error==='missing') return sendJson(response,404,{error:'puzzle not found'});
    if(result.error==='stale-round') return sendJson(response,409,{error:'review round changed; reload before reentry'});
    if(result.error==='not-leftover') return sendJson(response,409,{error:'only leftover puzzles can be reentered'});
    return sendJson(response,200,{puzzle:result.puzzle});
  }
  const calendarTag=pathname.match(/^\/api\/calendar\/puzzles\/(\d+)\/tags$/);
  if (request.method==='POST' && calendarTag) {
    const number=Number(calendarTag[1]); if (!calendarPuzzleExists(number)) return sendJson(response,404,{error:'puzzle not found'});
    const input=await readJson(request); if (!validText(input.tag,40,true)) return sendJson(response,400,{error:'tag must be 1 to 40 characters'});
    addPuzzleTag(number,input.tag.trim(),'calendar'); return sendJson(response,200,{puzzles:getCalendarPuzzles(user.id)});
  }
  if (request.method==='PATCH' && calendarMatch) {
    const number=Number(calendarMatch[1]), input=await readJson(request);
    if (['title','url','clearReviews','penpaEditUrl','penpaSolveUrl','puzzlinkUrl'].some((field)=>Object.hasOwn(input,field))) {
      const current=getCalendarPuzzle(number,user.id);
      if (!current) return sendJson(response,404,{error:'puzzle not found'});
      if (!validText(input.title??current.title,200,true)||(input.url!==undefined&&!validText(input.url,4096))||(input.clearReviews!==undefined&&typeof input.clearReviews!=='boolean')
        ||!Number.isSafeInteger(input.expectedEditVersion)||input.expectedEditVersion<1
        ||!Number.isSafeInteger(input.expectedReviewRound)||input.expectedReviewRound<1) return sendJson(response,400,{error:'invalid puzzle edit fields'});
      const links=normalizeCalendarLinks({...input,inputMode:current.inputMode},current);
      if (links.error||(current.inputMode==='external'&&!links.value.url)) return sendJson(response,400,{error:links.error||'a solver link is required'});
      const result=updateCalendarPuzzle(number,user.id,{...input,...links.value,title:input.title??current.title,source:current.inputMode==='blank'?current.source:getPuzzleSource(links.value.url)});
      if (result.error==='forbidden') return sendJson(response,403,{error:'only the uploader may edit the puzzle'});
      if (result.error) return sendJson(response,409,{error:'puzzle changed; reload before editing'});
      return sendJson(response,200,{puzzle:result.puzzle});
    }
    if (!Object.hasOwn(input,'suggestedDate')&&!Object.hasOwn(input,'suggestedMonthDay')&&!Object.hasOwn(input,'calendarYear')) return sendJson(response,400,{error:'calendarYear or suggestedMonthDay is required'});
    const currentPuzzle=getCalendarPuzzle(number,user.id);
    if(!currentPuzzle) return sendJson(response,404,{error:'puzzle not found'});
    const dateInput={...input};
    if(dateInput.calendarYear===undefined&&dateInput.suggestedDate===null) dateInput.calendarYear=currentPuzzle.calendarYear;
    if(dateInput.calendarYear===undefined&&dateInput.suggestedDate===undefined) dateInput.calendarYear=currentPuzzle.calendarYear;
    const dateFields=normalizeCalendarDateFields(dateInput);
    if (dateFields.error) return sendJson(response,400,{error:dateFields.error});
    const result=updateCalendarSuggestedDate(number,user.id,dateFields.value.calendarYear,dateFields.value.suggestedDate);
    if (result.missing) return sendJson(response,404,{error:'puzzle not found'});
    if (result.forbidden) return sendJson(response,403,{error:'only the uploader may change suggestedDate'});
    return sendJson(response,200,{puzzle:result.puzzle});
  }
  if (request.method==='DELETE' && calendarMatch) {
    const number=Number(calendarMatch[1]);
    if (!Number.isSafeInteger(number)||number<1) return sendJson(response,404,{error:'puzzle not found'});
    const input=await readJson(request);
    if (typeof input.deleteToken!=='string'||!input.deleteToken) return sendJson(response,400,{error:'deleteToken is required'});
    const result=deleteCalendarPuzzle(number,user.id,input.deleteToken);
    if (result.error==='missing') return sendJson(response,404,{error:'puzzle not found'});
    if (result.error==='forbidden') return sendJson(response,403,{error:'only the uploader may delete this puzzle'});
    if (result.error) return sendJson(response,409,{error:'puzzle changed; reload before deleting',reason:'stale'});
    return sendJson(response,200,{puzzles:getCalendarPuzzles(user.id)});
  }

  if (request.method==='POST' && pathname==='/api/puzzles') {
    const input=await readJson(request);
    if (!validText(input.title,200,true)||!validText(input.author||'',200)||!validText(input.source||'',120)||(input.url!==undefined&&!validText(input.url,3000))||(input.note!==undefined&&!validText(input.note,2000))||!['external','blank'].includes(input.inputMode)) return sendJson(response,400,{error:'invalid puzzle fields'});
    if (!getRule(Number(input.ruleId))) return sendJson(response,400,{error:'a valid ruleId is required'});
    if (input.inputMode==='external' && !parseTrustedPuzzleUrl(input.url)) return sendJson(response,400,{error:'only supported puzzle tool URLs are allowed'});
    const rule=getRule(Number(input.ruleId));
    input.type=rule.category; input.rules=rule.rulesZh.join('\n');
    const id=addPuzzle(input);
    if (id?.error==='missing-rule') return sendJson(response,409,{error:'rule is no longer available; reload before submitting'});
    return sendJson(response,201,{id,puzzles:getPuzzles(user.id)});
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
export function createServer({trustLoopbackProxy=process.env.PUZARCHIVE_TRUST_LOOPBACK_PROXY==='true'}={}) {
  return http.createServer(async(request,response)=>{
    try {
      const url=new URL(request.url,`http://${request.headers.host||'localhost'}`);
      if (url.pathname.startsWith('/api/')) return await handleApi(request,response,url.pathname,trustLoopbackProxy);
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
