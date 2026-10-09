import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { hashPassword, verifyPassword } from '../policy/password-hash.mjs';
import { normalizeUsername, validateAccountPassword } from '../policy/auth-policy.mjs';
import { CALENDAR_APPROVAL_NET_SUPPORT, CALENDAR_REVIEW_TAGS, CALENDAR_REVIEW_VOTES, normalizeCalendarReviewInput } from '../policy/calendar-review-policy.mjs';
import { RULE_EXAMPLE_URL_MAX_LENGTH, validateRuleExampleUrl } from '../policy/rule-policy.mjs';
import { parseTrustedPuzzleUrl } from '../puzzle-url.mjs';

const SESSION_COOKIE = 'puzarchive_session';
const SESSION_MS = 1000 * 60 * 60 * 24 * 14;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_IP_LIMIT = 5000;
const categories = new Set(['涂黑', '填数', '分区', '置物', '路径', '其它']);
const loginAttempts = new Map();
let dummyPasswordHashPromise;

async function getDatabase() {
  return import('./database.js');
}

function usersPath() {
  return process.env.PUZARCHIVE_USERS_PATH || path.join(process.cwd(), 'data', 'next', 'trusted-users.json');
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function pruneLoginAttempts(now) {
  for (const [address, attempts] of loginAttempts) {
    const recent = attempts.filter((time) => now - time < LOGIN_WINDOW_MS);
    if (recent.length) loginAttempts.set(address, recent);
    else loginAttempts.delete(address);
  }
  while (loginAttempts.size >= LOGIN_ATTEMPT_IP_LIMIT) loginAttempts.delete(loginAttempts.keys().next().value);
}

function reserveLoginAttempt(address, now = Date.now()) {
  pruneLoginAttempts(now);
  const recent = loginAttempts.get(address) || [];
  if (recent.length >= 12) return false;
  recent.push(now);
  loginAttempts.set(address, recent);
  return true;
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const source = new URL(origin);
    const forwardedHost = request.headers.get('x-forwarded-host');
    const host = forwardedHost || request.headers.get('host');
    const protocol = request.headers.get('x-forwarded-proto') || new URL(request.url).protocol.replace(':', '');
    return source.host.toLowerCase() === String(host || '').toLowerCase() && source.protocol === `${protocol}:`;
  } catch {
    return false;
  }
}

function authAddress(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  return request.headers.get('x-real-ip') || (forwarded ? forwarded.split(',')[0].trim() : 'unknown');
}

function readCookie(request, name) {
  return request.cookies.get(name)?.value || null;
}

function currentUser(request, database) {
  const token = readCookie(request, SESSION_COOKIE);
  return token ? database.findSession(tokenHash(token)) : null;
}

function sendJson(payload, status = 200) {
  const response = NextResponse.json(payload, { status });
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}

async function readJson(request) {
  try {
    const value = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    return {};
  }
}

function validText(value, max = 300, required = false) {
  return typeof value === 'string' && value.trim().length <= max && (!required || value.trim().length > 0);
}

