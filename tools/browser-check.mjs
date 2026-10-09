// Real desktop acceptance using only isolated fixtures. Playwright is a test driver,
// installed outside the application and selected through an environment variable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const executable = process.env.PUZARCHIVE_BROWSER_EXECUTABLE;
const driver = process.env.PUZARCHIVE_PLAYWRIGHT_MODULE;
if (!executable || !driver) throw new Error('Set PUZARCHIVE_BROWSER_EXECUTABLE and PUZARCHIVE_PLAYWRIGHT_MODULE to the Chromium executable and Playwright entry module.');
const { chromium } = await import(pathToFileURL(path.resolve(driver)).href);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-browser-'));
const screenshots = path.resolve(process.env.PUZARCHIVE_BROWSER_SCREENSHOT_DIR || path.join(directory, 'screenshots'));
fs.mkdirSync(screenshots, { recursive: true });
process.env.PUZARCHIVE_DB_PATH = path.join(directory, 'test.sqlite');
process.env.PUZARCHIVE_USERS_PATH = path.join(directory, 'users.json');
process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH = path.join(directory, 'penpa.md');
const inviteCode = randomBytes(24).toString('base64url');
const password = 'isolated browser test password';
fs.writeFileSync(process.env.PUZARCHIVE_USERS_PATH, JSON.stringify([{ id: 'browser-owner', name: 'Browser Owner', accessCode: inviteCode }]), { mode: 0o600 });
fs.copyFileSync(path.join(root, 'docs', 'penpa.md'), process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH);
const { createServer } = await import('../server.mjs');
const db = await import('../db.mjs');
const { hashPassword } = await import('../password-hash.mjs');
const passwordHash = await hashPassword(password);
for (const [id, name] of [['reviewer-1', 'NativeOne'], ['reviewer-2', 'NativeTwo'], ['reviewer-3', 'NativeThree']]) {
  db.database.prepare('INSERT INTO trusted_users(id,name,username,username_key,password_hash) VALUES (?,?,?,?,?)').run(id, name, name, name.toLowerCase(), passwordHash);
}
const ruleInput = { titleZh: '标准规则', titleEn: 'Standard Native Rule', category: '其它', rulesZh: ['按题面线索完成谜题。'], rulesEn: [], isVariant: false, baseRuleId: null, exampleUrl: 'https://penpa-edit.com/?m=solve&p=isolated-example', exampleAuthor: '' };
const standard = db.addRule(ruleInput, 'browser-owner');
const auditDraft = db.addRule({ ...ruleInput, titleZh: '浏览器审计检查', titleEn: 'Native Audit' }, 'browser-owner');
const ignoredDraft = db.addRule({ ...ruleInput, titleZh: '可忽略错误草稿', titleEn: '' }, 'browser-owner');
for (const item of ['name', 'description', 'example']) for (const id of ['reviewer-1', 'reviewer-2', 'reviewer-3']) assert.ok(db.submitRuleAudit(standard.id, item, 'approve', '', 1, id).rule);
const puzzlink = 'https://puzz.link/p?slither/3/3/0000';
const spoiler = db.addCalendarPuzzle({ title: '剧透与留言检查', author: 'NativeOne', source: 'puzz.link', url: puzzlink, inputMode: 'external', ruleId: standard.id }, { id: 'reviewer-1' }).puzzle;
db.completeCalendarReview(spoiler.number, 'reviewer-1', { difficulty: 3, tags: [], vote: 'support', expectedReviewRound: 1 });
db.database.prepare('INSERT INTO trusted_users(id,name) VALUES (?,?)').run('legacy-browser', '<img src=x onerror="window.unsafeParticipant=true">');
const spoilerId = db.database.prepare('SELECT id FROM puzzles WHERE number=?').get(spoiler.number).id;
db.database.prepare('INSERT INTO calendar_review_votes(puzzle_id,user_id,review_round,vote) VALUES (?,?,1,?)').run(spoilerId, 'legacy-browser', 'oppose');
db.database.prepare('INSERT INTO calendar_evaluations(puzzle_id,user_id,review_round,difficulty,tags_json) VALUES (?,?,1,4,?)').run(spoilerId, 'legacy-browser', '[]');
db.addCalendarComment(spoiler.number, 'reviewer-1', '<script>window.unsafeComment = true</script>\n测试解题思路');
const shared = db.addCalendarPuzzle({title:'共同补充链接',author:'NativeOne',source:'pzplus',puzzlinkUrl:'https://pzplus.tck.mn/p.html?slither/3/3/0000',inputMode:'external',ruleId:standard.id},{id:'reviewer-1'}).puzzle;
for (const id of ['reviewer-1','reviewer-2','reviewer-3']) assert.ok(db.completeCalendarReview(shared.number,id,{difficulty:3,tags:[],vote:'support',expectedReviewRound:1}).puzzle);
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const browserEnv = { ...process.env };
if (process.env.PUZARCHIVE_BROWSER_LIB_DIR) browserEnv.LD_LIBRARY_PATH = [process.env.PUZARCHIVE_BROWSER_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
let browser, page, interception = null;
const requests = [], errors = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(url, method = 'GET', body = null, cookie = '') {
  const response = await fetch(base + url, { method, headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
}
async function navigate(hash, selector) {
  await page.goto(`${base}/#${hash}`, { waitUntil: 'domcontentloaded' });
  // Explicitly reload shared fixture state after another member's HTTP action;
  // a same-hash navigation alone is a same-document browser navigation.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator(selector).waitFor({ state: 'visible' });
}
async function screenshot(name) {
  await page.locator('#toast.show').waitFor({ state: 'hidden', timeout: 5000 });
  await page.screenshot({ path: path.join(screenshots, name), fullPage: true });
}
async function duplicateDisabledClick(selector) {
  assert.equal(await page.locator(selector).isDisabled(), true);
  const bounds = await page.locator(selector).boundingBox();
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}

try {
  browser = await chromium.launch({ executablePath: executable, env: browserEnv, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.route('**/*', async (route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    if (url.origin !== base) {
      // Test the host UI and iframe lifetime, without loading external solver code.
      if (incoming.isNavigationRequest()) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body>隔离的外部解题工具测试页面</body></html>' });
      return route.abort();
    }
    if (interception && incoming.method() === (interception.method || 'POST') && url.pathname === interception.path) {
      const action = interception; interception = null;
      if (action.delay) await delay(action.delay);
      if (action.fail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'native simulated outage' }) });
    }
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (incoming) => { const url = new URL(incoming.url()); if (url.origin === base) requests.push({ method: incoming.method(), path: url.pathname }); });
  await page.goto(base); await page.locator('#authUsername').waitFor();
  await page.locator('[data-auth-mode="register"]').click();
  await page.locator('#authInviteCode').fill(inviteCode); await page.locator('#authUsername').fill('BrowserOwner');
  await page.locator('#authPassword').fill(password); await page.locator('#authPasswordConfirm').fill(password);
  await page.locator('#authForm [type="submit"]').click(); await page.locator('.calendar-view-switch').waitFor();
  assert.equal((await request('/api/calendar/puzzles')).status, 401);
  console.log('PASS: Chromium registration, real session cookie, private bootstrap and anonymous API boundary');

  const row = `.calendar-row[data-puzzle-route="calendar-puzzle-${spoiler.number}"]`;
  assert.equal(await page.locator(`${row} .spoiler-content`).evaluate((node) => node.hidden), true);
  await page.locator(`${row} .spoiler-toggle`).click(); assert.equal(new URL(page.url()).hash, '#calendar');
  await page.locator(`${row} .calendar-title-link`).click(); await page.locator('#calendarCommentsList').waitFor({ state: 'attached' });
  assert.ok((await page.locator('.calendar-participant-section').textContent()).includes('NativeOne'));
  assert.ok((await page.locator('.calendar-participant-section').textContent()).includes('<img src=x'));
  assert.equal(await page.locator('.calendar-participant-section img').count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.unsafeParticipant)), false);
  assert.equal(await page.locator('#calendarCommentsList').evaluate((node) => node.hidden), true);
  await page.locator('#revealCommentsButton').click(); await page.waitForFunction(() => document.querySelector('#calendarCommentsList').textContent.includes('测试解题思路'));
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('#calendarCommentsList script') || window.unsafeComment)), false);
  await page.locator('#calendarCommentBody').fill('真实浏览器留言'); interception = { path: `/api/calendar/puzzles/${spoiler.number}/comments`, fail: true };
  await page.locator('#sendCalendarCommentButton').click(); await page.waitForFunction(() => document.querySelector('#calendarCommentError').textContent.includes('native simulated outage'));
  assert.equal(await page.locator('#calendarCommentBody').inputValue(), '真实浏览器留言');
  await page.locator('#sendCalendarCommentButton').click(); await page.waitForFunction(() => document.querySelector('#calendarCommentsList').textContent.includes('真实浏览器留言'));
  await page.evaluate(() => { window.testIframe = document.querySelector('#puzzleEmbed iframe'); });
  await page.locator('#completePuzzleButton').click(); assert.equal(await page.locator('input[name="calendarVote"]').count(), 3);
  await page.locator('label:has(input[name="calendarDifficulty"][value="3"])').click(); await page.locator('label:has(input[name="calendarVote"][value="support"])').click();
  const reviewStart = requests.length; interception = { path: `/api/calendar/puzzles/${spoiler.number}/complete-rating`, delay: 700 };
  await page.locator('#submitCalendarEvaluationButton').click(); await duplicateDisabledClick('#submitCalendarEvaluationButton');
  await page.waitForFunction(() => !document.querySelector('#submitCalendarEvaluationButton') && document.querySelector('#completePuzzleButton').textContent.includes('已完成'));
  assert.equal(await page.evaluate(() => window.testIframe === document.querySelector('#puzzleEmbed iframe')), true);
  assert.equal(requests.slice(reviewStart).filter((entry) => entry.path.endsWith('/complete-rating')).length, 1);
  assert.equal(requests.slice(reviewStart).filter((entry) => ['/api/calendar/puzzles', '/api/calendar/leftovers'].includes(entry.path)).length, 0);
  assert.ok((await page.locator('.calendar-participant-section .vote-participants').textContent()).includes('BrowserOwner'));
  const participantFrame = await page.evaluate(() => window.testIframe === document.querySelector('#puzzleEmbed iframe'));
  await page.locator('#completePuzzleButton').click();
  await page.locator('label:has(input[name="calendarVote"][value="oppose"])').click();
  await page.locator('#submitCalendarEvaluationButton').click();
  await page.locator('#submitCalendarEvaluationButton').waitFor({state: 'detached'});
  assert.ok((await page.locator('.vote-participants .participant-row').nth(1).textContent()).includes('BrowserOwner'));
  assert.ok(!(await page.locator('.vote-participants .participant-row').nth(0).textContent()).includes('BrowserOwner'));
  assert.equal(participantFrame, true);
  assert.equal(await page.evaluate(() => window.testIframe === document.querySelector('#puzzleEmbed iframe')), true);
  await screenshot('calendar-participants-browser-desktop.png');
  console.log('PASS: native spoiler controls, safe comments, failed-comment draft, delayed vote and preserved iframe');

  await navigate(`calendar-puzzle-${shared.number}`, '#editSharedPenpaLinksButton');
  assert.equal(await page.locator('#editCalendarPuzzleButton').count(),0);
  await page.locator('#editSharedPenpaLinksButton').click();
  await page.locator('#sharedPenpaEdit').fill('https://penpa-edit.com/?m=edit&p=shared-browser');
  await page.locator('#sharedPenpaSolve').fill('https://penpa-edit.com/?m=solve&p=shared-browser');
  interception={method:'PATCH',path:`/api/calendar/puzzles/${shared.number}/penpa-links`,fail:true};
  await page.locator('#saveSharedPenpaButton').click();await page.waitForFunction(()=>document.querySelector('#sharedPenpaError').textContent.includes('native simulated outage'));
  assert.ok((await page.locator('#sharedPenpaEdit').inputValue()).includes('shared-browser'));
  interception={method:'PATCH',path:`/api/calendar/puzzles/${shared.number}/penpa-links`,delay:700};
  await page.locator('#saveSharedPenpaButton').click();await duplicateDisabledClick('#saveSharedPenpaButton');
  await page.locator('#sharedPenpaError').waitFor({state:'detached'});
  const sharedUpdated=db.getCalendarPuzzle(shared.number,'browser-owner');
  assert.equal(sharedUpdated.penpaRevision,2);assert.equal(sharedUpdated.review.support,3);
  assert.equal(sharedUpdated.submittedBy.id,'reviewer-1');assert.equal(sharedUpdated.puzzlinkUrl,shared.puzzlinkUrl);
  await screenshot('calendar-shared-links-browser-desktop.png');
  console.log('PASS: non-uploader Penpa contribution, failed-save draft, delayed duplicate protection and retained reviews');

  await navigate('rules', '.rule-catalog');
  await page.evaluate((id) => { window.testNeighbor = document.querySelector(`[data-rule-card="${id}"]`); }, standard.id);
  const auditSelector = `[data-rule-card="${auditDraft.id}"] [data-rule-audit="approve"][data-audit-item="name"]`;
  const auditStart = requests.length; interception = { path: `/api/rules/${auditDraft.id}/audits`, delay: 700 };
  await page.locator(auditSelector).click(); await duplicateDisabledClick(auditSelector);
  await page.waitForFunction((selector) => document.querySelector(selector).textContent.includes('已通过'), auditSelector);
  assert.equal(await page.evaluate((id) => window.testNeighbor === document.querySelector(`[data-rule-card="${id}"]`), standard.id), true);
  assert.equal(requests.slice(auditStart).filter((entry) => entry.path === '/api/rules').length, 0);
  await page.locator('#addRuleButton').click(); await page.locator('#ruleIsVariant').check();
  await page.locator('#ruleBaseSearch').fill('Standard'); await page.locator('#ruleBaseSearch').press('ArrowDown'); await page.locator('#ruleBaseSearch').press('Enter');
  assert.equal(await page.locator('#ruleBase').inputValue(), String(standard.id)); assert.equal(await page.locator('#ruleBaseSearch').getAttribute('aria-expanded'), 'false');
  await page.locator('#modalBackdrop .modal-cancel').click();
  await page.locator(`[data-rule-card="${ignoredDraft.id}"] [data-error-ignore="ignore"]`).click();
  await page.locator('#qualityIgnoreReason').fill('浏览器验收例外'); await page.locator('#confirmQualityIgnore').click();
  await page.locator(`[data-rule-card="${ignoredDraft.id}"] .quality-ignored`).waitFor();
  await page.locator(`[data-rule-card="${ignoredDraft.id}"] [data-error-ignore="restore"]`).click(); await page.locator('#confirmQualityIgnore').click();
  await page.locator(`[data-rule-card="${ignoredDraft.id}"] .quality-ignored`).waitFor({ state: 'detached' });
  await screenshot('calendar-rules-browser-desktop.png');
  console.log('PASS: native rule audit local update, prototype keyboard search, error ignore and restoration');

  await navigate('calendar', '.calendar-view-switch'); await page.locator('#addCalendarPuzzleButton').click();
  await page.locator('#submissionRuleSearch').fill('Standard'); await page.locator('#submissionRuleSearch').press('ArrowDown'); await page.locator('#submissionRuleSearch').press('Enter');
  await page.locator('#newPuzzleTitle').fill('真实浏览器日历题目'); await page.locator('#newPuzzlePuzzlink').fill('https://pzprxs.vercel.app/p?slither/3/3/0000');
  assert.equal(await page.locator('#newPuzzlePenpaEdit').inputValue(), ''); assert.equal(await page.locator('#newPuzzlePenpaSolve').inputValue(), '');
  await page.locator('.penpa-guidelines summary').click(); assert.ok((await page.locator('.penpa-guidelines pre').textContent()).includes('Visibility OFF'));
  await page.locator('#savePuzzleButton').click(); await page.waitForFunction(() => document.querySelector('.puzzle-header h1')?.textContent.includes('真实浏览器日历题目'));
  const number = Number(new URL(page.url()).hash.split('-').at(-1)); const puzzleUrl = `/api/calendar/puzzles/${number}`;
  await page.locator('#completePuzzleButton').click(); await page.locator('label:has(input[name="calendarDifficulty"][value="3"])').click(); await page.locator('label:has(input[name="calendarVote"][value="support"])').click(); await page.locator('#submitCalendarEvaluationButton').click();
  await page.locator('#submitCalendarEvaluationButton').waitFor({ state: 'detached' });
  const reviewers = [];
  for (const username of ['NativeOne', 'NativeTwo']) {
    const login = await request('/api/session', 'POST', { username, password }); assert.equal(login.status, 200); reviewers.push(login.cookie);
    assert.equal((await request(`${puzzleUrl}/complete-rating`, 'POST', { difficulty: 3, tags: [], vote: 'support', expectedReviewRound: 1 }, login.cookie)).status, 200);
  }
  assert.equal(db.getCalendarPuzzle(number, 'browser-owner').review.netSupport, 3);
  await navigate(`calendar-puzzle-${number}`, '.calendar-workflow-panel');
  assert.ok((await page.locator('.calendar-workflow-panel header').textContent()).includes('待分配区'));
  assert.ok(db.getInbox('browser-owner').notifications.some((entry) => entry.type === 'calendar-links-required'));
  await page.locator('[data-error-ignore="ignore"][data-error-key="missingPenpaEdit:links"]').click(); await page.locator('#qualityIgnoreReason').fill('明确忽略'); await page.locator('#confirmQualityIgnore').click();
  await page.locator('.calendar-workflow-panel .quality-ignored').waitFor(); await page.locator('#editCalendarPuzzleButton').click();
  await page.locator('#editPuzzlePenpaEdit').fill('https://penpa-edit.com/?m=edit&p=native-fixture'); await page.locator('#editPuzzlePenpaSolve').fill('https://penpa-edit.com/?m=solve&p=native-fixture');
  assert.equal(await page.locator('#clearPuzzleReviews').isChecked(), false);
  await page.locator('#savePuzzleEditButton').click(); await page.locator('#editPuzzleError').waitFor({ state: 'detached' });
  assert.equal(db.getCalendarPuzzle(number, 'browser-owner').penpaRevision, 2);
  await page.locator('[data-penpa-audit="approve"]').click(); await page.waitForFunction(() => document.querySelector('[data-penpa-audit="approve"]').textContent.includes('已通过'));
  let latest = db.getCalendarPuzzle(number, 'browser-owner');
  for (const cookie of reviewers) assert.equal((await request(`${puzzleUrl}/penpa-audits`, 'POST', { decision: 'approve', revision: latest.penpaRevision, guidelinesRevision: latest.quality.penpa.guidelinesRevision }, cookie)).status, 200);
  await navigate(`calendar-puzzle-${number}`, '.calendar-workflow-panel'); await page.locator('#assignedCalendarDate').fill('2028-02-29'); await page.locator('#assignCalendarDateButton').click();
  await page.waitForFunction(() => document.querySelector('.calendar-workflow-panel header').textContent.includes('完成区'));
  await page.locator('.calendar-workflow-panel .penpa-guidelines summary').click(); await screenshot('calendar-workflow-browser-desktop.png');
  await navigate('finished', '#calendarMonth'); await page.locator('#calendarMonth').selectOption('2');
  await page.waitForFunction(() => document.querySelectorAll('.month-calendar-day').length === 29);
  assert.equal(await page.locator('.month-calendar-day.has-puzzle').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await screenshot('calendar-month-browser-desktop.png');
  await page.locator('.month-calendar-day.has-puzzle a').click(); await page.locator('#clearAssignedDateButton').waitFor();
  await page.locator('#clearAssignedDateButton').click(); await page.waitForFunction(() => document.querySelector('.calendar-workflow-panel header').textContent.includes('待分配区'));
  assert.equal(db.getCalendarPuzzle(number, 'browser-owner').assignedDate, null);
  await navigate('finished', '#calendarMonth'); assert.equal(await page.locator('.month-calendar-day.has-puzzle').count(), 0);
  console.log('PASS: real upload, supplement notice, versioned editing, three drawing audits, leap month and cancellation');

  await navigate(`calendar-puzzle-${number}`, '.calendar-workflow-panel'); await page.locator('#completePuzzleButton').click();
  await page.locator('label:has(input[name="calendarVote"][value="veto"])').click(); await page.locator('#submitCalendarEvaluationButton').click();
  await page.locator('#reenterCalendarPuzzleButton').waitFor(); await page.locator('#calendarCommentBody').fill('否决后仍可留言'); await page.locator('#sendCalendarCommentButton').click();
  await page.waitForFunction(() => document.querySelector('#calendarCommentsList').textContent.includes('否决后仍可留言'));
  await page.locator('#reenterCalendarPuzzleButton').click(); await page.locator('#confirmCalendarReentryButton').click(); await page.locator('#completePuzzleButton').waitFor();
  assert.equal(db.getCalendarPuzzle(number, 'browser-owner').calendarArea, 'review');
  interception = { path: '/api/session', method: 'DELETE', delay: 1200 };
  await page.locator('#profileButton').click(); await page.locator('#authUsername').waitFor();
  assert.equal(await page.locator('#authUsername').isDisabled(), true);
  await page.locator('#authUsername').fill('BrowserOwner'); await page.locator('#authPassword').fill(password); await page.locator('#authForm [type="submit"]').click(); await page.locator('.calendar-workflow-panel').waitFor();
  const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === 'puzarchive_session');
  assert.equal(sessionCookie.httpOnly, true); assert.equal(sessionCookie.sameSite, 'Strict');
  // An old audit response must not restore private state after a real logout.
  await navigate('rules', '.rule-catalog');
  interception = { path: `/api/rules/${auditDraft.id}/audits`, delay: 1200 };
  await page.locator(`[data-rule-card="${auditDraft.id}"] [data-rule-audit="approve"][data-audit-item="example"]`).click();
  await page.locator('#profileButton').click(); await page.locator('#authUsername').waitFor(); await delay(1600);
  assert.equal(await page.locator('.rule-catalog').count(), 0);
  assert.equal(await page.evaluate(() => document.body.dataset.authState), 'unauthenticated');
  await page.locator('#authUsername').fill('BrowserOwner');await page.locator('#authPassword').fill(password);await page.locator('#authForm [type="submit"]').click();await page.locator('.rule-catalog').waitFor();
  await page.locator('#changeUsernameButton').click();await page.locator('#newUsername').fill('NativeOne');await page.locator('#saveUsernameButton').click();
  await page.waitForFunction(()=>document.querySelector('#usernameEditError').textContent.includes('已被使用'));
  assert.equal(await page.locator('#newUsername').inputValue(),'NativeOne');
  await page.locator('#newUsername').fill('BrowserRenamed');interception={method:'PATCH',path:'/api/account/username',delay:700};
  await page.locator('#saveUsernameButton').click();await duplicateDisabledClick('#saveUsernameButton');
  await page.waitForFunction(()=>document.querySelector('#profileButton strong').textContent==='BrowserRenamed');
  assert.equal(db.database.prepare("SELECT id FROM trusted_users WHERE username_key='browserrenamed'").get().id,'browser-owner');
  await screenshot('account-username-browser-desktop.png');
  await page.locator('#profileButton').click();await page.locator('#authUsername').waitFor();
  await page.locator('#authUsername').fill('BrowserRenamed');await page.locator('#authPassword').fill(password);await page.locator('#authForm [type="submit"]').click();await page.locator('.rule-catalog').waitFor();
  assert.equal(await page.locator('#profileButton strong').textContent(),'BrowserRenamed');
  console.log('PASS: username duplicate feedback, delayed rename, stable identity and login with unchanged password');
  assert.deepEqual(errors, []);
  fs.rmSync(path.join(screenshots, 'calendar-browser-failure.png'), { force: true });
  console.log(`PASS: real veto, post-veto comment, reentry, password login and late-response logout isolation; no page exceptions. Screenshots: ${screenshots}`);
} catch (error) {
  if (page) { try { await screenshot('calendar-browser-failure.png'); } catch {} }
  throw error;
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); db.database.close();
  if (!screenshots.startsWith(directory + path.sep)) fs.rmSync(directory, { recursive: true, force: true });
}
