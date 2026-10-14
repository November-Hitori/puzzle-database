// Submission-draft acceptance uses temporary fixtures and never contacts production.
// Works with either the full-catalog picker or the lightweight asynchronous picker.
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
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-submission-drafts-'));
const screenshots = path.resolve(process.env.PUZARCHIVE_BROWSER_SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-submission-draft-screenshots-')));
fs.mkdirSync(screenshots, { recursive: true });
process.env.PUZARCHIVE_DB_PATH = path.join(directory, 'test.sqlite');
process.env.PUZARCHIVE_USERS_PATH = path.join(directory, 'users.json');
process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH = path.join(directory, 'penpa.md');
const ownerId = 'draft-owner', username = 'DraftOwner', password = 'isolated-submission-draft-pass';
fs.writeFileSync(process.env.PUZARCHIVE_USERS_PATH, JSON.stringify([{ id: ownerId, name: username, accessCode: randomBytes(24).toString('base64url') }]), { mode: 0o600 });
fs.copyFileSync(path.join(root, 'docs', 'penpa.md'), process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH);
const { createServer } = await import('../server.mjs');
const db = await import('../db.mjs');
const { hashPassword } = await import('../password-hash.mjs');
db.database.prepare('UPDATE trusted_users SET username=?,username_key=?,password_hash=? WHERE id=?').run(username, username.toLowerCase(), await hashPassword(password), ownerId);
const rule = db.addRule({ titleZh: '草稿保留测试规则', titleEn: 'Submission draft fixture', category: '其它', rulesZh: ['按临时题面线索完成谜题。'], rulesEn: [], isVariant: false, baseRuleId: null, exampleUrl: 'https://penpa-edit.com/?m=solve&p=draft-example', exampleAuthor: '' }, ownerId);
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const browserEnv = { ...process.env };
if (process.env.PUZARCHIVE_BROWSER_LIB_DIR) browserEnv.LD_LIBRARY_PATH = [process.env.PUZARCHIVE_BROWSER_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
const requests = [], errors = [], interceptions = [], releases = new Set();
let browser, page;
const calendarIds = ['newPuzzleTitle', 'newPuzzlePenpaEdit', 'newPuzzlePenpaSolve', 'newPuzzlePuzzlink', 'newPuzzleAuthor', 'newPuzzleMode', 'newPuzzleNote', 'newPuzzleAnswer', 'newPuzzleDateYear', 'newPuzzleDateMonth', 'newPuzzleDateDay', 'submissionRule', 'submissionRuleSearch'];
const libraryIds = ['newPuzzleTitle', 'newPuzzleUrl', 'newPuzzleAuthor', 'newPuzzleMode', 'newPuzzleNote', 'newPuzzleAnswer', 'submissionRule', 'submissionRuleSearch'];
function intercept(action) {
  let started, finished;
  const ready = new Promise((resolve) => { started = resolve; });
  const done = new Promise((resolve) => { finished = resolve; });
  interceptions.push({ ...action, started, finished });
  return { started: ready, finished: done };
}
function holdSave() {
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  releases.add(release);
  return { ...intercept({ path: '/api/calendar/puzzles', method: 'POST', capture: true, hold }), release: () => { release(); releases.delete(release); } };
}
async function waitInterception(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not arrive within 10 seconds`)), 10000); })]);
  } finally { clearTimeout(timer); }
}
async function browserSettled() {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function login() {
  await page.locator('#authUsername').fill(username);
  await page.locator('#authPassword').fill(password);
  await page.locator('#authForm [type="submit"]').click();
  await page.locator('#addCalendarPuzzleButton').waitFor();
}
async function renameAccount(nextUsername) {
  await page.locator('#accountMenuButton').click();
  await page.locator('#changeUsernameButton').click();
  await page.locator('#newUsername').fill(nextUsername);
  const responsePromise = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/account/username');
  await page.locator('#saveUsernameButton').click();
  assert.equal((await responsePromise).status(), 200);
  await page.locator('#modalBackdrop').waitFor({ state: 'hidden' });
  await page.waitForFunction((name) => document.querySelector('#profileButton strong')?.textContent === name && !document.querySelector('#changeUsernameButton')?.disabled, nextUsername);
  assert.equal(db.database.prepare('SELECT username FROM trusted_users WHERE id=?').get(ownerId).username, nextUsername, 'account rename keeps the fixture identity');
}
async function openSubmission(scope = 'calendar') {
  if (scope === 'library') {
    // The public-library view is retired, but its form still shares modal lifecycle.
    // This hook exists only in the local intercepted script response below.
    await page.evaluate(() => window.__submissionDraftBrowserTest.openLibrary());
  } else {
    await page.evaluate(() => { window.location.hash = '#calendar'; });
    await page.locator('#addCalendarPuzzleButton').click();
  }
  await page.locator('#newPuzzleTitle').waitFor();
}
async function closeSubmission(kind = 'cancel') {
  if (kind === 'backdrop') await page.locator('#modalBackdrop').click({ position: { x: 4, y: 4 } });
  else await page.locator(kind === 'close' ? '#modalBackdrop .modal-close' : '#modalBackdrop .modal-cancel').click();
  await page.locator('#modalBackdrop').waitFor({ state: 'hidden' });
}
async function selectRule(selected = rule) {
  await page.locator('#submissionRuleSearch').fill(selected.titleZh || selected.titleEn);
  const option = page.locator('#submissionRuleOptions [role="option"]').filter({ hasText: selected.titleZh || selected.titleEn }).first();
  await option.waitFor();
  await option.click();
  await page.waitForFunction((id) => document.querySelector('#submissionRule')?.value === String(id), selected.id);
  await page.locator('#submissionRulePreview').filter({ hasText: selected.rulesZh[0] }).waitFor();
}
async function fillFields(fields) {
  for (const [id, value] of Object.entries(fields)) {
    const input = page.locator(`#${id}`);
    if (id === 'newPuzzleMode' || id.endsWith('Month') || id.endsWith('Day')) await input.selectOption(value);
    else await input.fill(value);
  }
}
async function snapshot(scope = 'calendar') {
  return page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, document.getElementById(id)?.value])), scope === 'calendar' ? calendarIds : libraryIds);
}
async function assertSnapshot(expected, scope = 'calendar', message = 'raw submission fields survive closing') {
  assert.deepEqual(await snapshot(scope), expected, message);
}
async function assertFreshCalendar() {
  const fresh = await snapshot();
  for (const id of ['newPuzzleTitle', 'newPuzzlePenpaEdit', 'newPuzzlePenpaSolve', 'newPuzzlePuzzlink', 'newPuzzleNote', 'newPuzzleAnswer', 'newPuzzleDateMonth', 'newPuzzleDateDay', 'submissionRule', 'submissionRuleSearch']) assert.equal(fresh[id], '', `${id} starts empty after a successful submission or logout`);
  assert.equal(fresh.newPuzzleAuthor, username);
  assert.equal(fresh.newPuzzleMode, 'external');
  assert.equal(fresh.newPuzzleDateYear, '2028');
}
const calendarCount = () => Number(db.database.prepare("SELECT COUNT(*) AS count FROM puzzles WHERE scope='calendar'").get().count);
const calendarPosts = (start = 0) => requests.slice(start).filter((entry) => entry.method === 'POST' && entry.path === '/api/calendar/puzzles');