function validDate(value) {
  if (value === null || value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeCalendarDateFields(input) {
  const legacyDate = Object.hasOwn(input, 'suggestedDate') && input.suggestedDate !== null && input.suggestedDate !== '' ? input.suggestedDate : null;
  if (legacyDate !== null && !validDate(legacyDate)) return { error: 'suggestedDate must be a real YYYY-MM-DD date or null' };
  const suggestedMonthDay = Object.hasOwn(input, 'suggestedMonthDay')
    ? (input.suggestedMonthDay === null || input.suggestedMonthDay === '' ? '' : input.suggestedMonthDay)
    : (legacyDate ? legacyDate.slice(5) : '');
  if (typeof suggestedMonthDay !== 'string' || (suggestedMonthDay !== '' && !/^\d{2}-\d{2}$/.test(suggestedMonthDay))) return { error: 'suggestedMonthDay must be MM-DD or empty' };
  const legacyYear = legacyDate ? Number(legacyDate.slice(0, 4)) : null;
  const calendarYear = input.calendarYear === undefined ? (legacyYear ?? 2028) : input.calendarYear;
  if (!Number.isInteger(calendarYear) || calendarYear < 1000 || calendarYear > 9999) return { error: 'calendarYear must be an integer from 1000 to 9999' };
  if (legacyYear !== null && legacyYear !== calendarYear) return { error: 'suggestedDate year must match calendarYear' };
  if (suggestedMonthDay && !validDate(`${calendarYear}-${suggestedMonthDay}`)) return { error: 'suggestedMonthDay is not a valid date in calendarYear' };
  return { value: { calendarYear, suggestedMonthDay, suggestedDate: suggestedMonthDay ? `${calendarYear}-${suggestedMonthDay}` : null } };
}

function normalizeRuleInput(database, input, previous = null, ruleId = null) {
  const takeText = (key, max, fallback = '') => {
    const value = Object.hasOwn(input, key) ? input[key] : (previous?.[key] ?? fallback);
    if (value === null && key === 'exampleUrl') return { value: '' };
    if (!validText(value, max)) return { error: `invalid ${key}` };
    return { value: value.trim() };
  };
  const titleZh = takeText('titleZh', 160);
  const titleEn = takeText('titleEn', 160);
  const exampleUrl = takeText('exampleUrl', RULE_EXAMPLE_URL_MAX_LENGTH);
  const exampleAuthor = takeText('exampleAuthor', 200);
  if (titleZh.error || titleEn.error || exampleUrl.error || exampleAuthor.error) return { error: titleZh.error || titleEn.error || exampleUrl.error || exampleAuthor.error };
  if (!titleZh.value && !titleEn.value) return { error: 'at least one Chinese or English name is required' };
  const clauses = {};
  for (const key of ['rulesZh', 'rulesEn']) {
    const value = Object.hasOwn(input, key) ? input[key] : (previous?.[key] ?? []);
    if (!Array.isArray(value) || value.length > 30 || value.some((clause) => !validText(clause, 1000))) return { error: `invalid ${key}` };
    clauses[key] = value.map((clause) => clause.trim()).filter(Boolean);
  }
  const category = Object.hasOwn(input, 'category') ? input.category : (previous?.category ?? '');
  if (!categories.has(category)) return { error: 'category is required' };
  let isVariant = Object.hasOwn(input, 'isVariant') ? input.isVariant : (previous?.isVariant ?? false);
  if (typeof isVariant !== 'boolean') return { error: 'isVariant must be boolean' };
  let baseRuleId = Object.hasOwn(input, 'baseRuleId') ? input.baseRuleId : (previous?.baseRuleId ?? null);
  if (input.isVariant === false && !Object.hasOwn(input, 'baseRuleId')) baseRuleId = null;
  if (!isVariant) {
    if (baseRuleId !== undefined && baseRuleId !== null && baseRuleId !== '') return { error: 'original rules cannot have a base rule' };
    baseRuleId = null;
  } else if (baseRuleId !== undefined && baseRuleId !== null && baseRuleId !== '') {
    baseRuleId = Number(baseRuleId);
    const base = Number.isInteger(baseRuleId) ? database.getRule(baseRuleId) : null;
    if (!base || base.isVariant || baseRuleId === ruleId) return { error: 'variant base must be an existing original rule' };
  } else baseRuleId = null;
  if (previous && !previous.isVariant && isVariant && database.ruleHasVariants(ruleId)) return { error: 'a rule used as another variant base cannot itself become a variant' };
  if (exampleUrl.value && !validateRuleExampleUrl(exampleUrl.value)) return { error: 'exampleUrl must be a concrete Penpa puzzle URL' };
  return { value: { titleZh: titleZh.value, titleEn: titleEn.value, ...clauses, category, isVariant, baseRuleId, exampleUrl: exampleUrl.value, exampleAuthor: exampleAuthor.value } };
}

async function ensureAuthBootstrap(database) {
  if (database.authBootstrapComplete()) return;
  const target = usersPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(/* turbopackIgnore: true */ target)) {
    const member = { id: randomUUID(), name: 'Trusted Member', accessCode: randomBytes(18).toString('base64url') };
    fs.writeFileSync(target, `${JSON.stringify([member], null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(target, 0o600); } catch {}
  }
  const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ target, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed.some((member) => !member || typeof member.id !== 'string' || !member.id || typeof member.name !== 'string' || !member.name.trim() || typeof member.accessCode !== 'string' || member.accessCode.length < 16)) {
    throw new Error(`Expected exactly one bootstrap member with a valid registration code in ${target}`);
  }
  const seeds = parsed.map((member) => ({ id: member.id, name: member.name.trim(), accessCodeHash: createHash('sha256').update(member.accessCode).digest('hex') }));
  database.bootstrapLegacyAuth(seeds);
}

async function dummyHash() {
  dummyPasswordHashPromise ||= hashPassword(randomBytes(32).toString('base64url'));
  return dummyPasswordHashPromise;
}

function setSessionCookie(request, token, status, user, maxAge = Math.floor(SESSION_MS / 1000)) {
  const response = sendJson({ user }, status);
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: new URL(request.url).protocol === 'https:',
    path: '/',
    maxAge
  });
  return response;
}

async function handleRegistration(request, pathname, database) {
  if (request.method !== 'POST' || pathname !== '/api/register') return null;
  if (!sameOrigin(request)) return sendJson({ error: 'same-origin request required' }, 403);
  const address = authAddress(request);
  if (!reserveLoginAttempt(address)) return sendJson({ error: 'too many authentication attempts' }, 429);
  const input = await readJson(request);
  const normalized = normalizeUsername(input.username);
  if (!normalized) return sendJson({ error: 'username must be 2–32 letters, numbers, underscores, or hyphens' }, 400);
  if (!validateAccountPassword(input.password)) return sendJson({ error: 'password must be 12–128 characters and at most 512 UTF-8 bytes' }, 400);
  if (typeof input.inviteCode !== 'string' || input.inviteCode.length < 16 || input.inviteCode.length > 256) return sendJson({ error: 'invitation code is required' }, 400);
  let passwordHash;
  try { passwordHash = await hashPassword(input.password); }
  catch (error) { if (error.code === 'PASSWORD_KDF_BUSY') return sendJson({ error: 'authentication service is busy; retry shortly' }, 503); throw error; }
  const token = randomBytes(32).toString('base64url');
  const result = database.registerAccountWithGate(tokenHash(input.inviteCode), normalized.username, normalized.key, passwordHash, tokenHash(token), Date.now() + SESSION_MS);
  if (result.error === 'username') return sendJson({ error: 'username is unavailable' }, 409);
  if (result.error) return sendJson({ error: 'registration code is invalid' }, 400);
  loginAttempts.delete(address);
  return setSessionCookie(request, token, 201, result.user);
}

async function handleSession(request, pathname, database) {
  if (request.method === 'GET' && pathname === '/api/session') return sendJson({ user: currentUser(request, database) });
  if (request.method === 'POST' && pathname === '/api/session') {
    if (!sameOrigin(request)) return sendJson({ error: 'same-origin request required' }, 403);
    const address = authAddress(request);
    if (!reserveLoginAttempt(address)) return sendJson({ error: 'too many authentication attempts' }, 429);
    const input = await readJson(request);
    const normalized = normalizeUsername(input.username);
    if (!normalized || !validateAccountPassword(input.password)) return sendJson({ error: 'username and password are required' }, 400);
    const user = database.findUserByUsernameKey(normalized.key);
    let storedHash;
    if (user?.active && user.passwordHash) storedHash = user.passwordHash;
    else storedHash = await dummyHash();
    let matches;
    try { matches = await verifyPassword(input.password, storedHash); }
    catch (error) { if (error.code === 'PASSWORD_KDF_BUSY') return sendJson({ error: 'authentication service is busy; retry shortly' }, 503); throw error; }
    if (!user || !user.active || !user.passwordHash || !matches) return sendJson({ error: 'invalid username or password' }, 401);
    loginAttempts.delete(address);
    const token = randomBytes(32).toString('base64url');
    database.createSession(tokenHash(token), user.id, Date.now() + SESSION_MS);
    return setSessionCookie(request, token, 200, { id: user.id, name: user.name, username: user.username });
  }
  if (request.method === 'DELETE' && pathname === '/api/session') {
    if (!sameOrigin(request)) return sendJson({ error: 'same-origin request required' }, 403);
    const token = readCookie(request, SESSION_COOKIE);
    if (token) database.deleteSession(tokenHash(token));
    const response = sendJson({ user: null });
    response.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'strict', secure: new URL(request.url).protocol === 'https:', path: '/', maxAge: 0 });
    return response;
  }
  return null;
}

export async function handleApiRequest(request) {
  const database = await getDatabase();
  await ensureAuthBootstrap(database);
  const pathname = new URL(request.url).pathname;
  const registration = await handleRegistration(request, pathname, database);
  if (registration) return registration;
  const session = await handleSession(request, pathname, database);
  if (session) return session;

  const user = currentUser(request, database);
  if (!user) return sendJson({ error: 'authentication required' }, 401);
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) && !sameOrigin(request)) return sendJson({ error: 'same-origin request required' }, 403);

  if (request.method === 'GET' && pathname === '/api/puzzles') return sendJson({ puzzles: database.getPuzzles(user.id) });
  if (request.method === 'GET' && pathname === '/api/folders') return sendJson({ folders: database.getFolders() });
  if (request.method === 'GET' && pathname === '/api/collections') return sendJson({ collections: database.getCollections() });
  if (request.method === 'GET' && pathname === '/api/tags') return sendJson({ tags: database.getTags() });
  const collectionMatch = pathname.match(/^\/api\/collections\/(\d+)$/);
  if (request.method === 'GET' && collectionMatch) {
    const collection = database.getCollection(Number(collectionMatch[1]), user.id);
    return collection ? sendJson({ collection }) : sendJson({ error: 'collection not found' }, 404);
  }

  if (request.method === 'GET' && pathname === '/api/rules') return sendJson({ rules: database.getRules(user.id) });
  if (request.method === 'GET' && pathname === '/api/calendar/policy') return sendJson({ tags: CALENDAR_REVIEW_TAGS, votes: CALENDAR_REVIEW_VOTES, approvalNetSupport: CALENDAR_APPROVAL_NET_SUPPORT });
  if (request.method === 'GET' && pathname === '/api/inbox') {
    const url = new URL(request.url);
    const rawLimit = url.searchParams.get('limit');
    const rawBefore = url.searchParams.get('before');
    const limit = rawLimit === null ? 30 : Number(rawLimit);
    const before = rawBefore === null ? null : Number(rawBefore);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (before !== null && (!Number.isSafeInteger(before) || before < 1))) return sendJson({ error: 'invalid inbox cursor' }, 400);
    return sendJson(database.getInbox(user.id, { limit, before }));
  }
  if (request.method === 'POST' && pathname === '/api/inbox/read-all') {
    database.markAllInboxNotificationsRead(user.id);
    return sendJson({ read: true, ...database.getInbox(user.id, { limit: 1 }) });
  }
  const inboxReadMatch = pathname.match(/^\/api\/inbox\/(\d+)\/read$/);
  if (request.method === 'POST' && inboxReadMatch) {
    const id = Number(inboxReadMatch[1]);
    if (!Number.isSafeInteger(id) || id < 1 || !database.markInboxNotificationRead(user.id, id)) return sendJson({ error: 'notification not found' }, 404);
    return sendJson({ read: true, ...database.getInbox(user.id, { limit: 1 }) });
  }

  const ruleMatch = pathname.match(/^\/api\/rules\/(\d+)$/);
  if (request.method === 'GET' && ruleMatch) {
    const rule = database.getRule(Number(ruleMatch[1]), user.id);
    return rule ? sendJson({ rule }) : sendJson({ error: 'rule not found' }, 404);
  }
  if (request.method === 'POST' && pathname === '/api/rules') {
    const normalized = normalizeRuleInput(database, await readJson(request));
    if (normalized.error) return sendJson({ error: normalized.error }, 400);
    const rule = database.addRule(normalized.value, user.id);
    if (rule.error === 'invalid-base') return sendJson({ error: 'variant base changed; reload before creating the rule' }, 409);
    return sendJson({ rule, rules: database.getRules(user.id) }, 201);
  }
  if (request.method === 'DELETE' && ruleMatch) {
    const id = Number(ruleMatch[1]);
    const input = await readJson(request);
    if (!Number.isSafeInteger(id) || id < 1) return sendJson({ error: 'rule not found' }, 404);
    if (typeof input.deleteToken !== 'string' || !input.deleteToken || !Number.isInteger(input.expectedEditVersion) || input.expectedEditVersion < 1) return sendJson({ error: 'deleteToken and expectedEditVersion are required' }, 400);
    const result = database.deleteRule(id, input.deleteToken, input.expectedEditVersion);
    if (result.error === 'missing') return sendJson({ error: 'rule not found' }, 404);
    if (result.error === 'referenced') return sendJson({ error: 'rule is still in use', reason: 'referenced', references: result.references }, 409);
    if (result.error) return sendJson({ error: 'rule changed; reload before deleting', reason: 'stale' }, 409);
    return sendJson({ rules: database.getRules(user.id) });
  }
  if (request.method === 'PATCH' && ruleMatch) {
    const id = Number(ruleMatch[1]);
    const input = await readJson(request);
    const previous = database.getRule(id, user.id);
    if (!previous) return sendJson({ error: 'rule not found' }, 404);
    const expected = input.expectedRevisions;
    if (!expected || typeof expected !== 'object' || !Number.isInteger(input.expectedEditVersion) || input.expectedEditVersion < 1 || ['name', 'description', 'example'].some((item) => !Number.isInteger(expected[item]) || expected[item] < 1)) return sendJson({ error: 'expectedEditVersion and expectedRevisions for name, description, and example are required' }, 400);
    expected.expectedEditVersion = input.expectedEditVersion;
    const fields = { ...input };
    delete fields.expectedRevisions;
    const normalized = normalizeRuleInput(database, fields, previous, id);
    if (normalized.error) return sendJson({ error: normalized.error }, 400);
    const result = database.updateRule(id, normalized.value, user.id, expected);
    if (result.error === 'missing') return sendJson({ error: 'rule not found' }, 404);
    if (result.error === 'invalid-base') return sendJson({ error: 'variant base changed; reload before editing' }, 409);
    if (result.error === 'has-variants') return sendJson({ error: 'a rule used as another variant base cannot become a variant' }, 409);
    if (result.error) return sendJson({ error: 'rule revisions changed; reload before editing' }, 409);
    return sendJson({ rule: result.rule, rules: database.getRules(user.id) });
  }
  const auditMatch = pathname.match(/^\/api\/rules\/(\d+)\/audits$/);
  if (request.method === 'POST' && auditMatch) {
    const input = await readJson(request);
    const suggestion = input.suggestion === undefined ? '' : input.suggestion;
    if (!['name', 'description', 'example'].includes(input.item) || !['approve', 'reject'].includes(input.decision) || !Number.isInteger(input.revision) || input.revision < 1 || !validText(suggestion, 2000)) return sendJson({ error: 'invalid rule audit' }, 400);
    const result = database.submitRuleAudit(Number(auditMatch[1]), input.item, input.decision, suggestion.trim(), input.revision, user.id);
    if (result.error === 'missing') return sendJson({ error: 'rule not found' }, 404);
    if (result.error === 'stale') return sendJson({ error: 'rule revision changed; reload before auditing' }, 409);
    if (result.error === 'incomplete') return sendJson({ error: 'cannot approve an incomplete rule item' }, 400);
    if (result.error === 'sticky' || result.error === 'rejected') return sendJson({ error: 'rejected item requires a content edit before further approval' }, 409);
    if (result.error) return sendJson({ error: 'invalid rule audit' }, 400);
    return sendJson({ rule: result.rule, rules: database.getRules(user.id) });
  }

  if (request.method === 'GET' && pathname === '/api/calendar/puzzles') return sendJson({ puzzles: database.getCalendarPuzzles(user.id) });
  if (request.method === 'GET' && pathname === '/api/calendar/leftovers') return sendJson({ puzzles: database.getCalendarLeftovers(user.id) });
  const calendarMatch = pathname.match(/^\/api\/calendar\/puzzles\/(\d+)$/);
  if (request.method === 'GET' && calendarMatch) {
    const puzzle = database.getCalendarPuzzle(Number(calendarMatch[1]), user.id);
    return puzzle ? sendJson({ puzzle }) : sendJson({ error: 'puzzle not found' }, 404);
  }
  if (request.method === 'POST' && pathname === '/api/calendar/puzzles') {
    const input = await readJson(request);
    if (!validText(input.title, 200, true) || (input.author !== undefined && !validText(input.author, 200)) || !validText(input.source, 120, true) || (input.url !== undefined && !validText(input.url, 3000)) || (input.note !== undefined && !validText(input.note, 2000)) || !['external', 'blank'].includes(input.inputMode)) return sendJson({ error: 'invalid puzzle fields' }, 400);
    if (!database.getRule(Number(input.ruleId))) return sendJson({ error: 'a valid ruleId is required' }, 400);
    if (input.inputMode === 'external' && !parseTrustedPuzzleUrl(input.url)) return sendJson({ error: 'only supported puzzle tool URLs are allowed' }, 400);
    const dateFields = normalizeCalendarDateFields(input);
    if (dateFields.error) return sendJson({ error: dateFields.error }, 400);
    if (input.inputMode === 'blank' && !validText(input.answer || '', 2000)) return sendJson({ error: 'invalid answer' }, 400);
    const author = input.author === undefined || !input.author.trim() ? (user.username || user.name) : input.author.trim();
    const created = database.addCalendarPuzzle({ ...input, author, ...dateFields.value }, user);
    if (created.error === 'missing-rule') return sendJson({ error: 'rule is no longer available; reload before submitting' }, 409);
    return sendJson({ ...created, puzzles: database.getCalendarPuzzles(user.id) }, 201);
  }
  const calendarRating = pathname.match(/^\/api\/calendar\/puzzles\/(\d+)\/complete-rating$/);
  if (request.method === 'POST' && calendarRating) {
    const number = Number(calendarRating[1]);
    if (!Number.isSafeInteger(number) || number < 1 || !database.calendarPuzzleExists(number)) return sendJson({ error: 'puzzle not found' }, 404);
    const normalized = normalizeCalendarReviewInput(await readJson(request));
    if (normalized.error) return sendJson({ error: 'difficulty, tags, vote, and expectedReviewRound are required and must be valid' }, 400);
    const result = database.completeCalendarReview(number, user.id, normalized.value);
    if (result.error === 'missing') return sendJson({ error: 'puzzle not found' }, 404);
    if (result.error === 'stale-round') return sendJson({ error: 'review round changed; reload the puzzle' }, 409);
    if (result.error === 'reentry-required') return sendJson({ error: 'puzzle needs explicit reentry before another review round' }, 409);
    if (result.error === 'veto-locked') return sendJson({ error: 'a veto is final for this review round' }, 409);
    if (result.error) return sendJson({ error: 'active member session required' }, 401);
    return sendJson({ puzzle: result.puzzle, puzzles: database.getCalendarPuzzles(user.id) });
  }
  const calendarReenter = pathname.match(/^\/api\/calendar\/puzzles\/(\d+)\/reenter$/);
  if (request.method === 'POST' && calendarReenter) {
    const number = Number(calendarReenter[1]);
    const input = await readJson(request);
    if (!Number.isSafeInteger(number) || number < 1 || !Number.isSafeInteger(input.expectedReviewRound) || input.expectedReviewRound < 1) return sendJson({ error: 'expectedReviewRound is required' }, 400);
    const result = database.reenterCalendarPuzzle(number, user.id, input.expectedReviewRound);
    if (result.error === 'missing') return sendJson({ error: 'puzzle not found' }, 404);
    if (result.error === 'stale-round') return sendJson({ error: 'review round changed; reload before reentry' }, 409);
    if (result.error === 'not-leftover') return sendJson({ error: 'only leftover puzzles can be reentered' }, 409);
    return sendJson({ puzzle: result.puzzle, puzzles: database.getCalendarPuzzles(user.id) });
  }
  const calendarTag = pathname.match(/^\/api\/calendar\/puzzles\/(\d+)\/tags$/);
  if (request.method === 'POST' && calendarTag) {
    const number = Number(calendarTag[1]);
    if (!database.calendarPuzzleExists(number)) return sendJson({ error: 'puzzle not found' }, 404);
    const input = await readJson(request);
    if (!validText(input.tag, 40, true)) return sendJson({ error: 'tag must be 1 to 40 characters' }, 400);
    database.addPuzzleTag(number, input.tag.trim(), 'calendar');
    return sendJson({ puzzles: database.getCalendarPuzzles(user.id) });
  }
  if (request.method === 'PATCH' && calendarMatch) {
    const number = Number(calendarMatch[1]);
    const input = await readJson(request);
    if (!Object.hasOwn(input, 'suggestedDate') && !Object.hasOwn(input, 'suggestedMonthDay') && !Object.hasOwn(input, 'calendarYear')) return sendJson({ error: 'calendarYear or suggestedMonthDay is required' }, 400);
    const currentPuzzle = database.getCalendarPuzzle(number, user.id);
    if (!currentPuzzle) return sendJson({ error: 'puzzle not found' }, 404);
    const dateInput = { ...input };
    if (dateInput.calendarYear === undefined && dateInput.suggestedDate === null) dateInput.calendarYear = currentPuzzle.calendarYear;
    if (dateInput.calendarYear === undefined && dateInput.suggestedDate === undefined) dateInput.calendarYear = currentPuzzle.calendarYear;
    const dateFields = normalizeCalendarDateFields(dateInput);
    if (dateFields.error) return sendJson({ error: dateFields.error }, 400);
    const result = database.updateCalendarSuggestedDate(number, user.id, dateFields.value.calendarYear, dateFields.value.suggestedDate);
    if (result.missing) return sendJson({ error: 'puzzle not found' }, 404);
    if (result.forbidden) return sendJson({ error: 'only the uploader may change suggestedDate' }, 403);
    return sendJson({ puzzle: result.puzzle, puzzles: database.getCalendarPuzzles(user.id) });
  }
  if (request.method === 'DELETE' && calendarMatch) {
    const number = Number(calendarMatch[1]);
    if (!Number.isSafeInteger(number) || number < 1) return sendJson({ error: 'puzzle not found' }, 404);
    const input = await readJson(request);
    if (typeof input.deleteToken !== 'string' || !input.deleteToken) return sendJson({ error: 'deleteToken is required' }, 400);
    const result = database.deleteCalendarPuzzle(number, user.id, input.deleteToken);
    if (result.error === 'missing') return sendJson({ error: 'puzzle not found' }, 404);
    if (result.error === 'forbidden') return sendJson({ error: 'only the uploader may delete this puzzle' }, 403);
    if (result.error) return sendJson({ error: 'puzzle changed; reload before deleting', reason: 'stale' }, 409);
    return sendJson({ puzzles: database.getCalendarPuzzles(user.id) });
  }

  if (request.method === 'POST' && pathname === '/api/puzzles') {
    const input = await readJson(request);
    if (!validText(input.title, 200, true) || !validText(input.author || '', 200) || !validText(input.source || '', 120) || (input.url !== undefined && !validText(input.url, 3000)) || (input.note !== undefined && !validText(input.note, 2000)) || !['external', 'blank'].includes(input.inputMode)) return sendJson({ error: 'invalid puzzle fields' }, 400);
    const rule = database.getRule(Number(input.ruleId));
    if (!rule) return sendJson({ error: 'a valid ruleId is required' }, 400);
    if (input.inputMode === 'external' && !parseTrustedPuzzleUrl(input.url)) return sendJson({ error: 'only supported puzzle tool URLs are allowed' }, 400);
    input.type = rule.category;
    input.rules = rule.rulesZh.join('\n');
    const id = database.addPuzzle(input);
    if (id?.error === 'missing-rule') return sendJson({ error: 'rule is no longer available; reload before submitting' }, 409);
    return sendJson({ id, puzzles: database.getPuzzles(user.id) }, 201);
  }
  const ratingMatch = pathname.match(/^\/api\/puzzles\/(\d+)\/complete-rating$/);
  if (request.method === 'POST' && ratingMatch) {
    const number = Number(ratingMatch[1]);
    if (!database.getPuzzles('scope-check').some((puzzle) => puzzle.number === number)) return sendJson({ error: 'puzzle not found' }, 404);
    const input = await readJson(request);
    if (!['logic', 'intuition', 'enjoyment'].every((key) => Number.isInteger(input[key]) && input[key] >= 1 && input[key] <= 5)) return sendJson({ error: 'ratings must be integers from 1 to 5' }, 400);
    database.completeAndRate(number, user.id, [input.logic, input.intuition, input.enjoyment]);
    return sendJson({ puzzles: database.getPuzzles(user.id) });
  }
  if (request.method === 'POST' && pathname === '/api/folders') {
    const input = await readJson(request);
    if (!validText(input.name, 120, true)) return sendJson({ error: 'name is required' }, 400);
    const id = database.addFolder(input.name.trim(), input.parentId);
    return sendJson({ id, folders: database.getFolders() }, 201);
  }
  const tagMatch = pathname.match(/^\/api\/puzzles\/(\d+)\/tags$/);
  if (request.method === 'POST' && tagMatch) {
    const number = Number(tagMatch[1]);
    if (!database.getPuzzles('scope-check').some((puzzle) => puzzle.number === number)) return sendJson({ error: 'puzzle not found' }, 404);
    const input = await readJson(request);
    if (!validText(input.tag, 40, true)) return sendJson({ error: 'tag must be 1 to 40 characters' }, 400);
    database.addPuzzleTag(number, input.tag.trim());
    return sendJson({ puzzles: database.getPuzzles(user.id), tags: database.getTags() });
  }

  return sendJson({ error: 'API route not found' }, 404);
}
