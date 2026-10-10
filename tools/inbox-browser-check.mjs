// Inbox acceptance in Chromium, using a temporary database and fixture accounts.
// The Playwright driver and browser are selected externally, as in browser-check.mjs.
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
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-inbox-browser-'));
const screenshots = path.resolve(process.env.PUZARCHIVE_BROWSER_SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-inbox-screenshots-')));
fs.mkdirSync(screenshots, { recursive: true });
process.env.PUZARCHIVE_DB_PATH = path.join(directory, 'test.sqlite');
process.env.PUZARCHIVE_USERS_PATH = path.join(directory, 'users.json');
process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH = path.join(directory, 'penpa.md');
fs.writeFileSync(process.env.PUZARCHIVE_USERS_PATH, JSON.stringify([{ id: 'inbox-owner', name: 'InboxOwner', accessCode: randomBytes(24).toString('base64url') }]), { mode: 0o600 });
fs.copyFileSync(path.join(root, 'docs', 'penpa.md'), process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH);
const { createServer } = await import('../server.mjs');
const db = await import('../db.mjs');
const { hashPassword } = await import('../password-hash.mjs');
const password = 'inbox-test-pass';
const passwordHash = await hashPassword(password);
db.database.prepare('UPDATE trusted_users SET username=?,username_key=?,password_hash=? WHERE id=?').run('InboxOwner', 'inboxowner', passwordHash, 'inbox-owner');
db.database.prepare('INSERT INTO trusted_users(id,name,username,username_key,password_hash) VALUES (?,?,?,?,?)').run('inbox-other', 'InboxOther', 'InboxOther', 'inboxother', passwordHash);
const insert = db.database.prepare(`INSERT INTO user_notifications(recipient_user_id,kind,title,body,dedupe_key,read_at) VALUES (?,?,?,?,?,?)`);
const fixtures = [];
for (let number = 1; number <= 52; number += 1) {
  const result = insert.run('inbox-owner', 'browser-fixture', `隔离通知 ${number}`, `浏览器收件箱检查 ${number}`, `inbox-browser-${number}`, number <= 12 ? '2026-01-01 00:00:00' : null);
  fixtures.push({ id: Number(result.lastInsertRowid), number });
}
const otherId = Number(insert.run('inbox-other', 'browser-fixture', '另一账号独有通知', '隔离另一账号的收件箱', 'inbox-browser-other', null).lastInsertRowid);
const topId = fixtures.at(-1).id;
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const browserEnv = { ...process.env };
if (process.env.PUZARCHIVE_BROWSER_LIB_DIR) browserEnv.LD_LIBRARY_PATH = [process.env.PUZARCHIVE_BROWSER_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
const errors = [], requests = [], interceptions = [], releaseHolds = new Set();
let browser, page;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(url, method = 'GET', body = null, cookie = '') {
  const response = await fetch(base + url, { method, headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== null ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
}
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
function inboxGets(start = 0, match = () => true) {
  return requests.slice(start).filter((entry) => entry.method === 'GET' && entry.path === '/api/inbox' && match(new URLSearchParams(entry.query)));
}
const hasBefore = (before) => (url) => url.searchParams.get('before') === String(before);
const item = (id) => page.locator(`article.inbox-item[data-inbox-id="${id}"]`);
const tag = (id, name) => page.locator(`button[data-inbox-id="${id}"][data-inbox-tag="${name}"]`);
async function waitCount(count) {
  await page.waitForFunction((expected) => document.querySelectorAll('article.inbox-item').length === expected && !document.querySelector('#refreshInboxButton')?.disabled, count);
}
async function waitPage(number, count = 10) {
  await waitCount(count);
  await page.waitForFunction((expected) => document.querySelector('#inboxPageStatus')?.textContent.includes(`第 ${expected} 页`), number);
}
async function visibleIds() {
  return page.locator('article.inbox-item').evaluateAll((nodes) => nodes.map((node) => Number(node.dataset.inboxId)));
}
async function assertVisibleNumbers(numbers) {
  assert.deepEqual(await visibleIds(), numbers.map((number) => fixtures.find((fixture) => fixture.number === number).id));
}
async function waitPressed(id, name, pressed) {
  await page.waitForFunction(({ id, name, pressed }) => {
    const button = document.querySelector(`button[data-inbox-id="${id}"][data-inbox-tag="${name}"]`);
    return button?.getAttribute('aria-pressed') === String(pressed) && !button.disabled;
  }, { id, name, pressed });
}
async function selectFilters(read, tagged, count) {
  await page.locator('#inboxReadFilter').selectOption(read);
  await page.locator('#inboxTagFilter').selectOption(tagged);
  await waitCount(count);
}
async function assertGlobalUnread(count) {
  await page.waitForFunction((expected) => document.querySelector('#inboxButton')?.getAttribute('aria-label') === `收件箱，${expected} 条未读`, count);
  if (count) assert.equal(await page.locator('#inboxUnreadBadge').textContent(), String(count));
  else assert.equal(await page.locator('#inboxUnreadBadge').evaluate((node) => node.hidden), true);
}
async function login(username) {
  await page.locator('#authUsername').waitFor();
  await page.locator('#authUsername').fill(username);
  await page.locator('#authPassword').fill(password);
  await page.locator('#authForm [type="submit"]').click();
  await page.locator('#inboxReadFilter').waitFor();
}
async function snapshot(name) {
  await page.screenshot({ path: path.join(screenshots, name), fullPage: true });
}

try {
  const ownerSession = await request('/api/session', 'POST', { username: 'InboxOwner', password });
  assert.equal(ownerSession.status, 200);
  for (const fixture of fixtures.filter(({ number }) => number >= 13 && number <= 44)) {
    const saved = await request(`/api/inbox/${fixture.id}/tags`, 'PATCH', { tags: ['star'] }, ownerSession.cookie);
    assert.equal(saved.status, 200);
  }
  browser = await chromium.launch({ executablePath: executable, env: browserEnv, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.route('**/*', async (route) => {
    const incoming = route.request(), url = new URL(incoming.url());
    if (url.origin !== base) return route.abort();
    const index = interceptions.findIndex((action) => incoming.method() === (action.method || 'GET') && url.pathname === action.path && (!action.match || action.match(url)));
    if (index < 0) return route.continue();
    const [action] = interceptions.splice(index, 1);
    // Capturing immediately makes the delayed response represent old filter state.
    const response = action.capture ? await route.fetch() : null;
    action.started();
    if (action.delay) await delay(action.delay);
    if (action.hold) await action.hold;
    if (action.fail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'inbox simulated outage' }) });
    if (response) return route.fulfill({ response });
    return route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (incoming) => { const url = new URL(incoming.url()); if (url.origin === base) requests.push({ method: incoming.method(), path: url.pathname, query: url.search }); });
  const guidelineHold = holdIntercept({ path: '/api/penpa-guidelines' });
  const secondPageBefore = fixtures.find(({ number }) => number === 43).id;
  const secondPageHold = holdIntercept({ path: '/api/inbox', match: hasBefore(secondPageBefore) });
  await page.goto(`${base}/#messages`, { waitUntil: 'domcontentloaded' });
  await login('InboxOwner');
  await waitPage(1);
  await Promise.all([guidelineHold.started, secondPageHold.started]);
  await assertVisibleNumbers(Array.from({ length: 10 }, (_, index) => 52 - index));
  assert.equal(await tag(topId, 'star').isEnabled(), true);
  assert.equal(await page.locator('.inbox-list').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#previousInboxPageButton').isDisabled(), true);
  assert.equal(inboxGets().length, 2);
  assert.ok(inboxGets().every((entry) => new URLSearchParams(entry.query).get('limit') === '10'));
  assert.equal(requests.filter((entry) => entry.method === 'GET' && ['/api/calendar/puzzles', '/api/calendar/leftovers'].includes(entry.path)).length, 0);
  const pendingBefore = requests.length;
  await page.locator('#nextInboxPageButton').click();
  await page.waitForFunction(() => document.querySelector('.inbox-list')?.getAttribute('aria-busy') === 'true');
  assert.equal(await page.locator('article.inbox-item').count(), 10);
  assert.equal(inboxGets(pendingBefore, (params) => params.get('before') === String(secondPageBefore)).length, 0);
  secondPageHold.release();
  await waitPage(2);
  await assertVisibleNumbers(Array.from({ length: 10 }, (_, index) => 42 - index));
  await page.waitForFunction(() => !document.querySelector('#nextInboxPageButton')?.disabled);
  await delay(150);
  assert.equal(inboxGets().length, 3);
  const beforeCachedNavigation = requests.length;
  await page.locator('#previousInboxPageButton').click(); await waitPage(1);
  await assertVisibleNumbers(Array.from({ length: 10 }, (_, index) => 52 - index));
  await page.locator('#nextInboxPageButton').click(); await waitPage(2);
  assert.equal(inboxGets(beforeCachedNavigation).length, 0);
  await page.locator('#previousInboxPageButton').click(); await waitPage(1);
  guidelineHold.release();
  await delay(150);
  await waitPage(1);
  console.log('PASS: first ten render before guidelines or page two, one-page prefetch, pending next request reuse and cached previous/next navigation');
  await assertGlobalUnread(40);
  for (const name of ['star', 'flag', 'bookmark', 'heart']) {
    const button = tag(topId, name);
    assert.equal(await button.count(), 1);
    assert.equal(await button.locator('svg').count(), 1);
    assert.ok(await button.getAttribute('aria-label'));
    assert.ok(await button.getAttribute('title'));
    assert.equal((await button.textContent()).trim(), '');
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
  }
  const beforeSave = requests.length;
  const tagStarted = intercept({ method: 'PATCH', path: `/api/inbox/${topId}/tags`, delay: 900 });
  await tag(topId, 'star').click();
  await tagStarted;
  assert.equal(await tag(topId, 'star').isDisabled(), true);
  await tag(topId, 'star').evaluate((button) => button.click());
  await page.locator('#changeUsernameButton').click();
  assert.equal(await page.locator('#newUsername').count(), 0);
  await page.locator('#toast.show').filter({ hasText: '请等待消息保存完成后再修改用户名' }).waitFor();
  await waitPressed(topId, 'star', true);
  assert.equal(requests.slice(beforeSave).filter((entry) => entry.method === 'PATCH' && entry.path === `/api/inbox/${topId}/tags`).length, 1);
  await page.locator('#changeUsernameButton').click();
  await page.locator('#newUsername').waitFor();
  await page.locator('#modalBackdrop .modal-cancel').click();
  for (const name of ['flag', 'bookmark', 'heart']) { await tag(topId, name).click(); await waitPressed(topId, name, true); }
  await tag(topId, 'star').click(); await waitPressed(topId, 'star', false);
  let persisted = await request('/api/inbox?limit=50', 'GET', null, ownerSession.cookie);
  assert.deepEqual([...persisted.body.notifications.find((entry) => entry.id === topId).tags].sort(), ['bookmark', 'flag', 'heart']);
  await page.reload({ waitUntil: 'domcontentloaded' }); await waitCount(10);
  for (const name of ['flag', 'bookmark', 'heart']) assert.equal(await tag(topId, name).getAttribute('aria-pressed'), 'true');
  await snapshot('inbox-icons-browser-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await snapshot('inbox-icons-browser-mobile.png');
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const name of ['flag', 'bookmark', 'heart']) { await tag(topId, name).click(); await waitPressed(topId, name, false); }
  console.log('PASS: four accessible icon-only toggles, multiple labels, removal, persistence, duplicate protection and mobile layout');

  intercept({ method: 'PATCH', path: `/api/inbox/${topId}/tags`, fail: true });
  await tag(topId, 'star').click();
  await page.locator('.inbox-error').filter({ hasText: 'inbox simulated outage' }).waitFor();
  await waitPressed(topId, 'star', false);
  await tag(topId, 'star').click(); await waitPressed(topId, 'star', true);
  await tag(topId, 'star').click(); await waitPressed(topId, 'star', false);
  const failedRefresh = intercept({ path: '/api/inbox', fail: true });
  await page.locator('#refreshInboxButton').click(); await failedRefresh;
  await page.locator('.inbox-error').filter({ hasText: 'inbox simulated outage' }).waitFor();
  await page.locator('#refreshInboxButton').click(); await waitCount(10);
  assert.equal(await page.locator('.inbox-error').count(), 0);
  console.log('PASS: failed tag update retains selection, click retry saves, inbox refresh failure and retry recover');

  // A failed background prefetch must preserve the current page. A failed
  // foreground retry must also keep that page and leave next available to retry.
  const failedPrefetchResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/inbox'
    && new URL(response.url()).searchParams.get('before') === String(secondPageBefore) && response.status() === 500);
  const failedPrefetch = intercept({ path: '/api/inbox', match: hasBefore(secondPageBefore), fail: true });
  await page.locator('#refreshInboxButton').click(); await waitPage(1);
  await failedPrefetch; await failedPrefetchResponse;
  await delay(100);
  assert.equal(await page.locator('article.inbox-item').count(), 10);
  assert.equal(await page.locator('#nextInboxPageButton').isEnabled(), true);
  const beforeRetry = requests.length;
  const failedNext = intercept({ path: '/api/inbox', match: hasBefore(secondPageBefore), fail: true });
  await page.locator('#nextInboxPageButton').click(); await failedNext;
  await page.locator('.inbox-error').filter({ hasText: 'inbox simulated outage' }).waitFor();
  await waitPage(1);
  await assertVisibleNumbers(Array.from({ length: 10 }, (_, index) => 52 - index));
  await page.locator('#nextInboxPageButton').click(); await waitPage(2);
  await assertVisibleNumbers(Array.from({ length: 10 }, (_, index) => 42 - index));
  assert.equal(inboxGets(beforeRetry, (params) => params.get('before') === String(secondPageBefore)).length, 2);
  assert.equal(await page.locator('.inbox-error').count(), 0);
  await page.locator('#previousInboxPageButton').click(); await waitPage(1);
  console.log('PASS: a failed prefetch and failed next request retain the current page; retry succeeds');

  await selectFilters('read', 'untagged', 10);
  await assertGlobalUnread(40);
  assert.equal(await page.locator('.inbox-item.is-unread').count(), 0);
  assert.equal(await page.locator('[data-inbox-tag][aria-pressed="true"]').count(), 0);
  await selectFilters('unread', 'tagged', 10);
  await assertGlobalUnread(40);
  assert.equal(await page.locator('.inbox-item.is-read').count(), 0);
  assert.equal(await page.locator('[data-inbox-tag="star"][aria-pressed="true"]').count(), 10);
  const loadedIds = await visibleIds();
  for (const [number, count] of [[2, 10], [3, 10], [4, 2]]) {
    await page.locator('#nextInboxPageButton').click(); await waitPage(number, count);
    loadedIds.push(...await visibleIds());
  }
  assert.equal(new Set(loadedIds).size, 32);
  assert.equal(loadedIds.length, 32);
  assert.equal(await page.locator('#nextInboxPageButton').isDisabled(), true);
  await page.locator('#previousInboxPageButton').click(); await waitPage(3);
  await assertGlobalUnread(40);
  console.log('PASS: combined read/label filters, global unread badge and ten-item pages without duplicate or missing notifications');

  // A filter response captured before the next filter change must not replace it.
  await selectFilters('all', 'all', 10);
  const staleFilter = intercept({ path: '/api/inbox', match: (url) => url.searchParams.get('read') === 'read', capture: true, delay: 1000 });
  await page.locator('#inboxReadFilter').selectOption('read'); await staleFilter;
  await page.locator('#inboxReadFilter').selectOption('unread'); await waitCount(10);
  await delay(1200);
  assert.equal(await page.locator('#inboxReadFilter').inputValue(), 'unread');
  assert.equal(await page.locator('.inbox-item.is-read').count(), 0);
  assert.equal(await page.locator('article.inbox-item').count(), 10);
  await assertGlobalUnread(40);
  console.log('PASS: a late response for the previous filter cannot overwrite the current selection');

  const stalePrefetch = holdIntercept({ path: '/api/inbox', match: (url) => hasBefore(secondPageBefore)(url)
    && url.searchParams.get('read') === 'all' && url.searchParams.get('tag') === 'all' });
  await selectFilters('all', 'all', 10); await stalePrefetch.started;
  await selectFilters('unread', 'tagged', 10);
  stalePrefetch.release(); await delay(150);
  await waitPage(1);
  await assertVisibleNumbers(Array.from({ length: 10 }, (_, index) => 44 - index));
  await page.locator('#nextInboxPageButton').click(); await waitPage(2);
  await assertVisibleNumbers(Array.from({ length: 10 }, (_, index) => 34 - index));
  assert.equal(await page.locator('[data-inbox-tag="star"][aria-pressed="true"]').count(), 10);
  console.log('PASS: a previous filter\'s delayed prefetch cannot replace either the current page or its next page');

  // Adding a label removes the item from the untagged view and refills its page.
  const untaggedBefore = fixtures.find(({ number }) => number === 11).id;
  const staleTagPage = holdIntercept({ path: '/api/inbox', match: (url) => hasBefore(untaggedBefore)(url) && url.searchParams.get('tag') === 'untagged' });
  await selectFilters('all', 'untagged', 10); await staleTagPage.started;
  await tag(topId, 'star').click(); await item(topId).waitFor({ state: 'detached' });
  await waitPage(1);
  staleTagPage.release(); await delay(150);
  await assertVisibleNumbers([51, 50, 49, 48, 47, 46, 45, 12, 11, 10]);
  await page.locator('#nextInboxPageButton').click(); await waitPage(2, 9);
  await assertVisibleNumbers([9, 8, 7, 6, 5, 4, 3, 2, 1]);
  await selectFilters('all', 'all', 10);
  await waitPressed(topId, 'star', true);
  await tag(topId, 'star').click(); await waitPressed(topId, 'star', false);
  const taggedBefore = fixtures.find(({ number }) => number === 35).id;
  const staleReadPage = holdIntercept({ path: '/api/inbox', match: (url) => hasBefore(taggedBefore)(url) && url.searchParams.get('read') === 'unread' && url.searchParams.get('tag') === 'tagged' });
  await selectFilters('unread', 'tagged', 10); await staleReadPage.started;
  const markId = fixtures.find(({ number }) => number === 44).id;
  await page.locator(`[data-inbox-read="${markId}"]`).click();
  await item(markId).waitFor({ state: 'detached' });
  await waitPage(1);
  staleReadPage.release(); await delay(150);
  await assertVisibleNumbers(Array.from({ length: 10 }, (_, index) => 43 - index));
  await page.locator('#nextInboxPageButton').click(); await waitPage(2);
  await assertVisibleNumbers(Array.from({ length: 10 }, (_, index) => 33 - index));
  await assertGlobalUnread(39);
  assert.equal(await page.locator('.inbox-item.is-read').count(), 0);
  console.log('PASS: label and read mutations refill ten-item pages and invalidate stale prefetches and cursor boundaries');

  // Renaming reloads private data while retaining the current inbox filters.
  // Its old list request must not leave loading flags or replace the new list.
  await selectFilters('unread', 'tagged', 10);
  const renamedPageBefore = fixtures.find(({ number }) => number === 34).id;
  const staleRename = intercept({ path: '/api/inbox', match: (url) => hasBefore(renamedPageBefore)(url) && url.searchParams.get('read') === 'unread' && url.searchParams.get('tag') === 'tagged', capture: true, delay: 2000 });
  await page.locator('#refreshInboxButton').click(); await staleRename;
  await page.locator('#changeUsernameButton').click();
  await page.locator('#newUsername').fill('InboxRenamed');
  let finishRename;
  const renameHold = new Promise((resolve) => { finishRename = resolve; });
  const renameStarted = intercept({ method: 'PATCH', path: '/api/account/username', delay: 100, hold: renameHold });
  const beforeRename = requests.length;
  await page.locator('#saveUsernameButton').click();
  await renameStarted;
  try {
    await page.locator('#modalBackdrop .modal-cancel').click();
    assert.equal(await page.locator('#newUsername').count(), 0);
    // Finish a new list read while the rename remains pending, so the disabled
    // writes are protected by the rename guard rather than an inbox load.
    await selectFilters('unread', 'tagged', 10);
    assert.equal(await page.locator('.inbox-list').getAttribute('aria-busy'), 'false');
    const protectedButtons = page.locator('[data-inbox-tag], [data-inbox-read], #markAllInboxReadButton, #changeUsernameButton');
    assert.ok(await protectedButtons.count());
    assert.equal(await protectedButtons.evaluateAll((buttons) => buttons.every((button) => button.disabled)), true);
    // Dispatching bypasses the browser's disabled-click suppression and also
    // exercises the handlers' guards against writes during the rename.
    await protectedButtons.evaluateAll((buttons) => buttons.forEach((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true }))));
    await delay(100);
    assert.equal(await page.locator('#newUsername').count(), 0);
    assert.equal(requests.slice(beforeRename).filter((entry) => entry.path.startsWith('/api/inbox/') && ['PATCH', 'POST'].includes(entry.method)).length, 0);
    assert.equal(requests.slice(beforeRename).filter((entry) => entry.path === '/api/account/username' && entry.method === 'PATCH').length, 1);
  } finally { finishRename(); }
  await page.waitForFunction(() => document.querySelector('#profileButton strong')?.textContent === 'InboxRenamed');
  await waitCount(10);
  await delay(2200);
  assert.equal(await page.locator('#inboxReadFilter').inputValue(), 'unread');
  assert.equal(await page.locator('#inboxTagFilter').inputValue(), 'tagged');
  assert.equal(await page.locator('.inbox-item.is-read').count(), 0);
  assert.equal(await page.locator('[data-inbox-tag="star"][aria-pressed="true"]').count(), 10);
  assert.equal(await item(topId).count(), 0);
  assert.equal(await page.locator('#refreshInboxButton').isEnabled(), true);
  assert.equal(await page.locator('.inbox-error').count(), 0);
  await assertGlobalUnread(39);
  await page.locator('#refreshInboxButton').click(); await waitCount(10);
  assert.equal(await page.locator('[data-inbox-tag="star"][aria-pressed="true"]').count(), 10);
  assert.equal(db.database.prepare('SELECT username FROM trusted_users WHERE id=?').get('inbox-owner').username, 'InboxRenamed');
  assert.equal(await page.locator('#changeUsernameButton').isEnabled(), true);
  assert.equal(await page.locator('[data-inbox-tag], [data-inbox-read], #markAllInboxReadButton').evaluateAll((buttons) => buttons.every((button) => !button.disabled)), true);
  await page.locator('#changeUsernameButton').click(); await page.locator('#newUsername').waitFor();
  await page.locator('#modalBackdrop .modal-cancel').click();
  console.log('PASS: pending inbox saves defer username editing; a closed pending rename blocks writes, then retains filters and releases controls after an old response');

  // Capture the owner's response, then log out and sign in as another member.
  await selectFilters('all', 'all', 10);
  const staleSession = intercept({ path: '/api/inbox', match: hasBefore(secondPageBefore), capture: true, delay: 1300 });
  await page.locator('#refreshInboxButton').click(); await staleSession;
  await page.locator('#profileButton').click(); await page.locator('#authUsername').waitFor();
  await login('InboxOther'); await waitCount(1); await assertGlobalUnread(1);
  await delay(1500);
  assert.equal(await item(otherId).count(), 1);
  assert.equal(await item(topId).count(), 0);
  assert.equal(await page.locator('article.inbox-item').count(), 1);
  await assertGlobalUnread(1);
  await page.locator('#markAllInboxReadButton').click(); await assertGlobalUnread(0);
  assert.equal(await item(otherId).locator('.inbox-read-label').count(), 1);
  assert.deepEqual(errors, []);
  fs.rmSync(path.join(screenshots, 'inbox-browser-failure.png'), { force: true });
  console.log(`PASS: logout isolation, another member's private inbox, mark-all-read and no page exceptions. Screenshots: ${screenshots}`);
} catch (error) {
  if (page) { try { await snapshot('inbox-browser-failure.png'); } catch {} }
  console.error(`Inbox browser failure screenshot directory: ${screenshots}`);
  throw error;
} finally {
  for (const release of releaseHolds) release();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  db.database.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
