// Pagination acceptance uses temporary fixtures and never contacts production.
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
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-calendar-browser-'));
const screenshots = path.resolve(process.env.PUZARCHIVE_BROWSER_SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-calendar-page-screenshots-')));
fs.mkdirSync(screenshots, { recursive: true });
process.env.PUZARCHIVE_DB_PATH = path.join(directory, 'test.sqlite');
process.env.PUZARCHIVE_USERS_PATH = path.join(directory, 'users.json');
process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH = path.join(directory, 'penpa.md');
fs.writeFileSync(process.env.PUZARCHIVE_USERS_PATH, JSON.stringify([{ id: 'page-owner', name: 'PageOwner', accessCode: randomBytes(24).toString('base64url') }]), { mode: 0o600 });
fs.copyFileSync(path.join(root, 'docs', 'penpa.md'), process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH);
const { createServer } = await import('../server.mjs');
const db = await import('../db.mjs');
const { hashPassword } = await import('../password-hash.mjs');
const { getPenpaGuidelines } = await import('../penpa-guidelines.mjs');
const password = 'calendar-page-pass';
const passwordHash = await hashPassword(password);
db.database.prepare('UPDATE trusted_users SET username=?,username_key=?,password_hash=? WHERE id=?').run('PageOwner', 'pageowner', passwordHash, 'page-owner');
for (const id of ['page-a', 'page-b', 'page-c']) db.database.prepare('INSERT INTO trusted_users(id,name,username,username_key,password_hash) VALUES (?,?,?,?,?)').run(id, id, id, id, passwordHash);
const rule = db.addRule({ titleZh: '分页规则', titleEn: 'Pagination rule', category: '其它', rulesZh: ['按题面完成谜题。'], rulesEn: [], isVariant: false, baseRuleId: null, exampleUrl: 'https://penpa-edit.com/?m=solve&p=page-example', exampleAuthor: '' }, 'page-owner');
for (const item of ['name', 'description', 'example']) for (const id of ['page-a', 'page-b', 'page-c']) assert.ok(db.submitRuleAudit(rule.id, item, 'approve', '', 1, id).rule);
let nextNumber = 1000;
const fixtures = [];
function seed({ status = 'pending', date = null, assignedDate = null, audited = false, completed = false, year = 2028 } = {}) {
  const number = nextNumber++;
  const result = db.database.prepare(`INSERT INTO puzzles(number,title,type,author,source,url,input_mode,scope,rule_id,suggested_date,assigned_date,calendar_year,calendar_status,submitted_by,delete_token,penpa_edit_url,penpa_solve_url)
    VALUES(?,?,'其它','Isolated Author','penpa+','https://penpa-edit.com/?m=solve&p=page','external','calendar',?,?,?,?,?,'page-owner',?,'https://penpa-edit.com/?m=edit&p=page','https://penpa-edit.com/?m=solve&p=page')`)
    .run(number, `隔离分页题目 ${number}`, rule.id, date, assignedDate, year, status, `isolated-page-delete-${number}`);
  const id = Number(result.lastInsertRowid);
  if (audited) for (const user of ['page-a', 'page-b', 'page-c']) db.database.prepare(`INSERT INTO calendar_penpa_votes(puzzle_id,revision,guidelines_revision,user_id,decision) VALUES(?,1,?,?,'approve')`).run(id, getPenpaGuidelines().revision, user);
  if (completed) db.database.prepare('INSERT INTO puzzle_completions(puzzle_id,user_id) VALUES(?,?)').run(id, 'page-owner');
  fixtures.push({ number, assignedDate });
  return number;
}
for (let index = 0; index < 24; index++) seed({ date: `2028-03-${String(index + 1).padStart(2, '0')}`, completed: index < 5 });
for (let index = 0; index < 12; index++) seed({ status: 'leftover', date: `2028-04-${String(index + 1).padStart(2, '0')}` });
for (let index = 0; index < 12; index++) seed({ status: 'approved', date: `2028-05-${String(index + 1).padStart(2, '0')}` });
for (let index = 0; index < 14; index++) seed({ status: 'approved', assignedDate: `2028-01-${String(index + 1).padStart(2, '0')}`, audited: true });
const februaryNumber = seed({ status: 'approved', assignedDate: '2028-02-29', audited: true });
seed({ status: 'approved', assignedDate: '2029-01-01', audited: true, year: 2029 });
for (let number = 1000; number < 1024; number += 2) db.database.prepare('UPDATE puzzles SET title=? WHERE number=?').run(`隔离分页题目 稀疏匹配 ${number}`, number);
const specialQuery = `%_&<题>"'`;
db.database.prepare('UPDATE puzzles SET title=? WHERE number=1023').run(`隔离分页题目 特殊${specialQuery} 1023`);
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const browserEnv = { ...process.env };
if (process.env.PUZARCHIVE_BROWSER_LIB_DIR) browserEnv.LD_LIBRARY_PATH = [process.env.PUZARCHIVE_BROWSER_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
const requests = [], errors = [], interceptions = [], releaseHolds = new Set();
let browser, page;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function intercept(action) {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  interceptions.push({ ...action, started });
  return ready;
}
function holdIntercept(action) {
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  releaseHolds.add(release);
  return { started: intercept({ ...action, capture: true, hold }), release: () => { release(); releaseHolds.delete(release); } };
}
const pageMatch = (view, offset, sort = 'date') => (url) => url.searchParams.get('view') === view
  && url.searchParams.get('offset') === String(offset) && url.searchParams.get('sort') === sort;
function pageGets(start = 0, match = () => true) {
  return requests.slice(start).filter((entry) => entry.method === 'GET' && entry.path === '/api/calendar/page' && match(new URL(base + entry.path + entry.query)));
}
async function waitPage(number, count = 10) {
  await page.waitForFunction(({ number, count }) => document.querySelectorAll('.calendar-list .calendar-row').length === count
    && document.querySelector('#calendarPageStatus')?.textContent.includes(`第 ${number} 页`), { number, count });
}
async function visibleNumbers() {
  return page.locator('.calendar-list .calendar-row').evaluateAll((rows) => rows.map((row) => Number(row.dataset.puzzleRoute.split('-').at(-1))));
}
async function go(view) {
  await page.evaluate((route) => { window.location.hash = route; }, view);
  await page.locator(`.calendar-view-switch a.active[href="#${view}"]`).waitFor();
  await waitPage(1, Math.min(10, db.getCalendarPage('page-owner', { view }).total));
}
async function screenshot(name) { await page.screenshot({ path: path.join(screenshots, name), fullPage: true }); }

try {
  browser = await chromium.launch({ executablePath: executable, env: browserEnv, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.route('**/*', async (route) => {
    const incoming = route.request(), url = new URL(incoming.url());
    if (url.origin !== base) {
      if (incoming.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>隔离解题工具</body></html>' });
      return route.abort();
    }
    const index = interceptions.findIndex((action) => incoming.method() === (action.method || 'GET') && url.pathname === action.path && (!action.match || action.match(url)));
    if (index < 0) return route.continue();
    const [action] = interceptions.splice(index, 1);
    const response = action.capture ? await route.fetch() : null;
    action.started();
    if (action.hold) await action.hold;
    if (action.fail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'calendar pagination simulated outage' }) });
    return response ? route.fulfill({ response }) : route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (incoming) => { const url = new URL(incoming.url()); if (url.origin === base) requests.push({ method: incoming.method(), path: url.pathname, query: url.search }); });
  const guidelineHold = holdIntercept({ path: '/api/penpa-guidelines' });
  const inboxHold = holdIntercept({ path: '/api/inbox' });
  const secondPageHold = holdIntercept({ path: '/api/calendar/page', match: pageMatch('calendar', 10) });
  await page.goto(`${base}/#calendar`, { waitUntil: 'domcontentloaded' });
  await page.locator('#authUsername').fill('PageOwner'); await page.locator('#authPassword').fill(password);
  await page.locator('#authForm [type="submit"]').click(); await waitPage(1);
  await Promise.all([guidelineHold.started, inboxHold.started, secondPageHold.started]);
  assert.deepEqual(await visibleNumbers(), Array.from({ length: 10 }, (_, index) => 1000 + index));
  assert.equal(pageGets().length, 2);
  assert.equal(await page.locator('#previousCalendarPageButton').isDisabled(), true);
  const beforeNext = requests.length;
  await page.locator('#nextCalendarPageButton').click();
  assert.equal(pageGets(beforeNext, pageMatch('calendar', 10)).length, 0);
  secondPageHold.release(); await waitPage(2);
  assert.deepEqual(await visibleNumbers(), Array.from({ length: 10 }, (_, index) => 1010 + index));
  await delay(150); assert.equal(pageGets().length, 3);
  const beforeCached = requests.length;
  await page.locator('#previousCalendarPageButton').click(); await waitPage(1);
  await page.locator('#nextCalendarPageButton').click(); await waitPage(2);
  assert.equal(pageGets(beforeCached).length, 0);
  guidelineHold.release(); inboxHold.release();
  console.log('PASS: first ten puzzle rows render independently, one-page prefetch, pending request reuse and cached navigation');

  // A delayed prefetch for the previous sort must not populate the new sort.
  await page.reload({ waitUntil: 'domcontentloaded' }); await waitPage(1);
  const oldSortPage = holdIntercept({ path: '/api/calendar/page', match: pageMatch('calendar', 10, 'newest') });
  await page.locator('#calendarSort').selectOption('newest'); await waitPage(1); await oldSortPage.started;
  assert.deepEqual(await visibleNumbers(), Array.from({ length: 10 }, (_, index) => 1023 - index));
  await page.locator('#calendarSort').selectOption('date'); await waitPage(1);
  oldSortPage.release(); await delay(150);
  await page.locator('#nextCalendarPageButton').click(); await waitPage(2);
  assert.deepEqual(await visibleNumbers(), Array.from({ length: 10 }, (_, index) => 1010 + index));
  console.log('PASS: sort resets to the first page and ignores the previous sort\'s delayed prefetch');

  for (const view of ['pending', 'leftovers', 'allocation', 'finished', 'calendar']) {
    await go(view);
    const expected = [];
    let offset = 0;
    do {
      const result = db.getCalendarPage('page-owner', { view, offset });
      expected.push(...result.puzzles.map((puzzle) => puzzle.number));
      offset = result.nextOffset;
    } while (offset !== null);
    const actual = [...await visibleNumbers()];
    for (let number = 2; actual.length < expected.length; number++) {
      await page.locator('#nextCalendarPageButton').click();
      await waitPage(number, Math.min(10, expected.length - actual.length));
      actual.push(...await visibleNumbers());
    }
    assert.deepEqual(actual, expected, view);
    assert.equal(new Set(actual).size, actual.length, view);
    assert.equal(await page.locator('#nextCalendarPageButton').isDisabled(), true, view);
  }
  assert.equal(requests.filter((entry) => entry.method === 'GET' && ['/api/calendar/puzzles', '/api/calendar/leftovers'].includes(entry.path)).length, 0);
  assert.ok(pageGets().every((entry) => new URL(base + entry.path + entry.query).searchParams.get('limit') === '10'));
  console.log('PASS: review, personal unfinished, leftover, allocation and finished lists have ten-item pages without bulk collection requests');

  // The completed month grid includes entries outside the visible list page.
  await go('finished'); await waitPage(1);
  const assigned = fixtures.filter((fixture) => fixture.assignedDate?.startsWith('2028-01')).map((fixture) => fixture.number);
  const monthNumbers = await page.locator('[data-month-puzzle]').evaluateAll((links) => links.map((link) => Number(link.getAttribute('href').split('-').at(-1))));
  assert.deepEqual([...monthNumbers].sort((a, b) => a - b), assigned);
  assert.equal(await page.locator('.calendar-list .calendar-row').count(), 10);
  await screenshot('calendar-pagination-browser-desktop.png');
  const offPage = assigned.at(-1);
  const detailHold = holdIntercept({ path: `/api/calendar/puzzles/${offPage}` });
  const detailResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/calendar/puzzles/${offPage}` && response.status() === 200);
  await page.locator(`[data-month-puzzle][href="#calendar-puzzle-${offPage}"]`).click(); await detailHold.started;
  await page.locator('#changeUsernameButton').click(); await page.locator('#newUsername').waitFor();
  detailHold.release(); await detailResponse; await page.waitForLoadState('networkidle');
  await page.locator('#modalBackdrop .modal-cancel').click();
  await page.locator('#calendarCommentsList').waitFor({ state: 'attached' });
  assert.ok((await page.locator('h1').textContent()).includes(String(offPage)));
  await go('finished');
  await page.locator('#calendarMonth').selectOption('2'); await waitPage(1, 1);
  assert.deepEqual(await visibleNumbers(), [februaryNumber]);
  assert.equal(await page.locator('[data-month-puzzle]').count(), 1);
  await page.locator('#calendarViewYear').fill('2029'); await page.locator('#calendarViewYear').press('Tab');
  await page.waitForFunction(() => document.querySelector('#calendarPageStatus')?.textContent.includes('0 道题目'));
  assert.equal(await page.locator('[data-month-puzzle]').count(), 0);
  console.log('PASS: complete month grid, off-page detail loading behind a modal, month/year pagination reset and empty month');

  await page.evaluate(() => { window.location.hash = 'allocation'; });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitPage(1);
  // Clear the fresh preload cache via a sort change and fail its next page.
  const failedPrefetchResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/calendar/page'
    && pageMatch('allocation', 10, 'newest')(new URL(response.url())) && response.status() === 500);
  const failedPrefetch = intercept({ path: '/api/calendar/page', match: pageMatch('allocation', 10, 'newest'), fail: true });
  await page.locator('#calendarSort').selectOption('newest'); await waitPage(1);
  await failedPrefetch; await failedPrefetchResponse; await delay(100);
  assert.equal(await page.locator('.calendar-list .calendar-row').count(), 10);
  assert.equal(await page.locator('#nextCalendarPageButton').isEnabled(), true);
  const failedNext = intercept({ path: '/api/calendar/page', match: pageMatch('allocation', 10, 'newest'), fail: true });
  await page.locator('#nextCalendarPageButton').click(); await failedNext;
  await page.locator('.error-state').filter({ hasText: 'calendar pagination simulated outage' }).waitFor();
  await page.locator('#retryCalendarPageButton').click(); await waitPage(2, 2);
  assert.equal(await page.locator('.error-state').count(), 0);
  console.log('PASS: failed prefetch keeps the first page and foreground failure retries successfully');

  await page.evaluate(() => { window.location.hash = '#calendar'; });
  await page.reload({ waitUntil: 'domcontentloaded' }); await waitPage(1);
  await delay(150);
  const searchFirst = requests.length;
  await page.locator('#calendarSearchInput').fill('#1023');
  assert.equal(pageGets(searchFirst).length, 0, 'typing does not query');
  await page.locator('#calendarSearchInput').press('Enter'); await waitPage(1, 1);
  await delay(150);
  assert.deepEqual(await visibleNumbers(), [1023]);
  assert.equal(pageGets(searchFirst).length, 1, 'exact number search queries only one ten-item page');
  assert.equal(new URL(base + pageGets(searchFirst)[0].path + pageGets(searchFirst)[0].query).searchParams.get('q'), '#1023');
  assert.equal(await page.locator('#calendarSearchInput').evaluate((input) => document.activeElement === input), true);
  const beforeDetail = requests.length;
  await page.locator('.calendar-title-link').click(); await page.locator('#calendarCommentsList').waitFor({ state: 'attached' });
  assert.equal(requests.slice(beforeDetail).filter((entry) => entry.path === '/api/calendar/puzzles/1023').length, 1);
  await page.locator('.back-link').click(); await waitPage(1, 1);
  assert.equal(await page.locator('#calendarSearchInput').inputValue(), '#1023');
  console.log('PASS: exact off-page puzzle number search, no query while typing, preserved focus and independent detail loading');

  const beforeSparse = requests.length;
  await page.locator('#calendarSearchInput').fill('稀疏匹配'); await page.locator('#calendarSearchButton').click(); await waitPage(1);
  await delay(150);
  assert.deepEqual(await visibleNumbers(), Array.from({ length: 10 }, (_, index) => 1000 + 2 * index));
  assert.equal(pageGets(beforeSparse).length, 1, 'search never prefetches next results');
  assert.ok((await page.locator('#calendarPageStatus').textContent()).includes('共 2 页'));
  await page.locator('#nextCalendarPageButton').click(); await waitPage(2, 2); await delay(150);
  assert.deepEqual(await visibleNumbers(), [1020, 1022]);
  assert.equal(pageGets(beforeSparse).length, 2);
  await page.locator('#previousCalendarPageButton').click(); await waitPage(1);
  assert.equal(pageGets(beforeSparse).length, 2, 'search previous page uses cache');

  const beforeJumpSearch = requests.length;
  await page.locator('#calendarSearchInput').fill('隔离分页题目'); await page.locator('#calendarSearchInput').press('Enter'); await waitPage(1);
  await page.locator('#calendarPageInput').fill('3'); await page.locator('#calendarPageInput').press('Enter'); await waitPage(3, 4); await delay(150);
  assert.deepEqual(await visibleNumbers(), [1020, 1021, 1022, 1023]);
  assert.deepEqual(pageGets(beforeJumpSearch).map((entry) => new URL(base + entry.path + entry.query).searchParams.get('offset')), ['0', '20']);
  assert.equal(await page.locator('#calendarPageInput').evaluate((input) => document.activeElement === input), true);
  for (const invalid of ['', '0', '-1', '1.5', '999999999999999999999999999', '4']) {
    const beforeInvalid = requests.length;
    await page.locator('#calendarPageInput').fill(invalid); await page.locator('#calendarPageInput').press('Enter');
    assert.ok((await page.locator('#calendarPageJumpError').textContent()).length > 0, invalid);
    assert.equal(pageGets(beforeInvalid).length, 0, invalid);
    assert.equal(await page.locator('#calendarPageInput').inputValue(), invalid);
  }
  await page.locator('#calendarPageInput').fill('1'); await page.locator('#calendarPageJumpButton').click(); await waitPage(1);
  assert.equal(await page.locator('#calendarPageJumpError').textContent(), '');
  console.log('PASS: sparse title search pages, cached previous results, direct target-page jump and invalid page validation without requests');

  const draftHold = holdIntercept({ path: '/api/calendar/page', match: (url) => url.searchParams.get('q') === '稀疏匹配' });
  await page.locator('#calendarSearchInput').fill('稀疏匹配'); await page.locator('#calendarSearchInput').press('Enter'); await draftHold.started;
  const beforeTypingDraft = requests.length;
  await page.locator('#calendarSearchInput').fill('未提交的搜索草稿');
  await page.locator('#calendarSearchInput').evaluate((input) => input.setSelectionRange(2, 4));
  draftHold.release(); await waitPage(1);
  assert.equal(await page.locator('#calendarSearchInput').inputValue(), '未提交的搜索草稿');
  assert.equal(await page.locator('#calendarSearchInput').evaluate((input) => document.activeElement === input), true);
  assert.deepEqual(await page.locator('#calendarSearchInput').evaluate((input) => [input.selectionStart, input.selectionEnd]), [2, 4]);
  assert.equal(pageGets(beforeTypingDraft).length, 0);
  const beforeDraft = requests.length;
  await page.locator('#calendarSearchInput').fill(''); await page.locator('#calendarSearchInput').fill('稀疏匹配');
  const oldQuery = holdIntercept({ path: '/api/calendar/page', match: (url) => url.searchParams.get('q') === '稀疏匹配' });
  await page.locator('#calendarSearchInput').press('Enter'); await oldQuery.started;
  await page.locator('#calendarSearchInput').fill(specialQuery); await page.locator('#calendarSearchInput').press('Enter'); await waitPage(1, 1);
  oldQuery.release(); await delay(150);
  assert.deepEqual(await visibleNumbers(), [1023]);
  assert.equal(await page.locator('#calendarSearchInput').inputValue(), specialQuery);
  assert.equal(pageGets(beforeDraft).length, 2);
  assert.equal(await page.locator('.calendar-search img').count(), 0);
  await page.locator('#calendarSearchInput').fill('<img src=x onerror="window.unsafeCalendarQuery=true">'); await page.locator('#calendarSearchInput').press('Enter'); await waitPage(1, 0);
  assert.ok((await page.locator('.calendar-list .empty-state').textContent()).includes('没有符合'));
  assert.equal(await page.locator('.calendar-list img').count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.unsafeCalendarQuery)), false);
  assert.equal(await page.locator('#calendarPageJumpButton').isDisabled(), true);

  const beforeClear = requests.length;
  await page.locator('#clearCalendarSearchButton').click(); await waitPage(1); await delay(150);
  assert.equal(await page.locator('#calendarSearchInput').inputValue(), '');
  assert.deepEqual(await visibleNumbers(), Array.from({ length: 10 }, (_, index) => 1000 + index));
  assert.equal(pageGets(beforeClear).length, 2, 'clearing returns to first page and restores one-page preload');
  console.log('PASS: stale search responses are isolated, special characters are literal, empty searches are safe and clear restores ordinary preload');

  await page.locator('#calendarSearchInput').fill('稀疏匹配'); await page.locator('#calendarSearchInput').press('Enter'); await waitPage(1);
  await page.locator('#calendarPageInput').fill('2'); await page.locator('#calendarPageInput').press('Enter'); await waitPage(2, 2);
  const beforeSearchSort = requests.length;
  await page.locator('#calendarSort').selectOption('newest'); await waitPage(1); await delay(150);
  assert.equal(await page.locator('#calendarSearchInput').inputValue(), '稀疏匹配');
  assert.deepEqual(await visibleNumbers(), Array.from({ length: 10 }, (_, index) => 1022 - 2 * index));
  assert.equal(pageGets(beforeSearchSort).length, 1);
  await page.evaluate(() => { window.location.hash = '#pending'; });
  await waitPage(1, 9);
  assert.equal(await page.locator('#calendarSearchInput').inputValue(), '稀疏匹配');
  await page.locator('#clearCalendarSearchButton').click(); await waitPage(1);
  await page.evaluate(() => { window.location.hash = '#finished'; }); await page.locator('#calendarViewYear').waitFor();
  await page.locator('#calendarViewYear').fill('2028'); await page.locator('#calendarViewYear').press('Tab');
  await page.locator('#calendarMonth').selectOption('1'); await waitPage(1);
  assert.equal(await page.locator('[data-month-puzzle]').count(), 14);
  const beforeFinishedSearch = requests.length;
  await page.locator('#calendarSearchInput').fill('隔离分页题目'); await page.locator('#calendarSearchInput').press('Enter'); await waitPage(1); await delay(150);
  assert.equal(pageGets(beforeFinishedSearch).length, 1);
  assert.equal(await page.locator('.month-calendar-grid').count(), 0, 'finished search is a paged list rather than a partial month grid');
  await page.locator('#calendarPageInput').fill('2'); await page.locator('#calendarPageInput').press('Enter'); await waitPage(2, 4);
  const beforeMonthSearch = requests.length;
  await page.locator('#calendarMonth').selectOption('2'); await waitPage(1, 1); await delay(150);
  assert.deepEqual(await visibleNumbers(), [februaryNumber]);
  assert.equal(await page.locator('#calendarSearchInput').inputValue(), '隔离分页题目');
  assert.equal(pageGets(beforeMonthSearch).length, 1);
  await page.locator('#clearCalendarSearchButton').click(); await waitPage(1, 1);
  assert.equal(await page.locator('[data-month-puzzle]').count(), 1);
  assert.ok(pageGets().every((entry) => new URL(base + entry.path + entry.query).searchParams.get('limit') === '10'));
  assert.deepEqual(errors, []);
  await screenshot('calendar-search-browser-desktop.png');
  console.log(`PASS: search survives area/sort/month changes with first-page reset, finished search avoids partial month grids and all queries request ten rows. Screenshots: ${screenshots}`);
} catch (error) {
  if (page) { try { await screenshot('calendar-pagination-browser-failure.png'); } catch {} }
  console.error(`Calendar pagination failure screenshot directory: ${screenshots}`);
  throw error;
} finally {
  for (const release of releaseHolds) release();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  db.database.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