try {
  browser = await chromium.launch({ executablePath: executable, env: browserEnv, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.route('**/*', async (route) => {
    const incoming = route.request(), url = new URL(incoming.url());
    if (url.origin !== base) {
      if (incoming.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>隔离解题工具</body></html>' });
      return route.abort();
    }
    if (url.pathname === '/app.js') {
      const response = await route.fetch();
      return route.fulfill({ response, body: `${await response.text()}\nwindow.__submissionDraftBrowserTest = { openLibrary: () => openAddPuzzle('library') };\n` });
    }
    const index = interceptions.findIndex((action) => incoming.method() === action.method && url.pathname === action.path);
    if (index < 0) return route.continue();
    const [action] = interceptions.splice(index, 1);
    const response = action.capture ? await route.fetch() : null;
    action.started();
    if (action.hold) await action.hold;
    try {
      if (action.fail) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'isolated draft publish failure' }) });
      else if (response) await route.fulfill({ response });
      else await route.continue();
    } finally { action.finished(); }
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (incoming) => {
    const url = new URL(incoming.url());
    if (url.origin === base) requests.push({ method: incoming.method(), path: url.pathname });
  });
  await page.goto(`${base}/#calendar`, { waitUntil: 'domcontentloaded' });
  await login();
  await openSubmission();
  await selectRule();
  await fillFields({ newPuzzleTitle: '  草稿 <题目> & "标题"  ', newPuzzlePenpaEdit: 'https://penpa-edit.com/?m=edit&p=draft-edit', newPuzzlePenpaSolve: 'https://penpa-edit.com/?m=solve&p=draft-solve', newPuzzlePuzzlink: 'https://puzz.link/p?slither/3/3/0000', newPuzzleAuthor: '', newPuzzleMode: 'blank', newPuzzleNote: '  第一行说明\n第二行 <保留> & 原文  ', newPuzzleAnswer: '  08  ', newPuzzleDateYear: '2030', newPuzzleDateMonth: '03', newPuzzleDateDay: '' });
  const selectedDraft = await snapshot();
  for (const kind of ['backdrop', 'close', 'cancel']) {
    await closeSubmission(kind);
    await openSubmission();
    await assertSnapshot(selectedDraft, 'calendar', `${kind} preserves links, blank author, whitespace, mode, selected rule and half-filled date`);
  }
  console.log('PASS: backdrop, close button and cancel preserve every raw calendar field and the selected rule');

  await fillFields({ newPuzzleDateYear: '', newPuzzleDateMonth: '04', newPuzzleDateDay: '' });
  await page.locator('#submissionRuleSearch').fill('  未选定的搜索 <草稿> & 原文  ');
  await page.waitForFunction(() => document.querySelector('#submissionRule')?.value === '');
  const searchDraft = await snapshot();
  await closeSubmission('close');
  await openSubmission();
  await assertSnapshot(searchDraft, 'calendar', 'an empty year, partial date and unselected search query remain editable');
  console.log('PASS: empty year, partial date and unselected rule-search text survive closing');

  await fillFields({ newPuzzleDateYear: '2028', newPuzzleDateMonth: '02', newPuzzleDateDay: '29' });
  await selectRule();
  const inlineDraft = await snapshot();
  await page.locator('#createRuleFromSubmission').click();
  await page.locator('#ruleTitleZh').fill('草稿返回新规则');
  await page.locator('#ruleTitleEn').fill('Inline draft return');
  await page.locator('#ruleCategory').selectOption('其它');
  await page.locator('#ruleClausesZh').fill('内联规则的临时中文说明。');
  const createdRuleResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/rules');
  await page.locator('#saveRuleButton').click();
  const createdRule = await createdRuleResponse;
  assert.equal(createdRule.status(), 201);
  const newRule = (await createdRule.json()).rule;
  await page.locator('#newPuzzleTitle').waitFor();
  const returnedDraft = await snapshot();
  for (const id of calendarIds.filter((id) => !['submissionRule', 'submissionRuleSearch'].includes(id))) assert.equal(returnedDraft[id], inlineDraft[id], `inline creation preserves ${id}`);
  assert.equal(returnedDraft.submissionRule, String(newRule.id));
  await page.locator('#submissionRulePreview').filter({ hasText: newRule.rulesZh[0] }).waitFor();
  await closeSubmission();
  await openSubmission();
  await assertSnapshot(returnedDraft, 'calendar', 'the returned draft also survives another ordinary close');
  await page.screenshot({ path: path.join(screenshots, 'submission-draft-restored.png'), fullPage: true });
  console.log('PASS: inline rule creation returns the raw draft, preserves leap day and selects the new rule');

  await fillFields({ newPuzzleMode: 'external' });
  const publishDraft = await snapshot();
  const beforeFailure = calendarCount();
  const failedSave = intercept({ path: '/api/calendar/puzzles', method: 'POST', fail: true });
  await page.locator('#savePuzzleButton').click();
  await waitInterception(failedSave.finished, 'Failed publication');
  await page.locator('#submissionError').filter({ hasText: 'isolated draft publish failure' }).waitFor();
  assert.equal(calendarCount(), beforeFailure, 'a simulated publish failure never writes a puzzle');
  await assertSnapshot(publishDraft);
  assert.equal(await page.locator('#savePuzzleButton').isEnabled(), true, 'failed publication can be retried');
  await closeSubmission();
  await openSubmission();
  await assertSnapshot(publishDraft, 'calendar', 'failed publication remains available after closing');

  const beforeSuccess = calendarCount(), beforePosts = requests.length;
  const successfulSave = holdSave();
  const saveResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/calendar/puzzles');
  await page.locator('#savePuzzleButton').evaluate((button) => { button.click(); button.click(); });
  await waitInterception(successfulSave.started, 'Successful publication');
  assert.equal(await page.locator('#savePuzzleButton').isDisabled(), true, 'the publish button prevents repeated clicks while saving');
  assert.equal(calendarPosts(beforePosts).length, 1, 'two rapid clicks issue one publication request');
  successfulSave.release();
  await waitInterception(successfulSave.finished, 'Released publication response');
  assert.equal((await saveResponse).status(), 201);
  await page.locator('#modalBackdrop').waitFor({ state: 'hidden' });
  await page.locator('.puzzle-header h1').filter({ hasText: publishDraft.newPuzzleTitle.trim() }).waitFor();
  assert.equal(calendarCount(), beforeSuccess + 1, 'successful publication creates exactly one puzzle');
  await openSubmission();
  await assertFreshCalendar();
  console.log('PASS: failed publication preserves the draft; success clears it and rapid clicks create one puzzle');

  await selectRule();
  await fillFields({ newPuzzleTitle: '迟到发布的原草稿', newPuzzlePenpaSolve: 'https://penpa-edit.com/?m=solve&p=delayed-draft', newPuzzleAuthor: '', newPuzzleNote: '旧请求提交的说明' });
  const delayedSave = holdSave();
  const delayedResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/calendar/puzzles');
  await page.locator('#savePuzzleButton').click();
  await waitInterception(delayedSave.started, 'Delayed publication');
  await closeSubmission('close');
  await openSubmission();
  assert.equal(await page.locator('#savePuzzleButton').isDisabled(), true, 'reopening while the previous publication is pending cannot submit a duplicate');
  await fillFields({ newPuzzleTitle: '重新打开后修改的草稿', newPuzzleNote: '新的说明仍需保留', newPuzzleAnswer: '  later answer  ' });
  const newerDraft = await snapshot(), hashBeforeResponse = new URL(page.url()).hash;
  await page.evaluate(() => { window.__submissionDraftBrowserTest.currentTitle = document.querySelector('#newPuzzleTitle'); });
  delayedSave.release();
  await waitInterception(delayedSave.finished, 'Released delayed publication response');
  const oldResponse = await delayedResponse;
  assert.equal(oldResponse.status(), 201);
  await oldResponse.finished();
  await browserSettled();
  assert.equal(await page.locator('#modalBackdrop').isVisible(), true, 'late success leaves the new submission open');
  assert.equal(new URL(page.url()).hash, hashBeforeResponse, 'late success does not redirect the new form');
  assert.equal(await page.evaluate(() => window.__submissionDraftBrowserTest.currentTitle === document.querySelector('#newPuzzleTitle')), true, 'late success does not replace the new form');
  await assertSnapshot(newerDraft);
  assert.equal(await page.locator('#savePuzzleButton').isEnabled(), true, 'the reopened edited draft can be published after the old request finishes');
  await closeSubmission('backdrop');
  await openSubmission();
  await assertSnapshot(newerDraft, 'calendar', 'late success does not clear the newer saved draft');
  console.log('PASS: a delayed successful publication neither closes nor clears the reopened and edited form');

  await closeSubmission();
  await openSubmission('library');
  assert.equal(await page.locator('#newPuzzleTitle').inputValue(), '', 'public-library draft begins independently of calendar');
  assert.equal(await page.locator('#newPuzzleDateYear').count(), 0);
  await selectRule();
  await fillFields({ newPuzzleTitle: '独立的公共题库草稿', newPuzzleUrl: 'https://puzz.link/p?slither/3/3/0000', newPuzzleAuthor: '', newPuzzleMode: 'blank', newPuzzleNote: '公共题库说明', newPuzzleAnswer: 'library answer' });
  const publicDraft = await snapshot('library');
  await closeSubmission('close');
  await openSubmission();
  await assertSnapshot(newerDraft, 'calendar', 'library editing does not replace the calendar draft');
  await closeSubmission();
  await openSubmission('library');
  await assertSnapshot(publicDraft, 'library', 'calendar editing does not replace the library draft');
  await closeSubmission();
  console.log('PASS: public-library and calendar drafts remain separate');

  await openSubmission();
  await fillFields({ newPuzzleTitle: '修改用户名期间的待发布草稿', newPuzzleAuthor: '', newPuzzleNote: '更名后仍需保留的原始说明' });
  const renameDraft = await snapshot();
  const renameSave = holdSave();
  const renameSaveResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/calendar/puzzles');
  await page.locator('#savePuzzleButton').click();
  await waitInterception(renameSave.started, 'Publication before account rename');
  await closeSubmission('close');
  await renameAccount('DraftRenamed');
  await openSubmission();
  await assertSnapshot(renameDraft, 'calendar', 'changing username keeps the closed pending submission draft');
  assert.equal(await page.locator('#savePuzzleButton').isDisabled(), true, 'the original request still blocks duplicate publication after account rename');
  const hashBeforeRenameResponse = new URL(page.url()).hash;
  renameSave.release();
  await waitInterception(renameSave.finished, 'Released publication response after account rename');
  const renamedResponse = await renameSaveResponse;
  assert.equal(renamedResponse.status(), 201);
  await renamedResponse.finished();
  await page.waitForFunction(() => document.querySelector('#savePuzzleButton') && !document.querySelector('#savePuzzleButton').disabled);
  await browserSettled();
  assert.equal(await page.locator('#modalBackdrop').isVisible(), true, 'the old session response leaves the renamed account form open');
  assert.equal(new URL(page.url()).hash, hashBeforeRenameResponse, 'the old session response does not redirect after account rename');
  await assertSnapshot(renameDraft, 'calendar', 'settling the old session request unlocks publication without clearing the draft');
  await closeSubmission();
  await openSubmission();
  await assertSnapshot(renameDraft, 'calendar', 'the renamed account draft survives another close after the pending request settles');
  assert.equal(await page.locator('#savePuzzleButton').isEnabled(), true, 'the cleared pending state remains available after reopening');
  await closeSubmission();
  await renameAccount(username);
  console.log('PASS: a real username change during pending publication preserves the draft and releases the save button');

  await page.locator('#accountMenuButton').click();
  await page.locator('#loginButton').click();
  await page.locator('#authUsername').waitFor();
  await page.waitForFunction(() => !document.querySelector('#authForm [type="submit"]').disabled);
  await login();
  await openSubmission();
  await assertFreshCalendar();
  await closeSubmission();
  await openSubmission('library');
  for (const id of ['newPuzzleTitle', 'newPuzzleUrl', 'newPuzzleNote', 'newPuzzleAnswer', 'submissionRule', 'submissionRuleSearch']) assert.equal(await page.locator(`#${id}`).inputValue(), '', `logout clears public-library ${id}`);
  await closeSubmission();
  assert.deepEqual(errors, []);
  console.log(`PASS: logout and login clear both scopes without browser errors. Screenshots: ${screenshots}`);
} catch (error) {
  if (page) { try { await page.screenshot({ path: path.join(screenshots, 'submission-draft-failure.png'), fullPage: true }); } catch {} }
  console.error(`Submission draft failure screenshots: ${screenshots}`);
  throw error;
} finally {
  for (const release of releases) release();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  db.database.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
