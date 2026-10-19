// Personal-submission acceptance uses temporary fixtures and never contacts production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const executable = process.env.PUZARCHIVE_BROWSER_EXECUTABLE;
const driver = process.env.PUZARCHIVE_PLAYWRIGHT_MODULE;
if (!executable || !driver) throw new Error('Set PUZARCHIVE_BROWSER_EXECUTABLE and PUZARCHIVE_PLAYWRIGHT_MODULE.');
const { chromium } = await import(pathToFileURL(path.resolve(driver)).href);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-submissions-browser-'));
const screenshots = path.resolve(process.env.PUZARCHIVE_BROWSER_SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-submissions-screenshots-')));
fs.mkdirSync(screenshots, { recursive: true });
process.env.PUZARCHIVE_DB_PATH = path.join(directory, 'test.sqlite');
process.env.PUZARCHIVE_USERS_PATH = path.join(directory, 'users.json');
process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH = path.join(directory, 'penpa.md');
const ownerId = 'submissions-owner', otherId = 'submissions-other';
const username = 'SubmissionOwner', otherUsername = 'SubmissionOther', password = 'isolated-submissions-pass';
fs.writeFileSync(process.env.PUZARCHIVE_USERS_PATH, JSON.stringify([{ id: ownerId, name: username, accessCode: randomBytes(24).toString('base64url') }]), { mode: 0o600 });
fs.copyFileSync(path.join(root, 'docs', 'penpa.md'), process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH);
const { createServer } = await import('../server.mjs');
const db = await import('../db.mjs');
const { hashPassword } = await import('../password-hash.mjs');
const { getPenpaGuidelines } = await import('../penpa-guidelines.mjs');
const passwordHash = await hashPassword(password);
db.database.prepare('UPDATE trusted_users SET username=?,username_key=?,password_hash=? WHERE id=?').run(username, username.toLowerCase(), passwordHash, ownerId);
for (const [id, name] of [[otherId, otherUsername], ['submissions-empty', 'SubmissionEmpty'], ['submissions-a', 'SubmissionAuditA'], ['submissions-b', 'SubmissionAuditB'], ['submissions-c', 'SubmissionAuditC']]) {
  db.database.prepare('INSERT INTO trusted_users(id,name,username,username_key,password_hash) VALUES (?,?,?,?,?)').run(id, name, name, name.toLowerCase(), passwordHash);
}
const reviewers = ['submissions-a', 'submissions-b', 'submissions-c'];
const rule = db.addRule({ titleZh: '投稿隔离规则', titleEn: 'Personal submissions fixture', category: '其它', rulesZh: ['按临时题面线索完成谜题。'], rulesEn: [], isVariant: false, baseRuleId: null, exampleUrl: 'https://penpa-edit.com/?m=solve&p=submissions-example', exampleAuthor: '' }, ownerId);
for (const item of ['name', 'description', 'example']) for (const id of reviewers) assert.ok(db.submitRuleAudit(rule.id, item, 'approve', '', 1, id).rule);
const ownNumbers = [], otherNumbers = [];
function seed(number, { userId = ownerId, status = 'pending', year = 2028, audited = false, assigned = false, completed = false, scope = 'calendar', title = `隔离投稿 ${number}`, author = 'ExternalAuthor' } = {}) {
  const day = String(number % 24 + 1).padStart(2, '0');
  const result = db.database.prepare(`INSERT INTO puzzles(number,title,type,author,source,url,input_mode,scope,rule_id,suggested_date,assigned_date,calendar_year,calendar_status,submitted_by,delete_token,penpa_edit_url,penpa_solve_url)
    VALUES(?,?,'其它',?,'penpa+','https://penpa-edit.com/?m=solve&p=submissions','external',?,?,?,?,?,?,?,?,'https://penpa-edit.com/?m=edit&p=submissions','https://penpa-edit.com/?m=solve&p=submissions')`)
    .run(number, title, author, scope, rule.id, `${year}-03-${day}`, assigned ? `${year}-06-${day}` : null, year, status, userId, `isolated-submission-delete-${number}`);
  const id = Number(result.lastInsertRowid);
  if (audited) for (const reviewer of reviewers) db.database.prepare(`INSERT INTO calendar_penpa_votes(puzzle_id,revision,guidelines_revision,user_id,decision) VALUES(?,1,?,?,'approve')`).run(id, getPenpaGuidelines().revision, reviewer);
  if (completed) db.database.prepare('INSERT INTO puzzle_completions(puzzle_id,user_id) VALUES(?,?)').run(id, userId);
  if (scope === 'calendar') (userId === ownerId ? ownNumbers : otherNumbers).push(number);
}
for (let index = 0; index < 23; index++) {
  seed(2000 + index, { status: ['pending', 'leftover', 'approved', 'approved'][index % 4], year: 2027 + Math.floor(index / 8), audited: index % 4 === 3, assigned: index % 4 === 3, completed: index === 0 });
}
seed(2100, { userId: otherId, author: username, title: '隔离投稿 别人的同名作者 2100' });
seed(2101, { userId: otherId, status: 'leftover', year: 2030, author: username, title: '隔离投稿 别人的同名作者 2101' });
seed(2200, { scope: 'public', title: '隔离投稿 公共题库 2200' });
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const browserEnv = { ...process.env };
if (process.env.PUZARCHIVE_BROWSER_LIB_DIR) browserEnv.LD_LIBRARY_PATH = [process.env.PUZARCHIVE_BROWSER_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
const requests = [], errors = [], releases = new Set();
let browser, page, heldRequest;
const nav = '.primary-nav [data-route-link="submissions"]';
async function waitPage(number = 1, count = 10) {
  await page.waitForFunction(({ number, count }) => document.querySelectorAll('.calendar-list .calendar-row').length === count
    && (count === 0 ? document.querySelector('#calendarPageStatus')?.textContent.includes('0 道题目') : document.querySelector('#calendarPageStatus')?.textContent.includes(`第 ${number} 页`)), { number, count });
}
async function visibleNumbers() {
  return page.locator('.calendar-list .calendar-row').evaluateAll((rows) => rows.map((row) => Number(row.dataset.puzzleRoute.split('-').at(-1))));
}
async function screenshot(name) {
  await page.locator('#toast.show').waitFor({ state: 'hidden', timeout: 5000 });
  await page.screenshot({ path: path.join(screenshots, name), fullPage: true });
}
async function login(name, count) {
  await page.locator('#authUsername').fill(name);
  await page.locator('#authPassword').fill(password);
  await page.locator('#authForm [type="submit"]').click();
  await page.locator(`${nav}.active`).waitFor();
  await waitPage(1, count);
}
async function logout() {
  await page.locator('#accountMenuButton').click();
  await page.locator('#loginButton').click();
  await page.locator('#authUsername').waitFor();
  await page.waitForFunction(() => !document.querySelector('#authForm [type="submit"]').disabled);
}
async function search(query, count = 10) {
  await page.locator('#calendarSearchInput').fill(query);
  await page.locator('#calendarSearchInput').press('Enter');
  await waitPage(1, count);
}
async function openDetail(number) {
  await page.locator(`.calendar-title-link[href="#calendar-puzzle-${number}"]`).click();
  await page.locator('#calendarCommentsList').waitFor({ state: 'attached' });
  assert.equal(await page.locator('.back-link').getAttribute('href'), '#submissions');
  assert.ok((await page.locator('.back-link').textContent()).includes('我的投稿'));
  await page.locator(`${nav}.active`).waitFor();
}
function holdNextList() {
  let resolveStarted, release;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  releases.add(release);
  heldRequest = { started: resolveStarted, hold };
  return { started, release: () => { release(); releases.delete(release); } };
}
async function assertSidebarUsable() {
  await page.locator(nav).scrollIntoViewIfNeeded();
  const bounds = await page.locator(nav).boundingBox();
  assert.ok(bounds && bounds.width >= 40 && bounds.height >= 40, 'personal submissions has a usable navigation target');
  assert.equal(await page.locator(nav).getAttribute('aria-label'), '我的投稿');
  assert.equal(await page.locator(nav).getAttribute('title'), '我的投稿');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'personal submissions fits the viewport');
}

try {
  browser = await chromium.launch({ executablePath: executable, env: browserEnv, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.route('**/*', async (route) => {
    const incoming = route.request(), url = new URL(incoming.url());
    if (url.origin !== base) {
      if (incoming.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>隔离解题工具</body></html>' });
      return route.abort();
    }
    if (heldRequest && incoming.method() === 'GET' && url.pathname === '/api/calendar/page' && url.searchParams.get('view') === 'submissions' && url.searchParams.get('offset') === '0') {
      const action = heldRequest; heldRequest = null;
      const response = await route.fetch();
      action.started();
      await action.hold;
      return route.fulfill({ response });
    }
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (incoming) => {
    const url = new URL(incoming.url());
    if (url.origin === base) requests.push({ method: incoming.method(), path: url.pathname, query: url.search });
  });
  await page.goto(`${base}/#submissions`, { waitUntil: 'domcontentloaded' });
  await login(username, 10);
  assert.ok((await page.locator('h1').textContent()).includes('我的投稿'));
  await assertSidebarUsable();
  const numbers = [...await visibleNumbers()];
  for (const [number, count] of [[2, 10], [3, 3]]) {
    await page.locator('#nextCalendarPageButton').click(); await waitPage(number, count);
    numbers.push(...await visibleNumbers());
  }
  assert.deepEqual(numbers.toSorted((a, b) => a - b), ownNumbers);
  assert.equal(new Set(numbers).size, 23, 'all pages contain each submission once');
  assert.equal(await page.locator('#nextCalendarPageButton').isDisabled(), true);
  assert.equal(await page.locator('[data-calendar-count="submissions"]').textContent(), '23');
  assert.deepEqual([...new Set(ownNumbers.map((number) => db.getCalendarPuzzle(number, ownerId).calendarArea))].sort(), ['allocation', 'finished', 'leftover', 'review']);
  console.log('PASS: direct personal-submissions route lists only the member\'s calendar submissions across all areas, years and completion states in ten-item pages');

  await page.locator('#calendarSort').selectOption('newest'); await waitPage();
  assert.deepEqual(await visibleNumbers(), ownNumbers.toReversed().slice(0, 10));
  await search('隔离投稿');
  await page.locator('#calendarPageInput').fill('3'); await page.locator('#calendarPageInput').press('Enter'); await waitPage(3, 3);
  assert.deepEqual(await visibleNumbers(), [2002, 2001, 2000]);
  await search('#2100', 0);
  assert.equal(await page.locator('.calendar-list .calendar-row').count(), 0, 'search cannot reveal another member\'s matching author');
  const publicSearch = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/calendar/page' && new URL(response.url()).searchParams.get('q') === '#2200');
  await search('#2200', 0);
  assert.equal((await (await publicSearch).json()).total, 0, 'personal submissions excludes public-library entries');
  await search('#2000', 1);
  assert.deepEqual(await visibleNumbers(), [2000], 'a completed submission remains available');
  await openDetail(2000);
  await page.locator('#editCalendarPuzzleButton').waitFor();
  await page.locator('#deleteCalendarPuzzleButton').waitFor();
  await page.locator('.back-link').click(); await waitPage(1, 1);
  assert.equal(await page.locator('#calendarSearchInput').inputValue(), '#2000');
  await search('');
  await screenshot('my-submissions-desktop.png');
  console.log('PASS: sort, page jump, ownership-scoped search, detail controls and the personal-submissions return link work together');

  await search('#2022', 1); await openDetail(2022);
  await page.locator('#editCalendarPuzzleButton').click();
  await page.locator('#editPuzzleTitle').fill('隔离投稿 已编辑 2022');
  const editResponse = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/calendar/puzzles/2022');
  await page.locator('#savePuzzleEditButton').click(); assert.equal((await editResponse).status(), 200);
  await page.locator('#modalBackdrop').waitFor({ state: 'hidden' });
  await page.locator('.puzzle-header h1').filter({ hasText: '隔离投稿 已编辑 2022' }).waitFor();
  await page.locator('.back-link').click(); await waitPage(1, 1);
  assert.equal(await page.locator('.calendar-title-link strong').textContent(), '隔离投稿 已编辑 2022');
  await openDetail(2022);
  await page.locator('#deleteCalendarPuzzleButton').click();
  const deleteResponse = page.waitForResponse((response) => response.request().method() === 'DELETE' && new URL(response.url()).pathname === '/api/calendar/puzzles/2022');
  await page.locator('#confirmDeleteCalendarPuzzleButton').click(); assert.equal((await deleteResponse).status(), 200);
  await page.locator('#modalBackdrop').waitFor({ state: 'hidden' });
  await page.locator(`${nav}.active`).waitFor(); await waitPage(1, 0);
  assert.equal(new URL(page.url()).hash, '#submissions');
  await search('');
  assert.equal(await page.locator('[data-calendar-count="submissions"]').textContent(), '22');
  assert.equal(db.getCalendarPuzzle(2022, ownerId), null);
  console.log('PASS: editing refreshes the personal list; deleting returns to personal submissions and updates its count');

  await search('#2001', 1); await openDetail(2001);
  await page.locator('#reenterCalendarPuzzleButton').click();
  const reentryResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/calendar/puzzles/2001/reenter');
  await page.locator('#confirmCalendarReentryButton').click(); assert.equal((await reentryResponse).status(), 200);
  await page.locator('#modalBackdrop').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.back-link').getAttribute('href'), '#submissions');
  await page.locator('.back-link').click(); await waitPage(1, 1);
  assert.equal(db.getCalendarPuzzle(2001, ownerId).calendarStatus, 'pending');
  assert.deepEqual(await visibleNumbers(), [2001]);
  await search('');
  console.log('PASS: returning an archived submission to review preserves its personal-submissions origin');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-route-link="calendar"]').click();
  await page.locator('[data-route-link="calendar"].active').waitFor();
  await page.locator(nav).click(); await page.locator(`${nav}.active`).waitFor(); await waitPage();
  await assertSidebarUsable();
  await screenshot('my-submissions-mobile.png');
  console.log('PASS: the compact mobile sidebar keeps personal submissions accessible without horizontal overflow');

  await page.setViewportSize({ width: 1440, height: 1000 });
  // Hold the previous account's filtered result while changing accounts. Its
  // eventual response must not repopulate the new account's list or caches.
  const delayed = holdNextList();
  await page.locator('#calendarSearchInput').fill('隔离投稿 已编辑');
  await page.locator('#calendarSearchInput').press('Enter');
  let delayedTimer;
  try {
    await Promise.race([delayed.started, new Promise((_, reject) => { delayedTimer = setTimeout(() => reject(new Error('The delayed previous-account query did not arrive')), 10000); })]);
  } finally { clearTimeout(delayedTimer); }
  await logout();
  assert.equal(new URL(page.url()).hash, '#submissions');
  assert.equal(await page.locator('.calendar-row').count(), 0);
  await login(otherUsername, 2);
  delayed.release();
  await page.waitForLoadState('networkidle');
  assert.deepEqual((await visibleNumbers()).toSorted((a, b) => a - b), otherNumbers);
  assert.equal(await page.locator('#calendarSearchInput').inputValue(), '', 'a previous member\'s query is cleared');
  assert.equal(await page.locator('[data-calendar-count="submissions"]').textContent(), '2');
  await search('#2000', 0);
  await logout(); await page.reload({ waitUntil: 'domcontentloaded' }); await login('SubmissionEmpty', 0);
  assert.ok((await page.locator('h1').textContent()).includes('我的投稿'));
  assert.equal(await page.locator('[data-calendar-count="submissions"]').textContent(), '0');
  assert.equal(await page.locator('#addCalendarPuzzleButton').isEnabled(), true);
  assert.deepEqual(errors, []);
  assert.ok(requests.filter((entry) => entry.path === '/api/calendar/page' && new URL(base + entry.path + entry.query).searchParams.get('view') === 'submissions').every((entry) => new URL(base + entry.path + entry.query).searchParams.get('limit') === '10'));
  assert.equal(requests.filter((entry) => entry.method === 'GET' && ['/api/calendar/puzzles', '/api/calendar/leftovers'].includes(entry.path)).length, 0, 'personal submissions does not bulk-download the archive');
  console.log(`PASS: logout, direct-route login, delayed prior-account responses and an empty new account never expose another member's submissions. Screenshots: ${screenshots}`);
} catch (error) {
  if (page) { try { await page.screenshot({ path: path.join(screenshots, 'my-submissions-failure.png'), fullPage: true }); } catch {} }
  console.error(`Personal submissions failure screenshots: ${screenshots}`);
  throw error;
} finally {
  for (const release of releases) release();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  db.database.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
