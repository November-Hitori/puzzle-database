import { getPuzzleSource, hasConcretePuzzlePayload, isConcretePenpaPuzzleUrl, parseTrustedPuzzleUrl } from './puzzle-url.mjs';
import { buildPuzzleToolLinks } from './puzzle-tool-links.mjs';
import { normalizeUsername, validateAccountPassword } from './auth-policy.mjs';
import { normalizeCalendarLinks, getCalendarArea } from './calendar-workflow-policy.mjs';
import { CALENDAR_REVIEW_TAGS, CALENDAR_REVIEW_VOTES } from './calendar-review-policy.mjs';
import { INBOX_TAGS } from './inbox-policy.mjs';

const state = {
  puzzles: [],
  calendarPuzzles: [],
  calendarLeftovers: [],
  rules: [],
  rulesStatus: 'idle',
  rulesError: '',
  folders: [],
  visible: 6,
  sort: 'recent',
  filter: 'all',
  filePath: ['全部文件'],
  collections: [],
  api: true,
  user: null,
  sessionChecked: false,
  authMode: 'login',
  authBusy: false,
  usernameRenamePending: false,
  authError: '',
  authEpoch: 0,
  logoutPending: false,
  serviceError: '',
  privateLoading: false,
  sessionEpoch: 0,
  calendarSort: 'date',
  calendarMonth: 1,
  calendarViewYear: 2028,
  penpaGuidelines: null,
  calendarReturnRoute: 'calendar',
  inboxItems: [],
  inboxUnreadCount: 0,
  inboxNextBefore: null,
  inboxLoading: false,
  inboxError: '',
  inboxActionError: '',
  inboxPendingIds: new Set(),
  inboxReadAllPending: false,
  inboxReadFilter: 'all',
  inboxTagFilter: 'all',
  lastPrivateRouteName: null,
  ruleFilter: 'all',
  ruleQuery: '',
  submissionDraft: null,
  auditPending: new Set()
};
const app = document.querySelector('#app');
const modalBackdrop = document.querySelector('#modalBackdrop');
const modalContent = document.querySelector('#modalContent');
const toastElement = document.querySelector('#toast');
let toastTimer;
const API_REQUEST_TIMEOUT_MS = 20000;
let privateLoadAttempt = 0;
let privateLoadController = null;
let rulesLoadPromise = null;
let inboxLoadAttempt = 0;
let inboxLoadController = null;

async function apiRequest(path, options = {}) {
  const authEndpoint = ['/api/session', '/api/register'].includes(path);
  const requestEpoch = state.sessionEpoch;
  const requestUserId = state.user?.id;
  const authenticatedAtStart = Boolean(state.user);
  const { signal, ...requestOptions } = options;
  const readRequest = ['GET', 'HEAD'].includes(String(requestOptions.method || 'GET').toUpperCase());
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...requestOptions, signal: controller.signal });
    let payload = {};
    if (response.status !== 204) {
      try { payload = await response.json(); }
      catch (error) {
        if (!authEndpoint && (requestEpoch !== state.sessionEpoch || String(state.user?.id) !== String(requestUserId))) throw new Error('请求已取消。');
        throw error;
      }
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!authEndpoint && (requestEpoch !== state.sessionEpoch || String(state.user?.id) !== String(requestUserId))) throw new Error('请求已取消。');
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      message = payload.error || message;
      if (response.status === 401 && state.sessionChecked && authenticatedAtStart && !authEndpoint) handleUnauthorized();
      const error = new Error(message); error.status = response.status; throw error;
    }
    return payload;
  } catch (error) {
    if (timedOut) {
      if (!authEndpoint && (requestEpoch !== state.sessionEpoch || String(state.user?.id) !== String(requestUserId))) throw new Error('请求已取消。');
      throw new Error(readRequest ? '请求超时，请重试。' : '请求超时，操作结果尚未确认，请刷新页面确认后再操作。');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
function applyPuzzleData(puzzles) { state.puzzles = puzzles.map((puzzle) => ({ ...puzzle, ratings: (puzzle.ratings || [0, 0, 0]).map(Number), tags: puzzle.tags || [], userRating: puzzle.userRating || null, votes: Number(puzzle.votes || 0) })); }
async function bootstrapDatabase() { clearPrivateState(); const epoch = ++state.sessionEpoch; state.sessionChecked = false; state.authError = ''; renderRoute(); try { const session = await apiRequest('/api/session'); if (epoch !== state.sessionEpoch) return; state.sessionChecked = true; state.user = session.user || null; if (!state.user) { renderRoute(); return; } normalizeAuthenticatedRoute(); renderRoute(); await loadPrivateData(); } catch (error) { if (epoch !== state.sessionEpoch) return; state.sessionChecked = true; state.user = null; state.serviceError = error.message || '服务暂不可用'; renderRoute(); } }
async function loadPrivateData() {
  if (!state.user) return;
  const epoch = state.sessionEpoch;
  const userId = state.user.id;
  const attempt = ++privateLoadAttempt;
  privateLoadController?.abort();
  const controller = new AbortController();
  privateLoadController = controller;
  const isCurrentAttempt = () => attempt === privateLoadAttempt && isCurrentUserSession(epoch, userId);
  state.privateLoading = true;
  state.serviceError = '';
  renderRoute();
  try {
    const [calendarData, leftoverData, inboxData, guidelinesData] = await Promise.all([
      '/api/calendar/puzzles', '/api/calendar/leftovers', `/api/inbox?${new URLSearchParams({ limit: '20', read: state.inboxReadFilter, tag: state.inboxTagFilter })}`, '/api/penpa-guidelines'
    ].map((path) => apiRequest(path, { signal: controller.signal })));
    if (!isCurrentAttempt()) return;
    state.penpaGuidelines = guidelinesData;
    state.calendarPuzzles = (calendarData.puzzles || []).map(normalizePuzzle);
    state.calendarLeftovers = (leftoverData.puzzles || []).map(normalizePuzzle);
    state.inboxItems = inboxData.notifications || [];
    state.inboxUnreadCount = Number(inboxData.unreadCount || 0);
    state.inboxNextBefore = inboxData.nextBefore || null;
    state.lastPrivateRouteName = getRoute().name;
  } catch (error) {
    controller.abort();
    if (!isCurrentAttempt()) return;
    state.serviceError = error.message || '无法加载私人数据';
  } finally {
    if (privateLoadController === controller) privateLoadController = null;
    if (isCurrentAttempt()) {
      state.privateLoading = false;
      renderRoute();
    }
  }
}
function normalizePuzzle(puzzle) { return { ...puzzle, ratings: (puzzle.ratings || [0, 0, 0]).map(Number), userRating: puzzle.userRating || null, votes: Number(puzzle.votes || 0), tags: puzzle.tags || [] }; }
function isCurrentUserSession(epoch, userId) { return epoch === state.sessionEpoch && Boolean(state.user) && String(state.user.id) === String(userId); }
function loadRules() {
  if (!state.user) return Promise.resolve(false);
  if (state.rulesStatus === 'loaded') return Promise.resolve(true);
  if (rulesLoadPromise) return rulesLoadPromise;
  const epoch = state.sessionEpoch; const userId = state.user.id;
  state.rulesStatus = 'loading'; state.rulesError = '';
  let request;
  request = (async () => {
    await Promise.resolve();
    try {
      const data = await apiRequest('/api/rules');
      if (!isCurrentUserSession(epoch, userId)) return false;
      state.rules = data.rules || [];
      state.rulesStatus = 'loaded'; state.rulesError = '';
      if (getRoute().name === 'rules') renderRoute();
      return true;
    } catch (error) {
      if (!isCurrentUserSession(epoch, userId)) return false;
      state.rulesStatus = 'error'; state.rulesError = error.message || '规则目录加载失败。';
      if (getRoute().name === 'rules') renderRoute();
      return false;
    } finally {
      if (rulesLoadPromise === request) rulesLoadPromise = null;
    }
  })();
  rulesLoadPromise = request;
  if (getRoute().name === 'rules' && modalBackdrop.hidden) renderRoute();
  return request;
}
function invalidateRules() { state.rules = []; state.rulesStatus = 'idle'; state.rulesError = ''; rulesLoadPromise = null; }
function requireRulesForModal(title, openWhenReady) {
  const epoch = state.sessionEpoch; const userId = state.user?.id;
  openModal(`<p class="modal-eyebrow">RULE CATALOG</p><h2 id="modalTitle">${esc(title)}</h2><p class="modal-intro" role="status" id="requiredRulesStatus">正在加载规则目录…</p><div class="modal-error" id="requiredRulesError" role="alert"></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button><button class="button button-dark" id="retryRequiredRulesButton" type="button" hidden>重试加载</button></div>`);
  const status = document.querySelector('#requiredRulesStatus'); const error = document.querySelector('#requiredRulesError'); const retry = document.querySelector('#retryRequiredRulesButton');
  const attempt = async () => {
    status.textContent = '正在加载规则目录…'; error.textContent = ''; retry.hidden = true;
    const loaded = await loadRules();
    if (!isCurrentUserSession(epoch, userId) || !status.isConnected) return;
    if (loaded) { openWhenReady(); return; }
    status.textContent = '无法继续，规则目录尚未加载。'; error.textContent = state.rulesError || '规则目录加载失败。'; retry.hidden = false;
  };
  retry.addEventListener('click', attempt);
  void attempt();
}
function clearPrivateState() { inboxLoadAttempt += 1; inboxLoadController?.abort(); inboxLoadController = null; privateLoadAttempt += 1; privateLoadController?.abort(); privateLoadController = null; state.sessionEpoch += 1; state.authEpoch += 1; state.user = null; state.puzzles = []; state.calendarPuzzles = []; state.calendarLeftovers = []; state.rules = []; state.rulesStatus = 'idle'; state.rulesError = ''; rulesLoadPromise = null; state.folders = []; state.collections = []; state.currentCollection = null; state.submissionDraft = null; state.penpaGuidelines = null; state.auditPending = new Set(); state.calendarReturnRoute = 'calendar'; state.inboxItems = []; state.inboxUnreadCount = 0; state.inboxNextBefore = null; state.inboxLoading = false; state.inboxError = ''; state.inboxActionError = ''; state.inboxPendingIds = new Set(); state.inboxReadAllPending = false; state.inboxReadFilter = 'all'; state.inboxTagFilter = 'all'; state.lastPrivateRouteName = null; state.serviceError = ''; state.authError = ''; state.privateLoading = false; state.authBusy = false; state.usernameRenamePending = false; clearTimeout(toastTimer); toastElement.classList.remove('show'); toastElement.textContent = ''; closeModal(); }
function handleUnauthorized() { clearPrivateState(); state.sessionChecked = true; state.authMode = 'login'; state.authError = '登录状态已失效，请重新登录。'; renderRoute(); }
function esc(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function ratingMarkup(values, votes) { return `<div class="rating-set" title="${votes} 位解题者的平均评分"><span class="rating-item">✎ <b>${values[0].toFixed(1)}</b></span><span class="rating-item">♧ <b>${values[1].toFixed(1)}</b></span><span class="rating-item">♥ <b>${values[2].toFixed(1)}</b></span></div>`; }
function tagMarkup(tags) { return `<div class="tag-list">${tags.map((tag) => `<span class="tag ${tag === 'Wrong Puzzle' ? 'warning' : tag === 'Example Puzzle' ? 'type' : ''}">${esc(tag)}</span>`).join('')}</div>`; }
function showToast(message) { if (document.body.dataset.authState !== 'authenticated') return; toastElement.textContent = message; toastElement.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastElement.classList.remove('show'), 2600); }
function openModal(content) { modalContent.innerHTML = content; modalBackdrop.hidden = false; document.body.style.overflow = 'hidden'; }
function closeModal() { modalBackdrop.hidden = true; modalContent.innerHTML = ''; document.body.style.overflow = ''; }
function button(text, id = '', className = 'button button-dark') { return `<button class="${className}" type="button"${id ? ` id="${id}"` : ''}>${text}</button>`; }

function getRoute() { const hash = window.location.hash.slice(1) || 'home'; const calendarMatch = hash.match(/^calendar-puzzle-(\d+)$/); const puzzleMatch = hash.match(/^puzzle-(\d+)$/); const collectionMatch = hash.match(/^collection-(\d+)$/); if (calendarMatch) return { name: 'calendar-puzzle', number: Number(calendarMatch[1]) }; if (puzzleMatch) return { name: 'puzzle', number: Number(puzzleMatch[1]) }; if (collectionMatch) return { name: 'collection', id: Number(collectionMatch[1]) }; return { name: hash.split('/')[0] || 'home' }; }
function normalizeAuthenticatedRoute() { const route = getRoute(); if (!['calendar', 'pending', 'leftovers', 'allocation', 'finished', 'messages', 'rules', 'calendar-puzzle'].includes(route.name)) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#calendar`); return getRoute(); }
function setBreadcrumb(name) { const labels = { home: '谜题日历', library: '谜题日历', collections: '谜题日历', collection: '谜题日历', files: '谜题日历', records: '谜题日历', authors: '谜题日历', puzzle: '谜题日历', pending: '我的未完成谜题', leftovers: 'leftover 区', allocation: '待分配区', finished: '完成区', messages: '收件箱', calendar: '谜题日历', 'calendar-puzzle': state.calendarReturnRoute === 'pending' ? '我的未完成谜题' : state.calendarReturnRoute === 'leftovers' ? '待重新进入' : '日历谜题', rules: '规则管理' }; const crumb = document.querySelector('#breadcrumbCurrent'); if (crumb) crumb.textContent = labels[name] || '谜题日历'; const activeRoute = name === 'calendar-puzzle' ? (['leftovers','allocation','finished','pending'].includes(state.calendarReturnRoute) ? state.calendarReturnRoute : 'calendar') : name; document.querySelectorAll('[data-route-link]').forEach((link) => link.classList.toggle('active', link.dataset.routeLink === activeRoute)); }

function filteredPuzzles() {
  const filtered = state.puzzles.filter((puzzle) => { if (state.filter === 'completed') return puzzle.completed; if (state.filter === 'wrong') return puzzle.tags.includes('Wrong Puzzle'); if (state.filter === 'logic') return puzzle.type === '逻辑题'; if (state.filter === 'word') return puzzle.type === '文字题'; return true; });
  return [...filtered].sort((a, b) => state.sort === 'rating' ? b.ratings[2] - a.ratings[2] : b.number - a.number);
}

function renderLibrary() {
  const items = filteredPuzzles().slice(0, state.visible);
  const completed = state.puzzles.filter((puzzle) => puzzle.completed).length;
  const completionPercent = state.puzzles.length ? Math.round(completed / state.puzzles.length * 100) : 0;
  return `<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span>PUZZLE LIBRARY</p><h1 id="page-title">题库<span class="heading-period">.</span></h1></div>${button('<span class="button-plus">+</span>添加题目', 'addPuzzleButton')}</section><section class="notice-strip" aria-label="公告"><div class="notice-symbol">✦</div><div class="notice-copy"><span class="notice-kicker">公告 · OCT 2026</span><strong>秋季谜题交换开始了</strong><span>提交你的原创题目，和朋友交换一场解题。</span></div><button class="text-button" type="button" id="noticeButton">查看公告 <span>→</span></button></section><section class="overview-grid" aria-label="题库概览"><div class="stat-block"><span class="stat-label">全部题目</span><strong>${state.puzzles.length}</strong><span class="stat-meta positive">题库内容</span></div><div class="stat-block"><span class="stat-label">已完成</span><strong>${completed}</strong><span class="stat-meta"><span class="mini-bar"><i style="width: ${completionPercent}%"></i></span>${completionPercent}% 已完成</span></div><div class="stat-block stat-block-wide"><span class="stat-label">评分机制</span><div class="activity-line"><span class="rating-legend">✎ 逻辑难度　♧ 通灵难度　♥ 喜爱程度</span></div></div></section><section class="library-section" id="library"><div class="section-heading"><div class="section-title-group"><h2>所有题目</h2><span class="count-badge">${String(state.puzzles.length).padStart(2, '0')}</span></div><div class="view-controls"><div class="segmented-control" role="tablist" aria-label="题目排序"><button class="segment ${state.sort === 'recent' ? 'active' : ''}" type="button" data-sort="recent">最近添加</button><button class="segment ${state.sort === 'number' ? 'active' : ''}" type="button" data-sort="number">题号</button><button class="segment ${state.sort === 'rating' ? 'active' : ''}" type="button" data-sort="rating">评分</button></div><button class="icon-button bordered" type="button" title="筛选" aria-label="筛选" id="filterButton">☷</button></div></div><div class="filter-row" id="filterRow" ${state.filter === 'all' ? 'hidden' : ''}><span class="filter-caption">FILTER BY</span>${[['all', '全部'], ['logic', '逻辑题'], ['word', '文字题'], ['completed', '已完成'], ['wrong', 'Wrong Puzzle']].map(([value, label]) => `<button class="filter-pill ${state.filter === value ? 'active' : ''}" data-filter="${value}" type="button">${label}</button>`).join('')}</div><div class="puzzle-table" role="table" aria-label="谜题列表"><div class="table-head" role="row"><span class="cell-number">NO.</span><span class="cell-puzzle">PUZZLE</span><span class="cell-author">AUTHOR</span><span class="cell-tags">TAGS</span><span class="cell-rating">AVERAGE RATING</span><span class="cell-action"></span></div><div id="puzzleRows">${items.map(renderPuzzleRow).join('') || '<div class="empty-state">题库还没有谜题。</div>'}</div></div><div class="table-footer"><span>显示 <strong>${items.length}</strong> / ${state.puzzles.length} 道题目</span><button class="text-button" type="button" id="loadMoreButton" ${items.length >= filteredPuzzles().length ? 'hidden' : ''}>加载更多 <span>↓</span></button></div></section></div>`;
}

function renderPuzzleRow(puzzle) { return `<div class="puzzle-row ${puzzle.completed ? 'completed' : ''}" role="row"><span class="cell-number" role="cell">#${puzzle.number}</span><div class="puzzle-main" role="cell"><a class="puzzle-title" href="#puzzle-${puzzle.number}">${esc(puzzle.title)}</a><span class="puzzle-subtitle">${esc(puzzle.type)} · ${esc(puzzle.source)}</span></div><span class="cell-author" role="cell"><a class="author-link" href="#authors">${esc(puzzle.author)}</a></span><span class="cell-tags" role="cell">${tagMarkup(puzzle.tags)}</span><span class="cell-rating" role="cell">${ratingMarkup(puzzle.ratings, puzzle.votes)}</span><a class="row-action" title="打开详情" aria-label="打开 ${esc(puzzle.title)}" href="#puzzle-${puzzle.number}">›</a></div>`; }

const ruleCategories = ['涂黑', '填数', '分区', '置物', '路径', '其它'];
function calendarStatusLabel(status) { return ({ pending: '待审核', approved: '喜爱程度评分已通过', leftover: 'leftover', review:'待审核区', allocation:'待分配区', finished:'完成区' })[status] || '待审核'; }
function calendarDateLabel(puzzle) {
  if (puzzle.suggestedDate) return String(puzzle.suggestedDate);
  const year = Number(puzzle.calendarYear) || 2028;
  const monthDay = String(puzzle.suggestedMonthDay || '');
  return /^\d{2}-\d{2}$/.test(monthDay) ? `${year}-${monthDay}` : `${year} · 日期未定`;
}
function calendarSortKey(puzzle) { const label = calendarDateLabel(puzzle); return /^\d{4}-\d{2}-\d{2}$/.test(label) ? label : `${Number(puzzle.calendarYear) || 2028}-99-99`; }
function calendarReviewSummary(review = {}) {
  const average = review.averageScore===null || review.averageScore===undefined ? '暂无' : Number(review.averageScore).toLocaleString('zh-CN',{maximumSignificantDigits:3});
  return `喜爱评分 ${Number(review.scoredCount)||0} 人 · 平均 ${average} · 否决 ${Number(review.veto)||0}`;
}
function participantNamesMarkup(participants, emptyLabel) {
  if (!Array.isArray(participants) || !participants.length) return `<span class="participant-empty">${esc(emptyLabel)}</span>`;
  return participants.map((participant) => `<span class="participant-name">${esc(participant?.username || participant?.name || '未知用户')}</span>`).join('');
}
function calendarReviewParticipantsMarkup(participants = {}) {
  const groups=[-2,-1,0,1,2,'veto'].map(value=>[value,value==='veto'?'一票否决':`${value>0?'+':''}${value} 分`,value==='veto'?'暂无否决':'暂无此分值的评价']);
  return `<dl class="participant-list vote-participants">${groups.map(([value,label,emptyLabel])=>`<div class="participant-row" data-liking-value="${value}"><dt>${label}</dt><dd>${participantNamesMarkup(participants?.[value],emptyLabel)}</dd></div>`).join('')}</dl>`;
}
function ratingParticipantsMarkup(participants, label = '评分者') {
  return `<dl class="participant-list rating-participants"><div class="participant-row"><dt>${esc(label)}</dt><dd>${participantNamesMarkup(participants, '尚无人评分')}</dd></div></dl>`;
}
function calendarEvaluationSummary(summary = {}) { const average = Number(summary.averageDifficulty); return Number.isFinite(average) && average > 0 ? `平均难度 ${average.toFixed(1)} / 6` : '暂无难度评价'; }
function calendarDifficultyMarkup(puzzle, summary) {
  const content = esc(calendarEvaluationSummary(summary));
  return puzzle.completed ? content : `<span class="spoiler"><button type="button" class="spoiler-toggle" aria-expanded="false">剧透 · 点击查看平均难度</button><span class="spoiler-content" hidden>${content}</span></span>`;
}
function bindDifficultySpoilers(root = document) {
  root.querySelectorAll('.spoiler-toggle').forEach((control) => control.addEventListener('click', (event) => {
    event.preventDefault(); event.stopPropagation();
    control.setAttribute('aria-expanded', 'true');
    control.nextElementSibling.hidden = false;
    control.hidden = true;
  }));
}
function renderQualityErrors(errors, entityType, entityNumber) {
  if (!errors.length) return '';
  return `<ul class="quality-error-list">${errors.map((error)=>`<li class="${error.ignored?'quality-ignored':'quality-error'}"><div><strong>${esc(error.message)}</strong>${error.ignored?`<span class="ignored-error-mark">已忽略</span><small>由 ${esc(error.ignore?.username || error.ignore?.name || '成员')} 忽略${error.ignore?.reason?` · ${esc(error.ignore.reason)}`:''}；仍需完成审计</small>`:''}</div>${error.inheritedIgnore?'<span class="muted">规则层面已忽略，可在规则目录恢复</span>':`<button type="button" class="text-button" data-error-ignore="${error.ignored?'restore':'ignore'}" data-error-entity="${entityType}" data-error-number="${entityNumber}" data-error-key="${esc(error.key)}" data-error-revision="${error.revision}">${error.ignored?'恢复错误':'忽略此错误'}</button>`}</li>`).join('')}</ul>`;
}
function applyRuleToCalendarPuzzles(rule) {
  const update = (puzzle) => {
    if (Number(puzzle.ruleId)!==Number(rule.id) || !puzzle.quality) return puzzle;
    const previous = puzzle.quality.errors;
    const errors = previous.filter((error)=>!error.key.startsWith('rule:')).concat(rule.quality.errors.map((error)=>{
      const key = `rule:${rule.id}:${error.key}`;
      const old = previous.find((entry)=>entry.key===key && entry.revision===error.revision && entry.ignore?.entityType==='puzzle' && entry.ignored);
      return {...error,key,inheritedIgnore:error.ignored,ignored:error.ignored||Boolean(old),...(old?{ignore:old.ignore}:{}),message:`所属规则：${error.message}`};
    }));
    const warnings = puzzle.quality.warnings.filter((warning)=>warning.code!=='ruleNotAudited');
    if (rule.quality.warnings.length) warnings.push({code:'ruleNotAudited',message:'所属规则尚未完成审计'});
    return {...puzzle,rule,quality:{...puzzle.quality,errors,warnings},calendarArea:getCalendarArea(puzzle.calendarStatus,errors,warnings)};
  };
  state.calendarPuzzles = state.calendarPuzzles.map(update);
  state.calendarLeftovers = state.calendarLeftovers.map(update);
}
function bindQualityIgnores(root = document) {
  root.querySelectorAll('[data-error-ignore]').forEach((control)=>control.addEventListener('click',()=>{
    const {errorEntity:type,errorNumber:number,errorKey:key,errorRevision:revision,errorIgnore:action} = control.dataset;
    const ignored = action==='ignore';
    openModal(`<p class="modal-eyebrow">QUALITY REVIEW</p><h2 id="modalTitle">${ignored?'忽略此错误':'恢复此错误'}</h2><p class="modal-intro">${ignored?'此项会明确显示为已忽略，但审计仍需三人通过。对应内容修改后，旧版本的忽略会失效。':'恢复后，此项重新计入错误并阻止进入完成区。'}</p><label class="form-field"><span>说明（可选）</span><textarea id="qualityIgnoreReason" rows="3" maxlength="500"></textarea></label><div class="modal-error" id="qualityIgnoreError" role="alert"></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button(ignored?'确认忽略':'确认恢复','confirmQualityIgnore')}</div>`);
    const errorNode = document.querySelector('#qualityIgnoreError');
    const confirm = document.querySelector('#confirmQualityIgnore');
    confirm.addEventListener('click',async()=>{
      if (confirm.disabled) return;
      const epoch=state.sessionEpoch; const userId=state.user?.id;
      const reason=document.querySelector('#qualityIgnoreReason').value.trim();
      confirm.disabled=true; confirm.textContent='正在保存…';
      try {
        const data=await apiRequest(type==='rule'?`/api/rules/${number}/error-ignores`:`/api/calendar/puzzles/${number}/error-ignores`,{method:'POST',body:JSON.stringify({key,revision:Number(revision),ignored,reason})});
        if (!isCurrentUserSession(epoch,userId)) return;
        if (errorNode.isConnected) closeModal();
        if (data.rule) { updateAuditedRule(data.rule); if (getRoute().name!=='rules') renderRoute(); }
        else { applyCalendarPuzzle(data.puzzle); updateCalendarReviewPage(data.puzzle); }
        showToast(ignored?'此错误已明确标记为忽略；仍需完成审计。':'此错误已恢复。');
      } catch (error) { if (isCurrentUserSession(epoch,userId)&&errorNode.isConnected) errorNode.textContent=error.status===409?'错误对应版本已变化，请刷新后重新操作。':error.message; }
      finally { if (confirm.isConnected) {confirm.disabled=false;confirm.textContent=ignored?'确认忽略':'确认恢复';} }
    });
  }));
}
function renderCalendarPuzzleLinks(puzzle) {
  return `<div class="calendar-tool-links">${[['Penpa 编辑链接',puzzle.penpaEditUrl],['Penpa 解题链接',puzzle.penpaSolveUrl],['puzz.link 链接',puzzle.puzzlinkUrl]].filter(([,url])=>url&&parseTrustedPuzzleUrl(url)).map(([label,url])=>`<a class="button button-light" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`).join('')}${puzzle.penpaSolveUrl&&puzzle.puzzlinkUrl?`<button type="button" class="text-button" data-calendar-solver="penpa">页内使用 Penpa</button><button type="button" class="text-button" data-calendar-solver="puzzlink">页内使用 puzz.link</button>`:''}</div>`;
}
function renderCalendarWorkflow(puzzle) {
  const quality = puzzle.quality || {errors:[],warnings:[],penpa:{}};
  const audit = quality.penpa;
  const approved = puzzle.calendarStatus==='approved';
  const guidelinesMatch = state.penpaGuidelines?.revision===audit.guidelinesRevision;
  const own = audit.currentReviews?.find((review)=>String(review.userId)===String(state.user?.id));
  const linkErrors = quality.errors.some((error)=>error.item==='links'&&!error.ignored);
  return `<section class="calendar-workflow-panel"><header><h2>${esc(calendarStatusLabel(calendarAreaOf(puzzle)))}</h2><span>错误 ${quality.errors.filter((error)=>!error.ignored).length} · 警告 ${quality.warnings.length}</span></header>${renderCalendarPuzzleLinks(puzzle)}${calendarAreaOf(puzzle)==='allocation'?button('补充或修改 Penpa 链接','editSharedPenpaLinksButton','button button-light'):''}${renderQualityErrors(quality.errors,'puzzle',puzzle.number)}${quality.warnings.length?`<ul class="quality-warning-list">${quality.warnings.map((warning)=>`<li>${esc(warning.message)}</li>`).join('')}</ul>`:'<p class="quality-ok-pill">质量条件已满足</p>'}${approved?`<div class="calendar-workflow-actions"><section><h3>正式日期分配</h3><p class="form-help">建议日期仅供参考；正式分配日期会占用档期。</p><label class="form-field"><span>${puzzle.calendarYear} 年的日期</span><input id="assignedCalendarDate" type="date" min="${puzzle.calendarYear}-01-01" max="${puzzle.calendarYear}-12-31" value="${esc(puzzle.assignedDate || puzzle.suggestedDate || '')}" /></label><div class="audit-actions">${button(puzzle.assignedDate?'调整分配日期':'分配日期','assignCalendarDateButton','button button-light')}${puzzle.assignedDate?button('取消日期分配','clearAssignedDateButton','button button-light'):''}</div><p class="modal-error" id="calendarAssignmentError" role="alert"></p></section><section><h3>Penpa 制图规范审计 · 第 ${audit.revision} 版</h3><p>${Number(audit.approvalCount)||0}/3 位成员通过${audit.status==='rejected'?' · 已打回':''}</p>${(audit.currentReviews || []).length?`<p class="audit-reviewers">${audit.currentReviews.map((review)=>`${esc(review.username || review.name)}：${review.decision==='approve'?'通过':'打回'}${review.suggestion?`（${esc(review.suggestion)}）`:''}`).join('、')}</p>`:''}${renderPenpaGuidelines()}<div class="audit-actions"><button type="button" class="button button-light" data-penpa-audit="approve" ${!audit.guidelinesAvailable||!guidelinesMatch||linkErrors||audit.status==='rejected'||audit.status==='approved'||own?.decision==='approve'?'disabled':''}>${own?.decision==='approve'?'✓ 已通过':'✓ 通过制图审计'}</button><button type="button" class="text-button" data-penpa-audit="reject" ${!audit.guidelinesAvailable||!guidelinesMatch||own?.decision==='reject'?'disabled':''}>打回并建议</button></div>${audit.history?.length?`<details class="audit-history"><summary>制图审计历史（${audit.history.length}）</summary><ol>${audit.history.map((entry)=>`<li>${esc(entry.username || entry.name)} · 第 ${entry.revision} 版 · ${entry.decision==='approve'?'通过':'打回'}${entry.revision!==audit.revision||entry.guidelinesRevision!==audit.guidelinesRevision?' · 历史版本（不计入当前审核）':''}${entry.suggestion?`<p>${esc(entry.suggestion)}</p>`:''}</li>`).join('')}</ol></details>`:''}</section></div>`:'<p class="form-help">喜爱程度评分通过后进入待分配区，可分配正式日期并提交制图审计。</p>'}</section>`;
}
function bindCalendarWorkflow(puzzle) {
  const panel = document.querySelector('.calendar-workflow-panel');
  if (!panel) return;
  panel.querySelector('#editSharedPenpaLinksButton')?.addEventListener('click',()=>openSharedPenpaEditor(puzzle));
  bindQualityIgnores(panel);
  const refreshGuidelines = async () => {
    if (panel.dataset.guidelinesLoading==='true') return;
    panel.dataset.guidelinesLoading='true';
    const epoch=state.sessionEpoch; const userId=state.user?.id;
    try {
      const guidelines=await apiRequest('/api/penpa-guidelines');
      if (!isCurrentUserSession(epoch,userId)||!panel.isConnected) return;
      state.penpaGuidelines=guidelines;
      let latest=puzzle;
      if (guidelines.revision!==puzzle.quality.penpa.guidelinesRevision) {
        latest=(await apiRequest(`/api/calendar/puzzles/${puzzle.number}`)).puzzle;
        if (!isCurrentUserSession(epoch,userId)||!panel.isConnected) return;
        applyCalendarPuzzle(latest);
      }
      updateCalendarReviewPage(latest);
    } catch (error) {
      if (!isCurrentUserSession(epoch,userId)||!panel.isConnected) return;
      const notice=document.createElement('p'); notice.className='modal-error';notice.setAttribute('role','alert');notice.textContent='最新制图规范加载失败，请重试。';
      const retry=document.createElement('button');retry.className='text-button';retry.type='button';retry.textContent='重试加载规范';
      retry.addEventListener('click',()=>{notice.remove();retry.remove();void refreshGuidelines();});panel.append(notice,retry);
    } finally { delete panel.dataset.guidelinesLoading; }
  };
  if (puzzle.quality.penpa.guidelinesAvailable&&state.penpaGuidelines?.revision!==puzzle.quality.penpa.guidelinesRevision) void refreshGuidelines();
  panel.querySelectorAll('[data-calendar-solver]').forEach((control)=>control.addEventListener('click',()=>{
    const url=control.dataset.calendarSolver==='penpa'?puzzle.penpaSolveUrl:puzzle.puzzlinkUrl;
    if (parseTrustedPuzzleUrl(url)) {
      document.querySelector('#puzzleEmbed').innerHTML=renderEmbed({...puzzle,url});
      bindPenpaKeyboard();
    }
  }));
  const assign = async (clear=false) => {
    const input=panel.querySelector('#assignedCalendarDate');
    const errorNode=panel.querySelector('#calendarAssignmentError');
    const date=clear?null:input.value;
    if (!clear&&!date) { errorNode.textContent='请选择要分配的日期。'; return; }
    const controls=[...panel.querySelectorAll('#assignCalendarDateButton,#clearAssignedDateButton')];
    if (controls.some((control)=>control.disabled)) return;
    controls.forEach((control)=>{control.disabled=true;});
    const epoch=state.sessionEpoch; const userId=state.user?.id;
    try {
      const data=await apiRequest(`/api/calendar/puzzles/${puzzle.number}/assignment`,{method:'POST',body:JSON.stringify({assignedDate:date,expectedEditVersion:puzzle.editVersion,expectedReviewRound:puzzle.reviewRound})});
      if (!isCurrentUserSession(epoch,userId)) return;
      applyCalendarPuzzle(data.puzzle); updateCalendarReviewPage(data.puzzle);
      showToast(clear?'日期分配已取消，题目返回待分配区。':'正式日期已保存。');
    } catch(error) { if(isCurrentUserSession(epoch,userId)&&errorNode.isConnected) errorNode.textContent=error.message; }
    finally {controls.forEach((control)=>{if(control.isConnected) control.disabled=false;});}
  };
  panel.querySelector('#assignCalendarDateButton')?.addEventListener('click',()=>void assign());
  panel.querySelector('#clearAssignedDateButton')?.addEventListener('click',()=>void assign(true));
  panel.querySelectorAll('[data-penpa-audit]').forEach((control)=>control.addEventListener('click',()=>{
    if (control.dataset.penpaAudit==='approve') void submitPenpaAudit(puzzle,'approve');
    else {
      openModal(`<h2 id="modalTitle">打回 Penpa 制图审计</h2><p class="modal-intro">请指出不符合制图规范之处；作者修改 Penpa 链接后重新开始三人审计。</p><label class="form-field"><span>审计建议</span><textarea id="penpaAuditSuggestion" rows="4" maxlength="2000"></textarea></label><p id="penpaAuditError" class="modal-error" role="alert"></p><div class="modal-footer"><button type="button" class="button button-light modal-cancel">取消</button>${button('确认打回','confirmPenpaAuditReject')}</div>`);
      document.querySelector('#confirmPenpaAuditReject').addEventListener('click',()=>void submitPenpaAudit(puzzle,'reject',document.querySelector('#penpaAuditSuggestion').value.trim(),document.querySelector('#penpaAuditError')));
    }
  }));
}
async function submitPenpaAudit(puzzle,decision,suggestion='',errorNode=null) {
  if (state.penpaGuidelines?.revision!==puzzle.quality.penpa.guidelinesRevision) { showToast('请先读取最新版本的制图规范后再审核。'); return; }
  const epoch=state.sessionEpoch; const userId=state.user?.id; const key=`${epoch}:penpa:${puzzle.number}`;
  if (state.auditPending.has(key)) return;
  state.auditPending.add(key);
  const controls=[...document.querySelectorAll('[data-penpa-audit],#confirmPenpaAuditReject')];
  const previous=controls.map((control)=>({control,disabled:control.disabled,text:control.textContent}));
  controls.forEach((control)=>{control.disabled=true;});
  const active=decision==='reject'?document.querySelector('#confirmPenpaAuditReject'):controls.find((control)=>control.dataset.penpaAudit==='approve');
  if(active) active.textContent='正在提交…';
  try {
    const audit=puzzle.quality.penpa;
    const data=await apiRequest(`/api/calendar/puzzles/${puzzle.number}/penpa-audits`,{method:'POST',body:JSON.stringify({decision,suggestion,revision:audit.revision,guidelinesRevision:audit.guidelinesRevision})});
    if(!isCurrentUserSession(epoch,userId)) return;
    if(errorNode?.isConnected) closeModal();
    applyCalendarPuzzle(data.puzzle);updateCalendarReviewPage(data.puzzle);showToast('Penpa 制图审计已保存。');
  } catch(error) {
    if(!isCurrentUserSession(epoch,userId)) return;
    if(errorNode?.isConnected) errorNode.textContent=error.message;else showToast(error.message);
  } finally {
    state.auditPending.delete(key);previous.forEach(({control,disabled,text})=>{if(control.isConnected){control.disabled=disabled;control.textContent=text;}});
  }
}

function calendarAreaOf(puzzle) { return puzzle.calendarArea || (puzzle.calendarStatus === 'leftover' ? 'leftover' : puzzle.calendarStatus === 'approved' ? 'allocation' : 'review'); }
function calendarZoneNav(route) {
  const puzzles = [...state.calendarPuzzles, ...state.calendarLeftovers];
  return `<nav class="calendar-view-switch" aria-label="题目区域">${[['calendar','review','待审核区'],['leftovers','leftover','leftover 区'],['allocation','allocation','待分配区'],['finished','finished','完成区']].map(([name,area,label]) => `<a href="#${name}" class="${route===name?'active':''}">${label} <span>${puzzles.filter((puzzle)=>calendarAreaOf(puzzle)===area).length}</span></a>`).join('')}<a href="#pending" class="${route==='pending'?'active':''}">我的未完成</a></nav>`;
}
function renderCalendar(route = 'calendar') {
  if (typeof route === 'boolean') route = route ? 'pending' : 'calendar';
  if (route === 'finished') return renderFinishedCalendar();
  const area = ({calendar:'review',leftovers:'leftover',allocation:'allocation'})[route];
  const all = [...state.calendarPuzzles,...state.calendarLeftovers];
  const puzzles = all.filter((puzzle)=>route==='pending' ? !puzzle.completed && calendarAreaOf(puzzle)!=='leftover' : calendarAreaOf(puzzle)===area)
    .sort((a,b)=>state.calendarSort==='newest'?b.number-a.number:calendarSortKey(a).localeCompare(calendarSortKey(b))||b.number-a.number);
  const title = ({calendar:'待审核区',leftovers:'leftover 区',allocation:'待分配区',pending:'我的未完成谜题'})[route] || '待审核区';
  const description = ({calendar:'新投稿进入这里；至少三名成员评分且平均分严格大于 0 后进入待分配区，一票否决后进入 leftover。',leftovers:'被否决的投稿保留在这里，重新进入会开启新一轮喜爱评分。',allocation:'补齐 Penpa 链接，完成规则与制图审计，再分配日期。',pending:'查看你尚未完成的题目；个人解题状态与日历区域分别记录。'})[route];
  const rows = puzzles.map((puzzle)=>{
    const quality = puzzle.quality || {errors:[],warnings:[]};
    const errors = quality.errors.filter((error)=>!error.ignored).length;
    const ignored = quality.errors.filter((error)=>error.ignored).length;
    return `<div class="calendar-row ${puzzle.completed?'is-completed':''}" data-puzzle-route="calendar-puzzle-${puzzle.number}"><span class="calendar-date">${esc(puzzle.assignedDate || calendarDateLabel(puzzle))}</span><span class="calendar-info"><a class="calendar-title-link" href="#calendar-puzzle-${puzzle.number}"><strong>${esc(puzzle.title)}</strong></a><small>${puzzle.rule?ruleLabel(puzzle.rule):esc(puzzle.type)} · ${esc(puzzle.submittedBy?.username || puzzle.author)}</small><small class="calendar-row-review">${esc(calendarStatusLabel(calendarAreaOf(puzzle)))} · ${esc(calendarReviewSummary(puzzle.review))}</small>${area==='allocation'?`<small class="calendar-quality-counts">错误 ${errors} · 警告 ${quality.warnings.length}${ignored?` · 已忽略 ${ignored}`:''}</small>`:''}</span><span class="calendar-progress">${puzzle.completed?'✓ 你已解题':'待你解题'}</span><span class="calendar-rating">${calendarDifficultyMarkup(puzzle,puzzle.evaluationSummary)}</span><a class="calendar-arrow" href="#calendar-puzzle-${puzzle.number}" aria-label="打开 ${esc(puzzle.title)}">→</a></div>`;
  }).join('');
  return `<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow">PUZZLE CALENDAR</p><h1>${title}<span class="heading-period">.</span></h1><p class="page-description">${description}</p></div>${button('＋ 提交日历谜题','addCalendarPuzzleButton')}</section>${calendarZoneNav(route)}<section class="calendar-toolbar"><div class="section-title-group"><h2>${title}</h2><span class="count-badge">${puzzles.length}</span></div><label for="calendarSort">排序</label><select id="calendarSort"><option value="date" ${state.calendarSort==='date'?'selected':''}>建议日期</option><option value="newest" ${state.calendarSort==='newest'?'selected':''}>最近提交</option></select></section><div class="calendar-list">${rows || '<div class="empty-state">这个区域暂无题目。</div>'}</div></div>`;
}
function renderCalendarLeftovers() { return renderCalendar('leftovers'); }
function renderFinishedCalendar() {
  const year = state.calendarViewYear;
  const month = state.calendarMonth;
  const monthKey = `${year}-${String(month).padStart(2,'0')}`;
  const puzzles = state.calendarPuzzles.filter((puzzle)=>calendarAreaOf(puzzle)==='finished' && puzzle.assignedDate?.startsWith(monthKey));
  const byDate = new Map(puzzles.map((puzzle)=>[puzzle.assignedDate,puzzle]));
  const offset = (new Date(Date.UTC(year,month-1,1)).getUTCDay()+6)%7;
  const days = new Date(Date.UTC(year,month,0)).getUTCDate();
  const cells = Array.from({length:offset},()=>'<div class="month-calendar-spacer" aria-hidden="true"></div>').concat(Array.from({length:days},(_,index)=>{
    const day = index+1; const date = `${monthKey}-${String(day).padStart(2,'0')}`; const puzzle = byDate.get(date);
    return `<div class="month-calendar-day ${puzzle?'has-puzzle':''}" role="gridcell" aria-label="${date}${puzzle?` ${esc(puzzle.title)}`:' 空'}"><time datetime="${date}">${day}</time>${puzzle?`<a href="#calendar-puzzle-${puzzle.number}" data-month-puzzle>${esc(puzzle.title)}</a><small>${puzzle.rule?ruleLabel(puzzle.rule):''}</small>`:'<span class="month-calendar-empty">空</span>'}</div>`;
  })).join('');
  return `<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow">COMPLETED CALENDAR</p><h1>完成区<span class="heading-period">.</span></h1><p class="page-description">至少三名成员评分且平均分严格大于 0、质量检查、三人制图审计和日期分配均完成的题目显示在这里；取消分配可返回待分配区。</p></div></section>${calendarZoneNav('finished')}<section class="month-calendar-toolbar"><label>年份 <input id="calendarViewYear" type="number" min="1000" max="9999" value="${year}" /></label><label>月份 <select id="calendarMonth">${Array.from({length:12},(_,index)=>`<option value="${index+1}" ${index+1===month?'selected':''}>${index+1} 月</option>`).join('')}</select></label><strong>${year} 年 ${month} 月 · ${puzzles.length} 道题目</strong></section><div class="month-calendar-weekdays">${['一','二','三','四','五','六','日'].map((day)=>`<span>周${day}</span>`).join('')}</div><div class="month-calendar-grid" role="grid" aria-label="${year} 年 ${month} 月完成题目">${cells}</div></div>`;
}
function renderCalendarDateInputs(prefix, year = 2028, monthDay = '') {
  const [monthValue = '', dayValue = ''] = String(monthDay || '').split('-');
  const safeYear = Number.isInteger(Number(year)) && Number(year) >= 1900 && Number(year) <= 9999 ? Number(year) : 2028;
  return `<div class="calendar-date-fields"><label><span>年份</span><input id="${prefix}Year" type="number" min="1900" max="9999" step="1" value="${safeYear}" /></label><label><span>月份（可选）</span><select id="${prefix}Month"><option value="">不指定</option>${Array.from({ length: 12 }, (_, index) => index + 1).map((month) => `<option value="${String(month).padStart(2, '0')}" ${String(month).padStart(2, '0') === monthValue ? 'selected' : ''}>${month} 月</option>`).join('')}</select></label><label><span>日期（可选）</span><select id="${prefix}Day" data-initial="${esc(dayValue)}"><option value="">不指定</option></select></label></div><p class="form-help">只选年份也可以；月份和日期留空表示暂不安排，不会自动补成 1 月 1 日。</p>`;
}
function bindCalendarDateInputs(prefix) {
  const month = document.querySelector(`#${prefix}Month`);
  const day = document.querySelector(`#${prefix}Day`);
  const year = document.querySelector(`#${prefix}Year`);
  if (!month || !day || !year) return;
  const updateDays = (preferredDay = day.value) => {
    const monthNumber = Number(month.value);
    const yearNumber = Number(year.value) || 2028;
    const count = monthNumber ? new Date(yearNumber, monthNumber, 0).getDate() : 31;
    day.innerHTML = `<option value="">不指定</option>${Array.from({ length: count }, (_, index) => index + 1).map((number) => `<option value="${String(number).padStart(2, '0')}" ${String(number).padStart(2, '0') === preferredDay ? 'selected' : ''}>${number} 日</option>`).join('')}`;
  };
  updateDays(day.dataset.initial || day.value);
  month.addEventListener('change', () => updateDays(''));
  year.addEventListener('change', () => updateDays(day.value));
}
function readCalendarDateFields(prefix) {
  const year = Number(document.querySelector(`#${prefix}Year`)?.value);
  const month = document.querySelector(`#${prefix}Month`)?.value || '';
  const day = document.querySelector(`#${prefix}Day`)?.value || '';
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return { error: '年份需填写 1900 至 9999 之间的整数。' };
  if (Boolean(month) !== Boolean(day)) return { error: '建议日期需要同时选择月份和日期，或两项都留空。' };
  return { calendarYear: year, suggestedMonthDay: month && day ? `${month}-${day}` : '' };
}
function notificationEntityMarkup(notification) {
  const entity = notification.entity || {};
  const id = Number(entity.id);
  if (!Number.isSafeInteger(id) || id < 1) return '';
  const type = String(entity.type || '').toLowerCase();
  if (['calendar-puzzle', 'calendar_puzzle', 'puzzle'].includes(type)) {
    const exists = [...state.calendarPuzzles, ...state.calendarLeftovers].some((puzzle) => Number(puzzle.number) === id);
    return exists ? `<a class="inbox-entity-link" href="#calendar-puzzle-${id}">查看谜题 →</a>` : '<span class="inbox-entity-missing">关联谜题已删除或暂不可用</span>';
  }
  if (['rule', 'rules'].includes(type)) {
    if (state.rulesStatus !== 'loaded') return '<a class="inbox-entity-link" href="#rules">查看规则目录 →</a>';
    const exists = state.rules.some((rule) => Number(rule.id) === id);
    return exists ? '<a class="inbox-entity-link" href="#rules">查看规则目录 →</a>' : '<span class="inbox-entity-missing">关联规则已删除或暂不可用</span>';
  }
  return '';
}
function inboxTagIcon(id) {
  const shapes = {
    star: '<path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9Z"/>',
    flag: '<path d="M5 21V4m0 0c5-4 9 4 14 0v10c-5 4-9-4-14 0Z"/>',
    bookmark: '<path d="M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4Z"/>',
    heart: '<path d="M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${shapes[id] || ''}</svg>`;
}
function inboxFilterMarkup() {
  return `<section class="inbox-filters" aria-label="收件箱筛选"><label for="inboxReadFilter">阅读状态<select id="inboxReadFilter">${[['all', '全部消息'], ['unread', '未读'], ['read', '已读']].map(([value, label]) => `<option value="${value}" ${state.inboxReadFilter === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label for="inboxTagFilter">标签状态<select id="inboxTagFilter">${[['all', '全部标签状态'], ['tagged', '有标签'], ['untagged', '无标签']].map(([value, label]) => `<option value="${value}" ${state.inboxTagFilter === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${state.inboxReadFilter !== 'all' || state.inboxTagFilter !== 'all' ? '<button class="button button-light" type="button" id="resetInboxFiltersButton">清除筛选</button>' : ''}<span class="inbox-tag-hint">点击消息旁的图标添加或移除标签</span></section>`;
}
function renderMessages() {
  const notifications = state.inboxItems || [];
  const items = notifications.map((item) => {
    const id = String(item.id);
    const isRead = Boolean(item.readAt);
    const pending = state.inboxPendingIds.has(id);
    const disabled = pending || state.inboxLoading || state.inboxReadAllPending || state.usernameRenamePending;
    const tags = item.tags || [];
    const tagButtons = INBOX_TAGS.map(({ id: tagId, label }) => {
      const selected = tags.includes(tagId);
      const description = `${selected ? '移除' : '添加'}${label}标签`;
      return `<button class="inbox-tag-button" type="button" data-inbox-tag="${tagId}" data-inbox-id="${esc(id)}" aria-label="${description}" title="${description}" aria-pressed="${selected}" ${disabled ? 'disabled' : ''}>${inboxTagIcon(tagId)}</button>`;
    }).join('');
    return `<article class="inbox-item ${isRead ? 'is-read' : 'is-unread'}" data-inbox-id="${esc(id)}"><div class="inbox-item-copy"><div class="inbox-item-heading"><h2>${esc(item.title || '通知')}</h2><time>${esc(item.createdAt || '')}</time></div><p>${esc(item.body || '')}</p>${notificationEntityMarkup(item)}</div><div class="inbox-item-actions"><div class="inbox-tag-options" role="group" aria-label="消息图标标签" aria-busy="${pending}">${tagButtons}</div>${!isRead ? `<button class="button button-light" type="button" data-inbox-read="${esc(id)}" ${disabled ? 'disabled' : ''}>${pending ? '正在保存…' : '标记已读'}</button>` : '<span class="inbox-read-label">已读</span>'}</div></article>`;
  }).join('');
  const filtered = state.inboxReadFilter !== 'all' || state.inboxTagFilter !== 'all';
  const empty = state.inboxLoading ? '<div class="empty-state" role="status">正在加载通知…</div>' : state.inboxError ? '<div class="empty-state">通知加载失败，请刷新重试。</div>' : `<div class="empty-state">${filtered ? '没有符合筛选条件的通知。' : '目前没有通知。'}</div>`;
  return `<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span>MEMBER INBOX</p><h1>收件箱<span class="heading-period">.</span></h1><p class="page-description">仅显示发送给你的系统通知；成员之间的私聊不在这里。</p></div><div class="inbox-heading-actions"><button class="button button-light" id="refreshInboxButton" type="button" ${state.inboxLoading ? 'disabled' : ''}>${state.inboxLoading ? '正在刷新…' : '刷新通知'}</button>${state.inboxUnreadCount > 0 ? `<button class="button button-light" id="markAllInboxReadButton" type="button" title="将整个收件箱的未读通知标记为已读" ${state.inboxReadAllPending || state.inboxLoading || state.inboxPendingIds.size || state.usernameRenamePending ? 'disabled' : ''}>${state.inboxReadAllPending ? '正在标记…' : '全部标记已读'}</button>` : ''}</div></section>${inboxFilterMarkup()}${state.inboxActionError ? `<p class="inbox-error" role="alert">${esc(state.inboxActionError)}</p>` : ''}${state.inboxError ? `<p class="inbox-error" role="alert">${esc(state.inboxError)}</p>` : ''}<section class="inbox-list" aria-label="系统通知" aria-busy="${state.inboxLoading}">${items || empty}</section>${state.inboxNextBefore ? `<div class="inbox-more"><button class="button button-light" id="loadMoreInboxButton" type="button" ${state.inboxLoading ? 'disabled' : ''}>${state.inboxLoading ? '正在加载…' : '加载更多'}</button></div>` : ''}</div>`;
}
function matchesInboxFilters(item) {
  const isRead = Boolean(item.readAt);
  const hasTags = Boolean(item.tags?.length);
  return (state.inboxReadFilter === 'all' || (state.inboxReadFilter === 'read' ? isRead : !isRead))
    && (state.inboxTagFilter === 'all' || (state.inboxTagFilter === 'tagged' ? hasTags : !hasTags));
}
async function refreshInbox(epoch = state.sessionEpoch, userId = state.user?.id, { append = false, clear = false } = {}) {
  if (!isCurrentUserSession(epoch, userId)) return false;
  const params = new URLSearchParams({ limit: '20', read: state.inboxReadFilter, tag: state.inboxTagFilter });
  if (append && state.inboxNextBefore) params.set('before', String(state.inboxNextBefore));
  const attempt = ++inboxLoadAttempt;
  inboxLoadController?.abort();
  const controller = new AbortController();
  inboxLoadController = controller;
  const isCurrent = () => isCurrentUserSession(epoch, userId) && attempt === inboxLoadAttempt;
  state.inboxLoading = true; state.inboxError = '';
  if (clear) { state.inboxItems = []; state.inboxNextBefore = null; }
  renderRoute();
  try {
    const data = await apiRequest(`/api/inbox?${params.toString()}`, { signal: controller.signal });
    if (!isCurrent()) return false;
    const received = data.notifications || [];
    if (append) {
      const existing = new Set(state.inboxItems.map((item) => String(item.id)));
      state.inboxItems = [...state.inboxItems, ...received.filter((item) => !existing.has(String(item.id)))];
    } else state.inboxItems = received;
    state.inboxUnreadCount = Number(data.unreadCount || 0);
    state.inboxNextBefore = data.nextBefore || null;
    return true;
  } catch (error) {
    if (isCurrent()) state.inboxError = error.message || '无法加载通知，请刷新重试。';
    return false;
  } finally {
    if (inboxLoadController === controller) inboxLoadController = null;
    if (isCurrent()) { state.inboxLoading = false; renderRoute(); }
  }
}
async function loadInboxFresh() {
  if (!state.user || state.inboxLoading) return;
  const epoch = state.sessionEpoch; const userId = state.user.id;
  state.inboxActionError = '';
  const refreshLoadedRules = state.rulesStatus === 'loaded';
  const [, calendarResult, leftoverResult, rulesResult] = await Promise.allSettled([
    refreshInbox(epoch, userId),
    apiRequest('/api/calendar/puzzles'),
    apiRequest('/api/calendar/leftovers'),
    ...(refreshLoadedRules ? [apiRequest('/api/rules')] : [])
  ]);
  if (!isCurrentUserSession(epoch, userId)) return;
  if (calendarResult.status === 'fulfilled') state.calendarPuzzles = (calendarResult.value.puzzles || []).map(normalizePuzzle);
  if (leftoverResult.status === 'fulfilled') state.calendarLeftovers = (leftoverResult.value.puzzles || []).map(normalizePuzzle);
  if (refreshLoadedRules && rulesResult?.status === 'fulfilled') state.rules = rulesResult.value.rules || [];
  renderRoute();
}
async function toggleInboxTag(id, tagId) {
  const key = String(id);
  const item = state.inboxItems.find((entry) => String(entry.id) === key);
  if (!item || state.inboxPendingIds.has(key) || state.inboxLoading || state.inboxReadAllPending || state.usernameRenamePending || !INBOX_TAGS.some((tag) => tag.id === tagId)) return;
  const epoch = state.sessionEpoch; const userId = state.user?.id;
  const tags = (item.tags || []).includes(tagId) ? item.tags.filter((tag) => tag !== tagId) : [...(item.tags || []), tagId];
  state.inboxPendingIds.add(key); state.inboxActionError = ''; renderRoute();
  try {
    const data = await apiRequest(`/api/inbox/${encodeURIComponent(key)}/tags`, { method: 'PATCH', body: JSON.stringify({ tags }) });
    if (!isCurrentUserSession(epoch, userId)) return;
    state.inboxItems = state.inboxItems.map((entry) => String(entry.id) === key ? { ...entry, tags: data.tags } : entry).filter(matchesInboxFilters);
    await refreshInbox(epoch, userId);
  } catch (error) {
    if (isCurrentUserSession(epoch, userId)) state.inboxActionError = error.message || '标签保存失败，请重试。';
  } finally {
    if (isCurrentUserSession(epoch, userId)) { state.inboxPendingIds.delete(key); renderRoute(); }
  }
}
async function markInboxRead(id) {
  const key = String(id);
  if (state.inboxPendingIds.has(key) || state.inboxReadAllPending || state.inboxLoading || state.usernameRenamePending) return;
  const epoch = state.sessionEpoch; const userId = state.user?.id;
  state.inboxPendingIds.add(key); state.inboxActionError = ''; renderRoute();
  try {
    const data = await apiRequest(`/api/inbox/${encodeURIComponent(key)}/read`, { method: 'POST', body: '{}' });
    if (!isCurrentUserSession(epoch, userId)) return;
    state.inboxUnreadCount = Number(data.unreadCount || 0);
    state.inboxItems = state.inboxItems.map((item) => String(item.id) === key ? { ...item, readAt: item.readAt || new Date().toISOString() } : item).filter(matchesInboxFilters);
    await refreshInbox(epoch, userId);
  } catch (error) {
    if (isCurrentUserSession(epoch, userId)) state.inboxActionError = error.message || '标记已读失败。';
  } finally {
    if (isCurrentUserSession(epoch, userId)) { state.inboxPendingIds.delete(key); renderRoute(); }
  }
}
async function markAllInboxRead() {
  if (state.inboxReadAllPending || state.inboxLoading || state.inboxPendingIds.size || state.usernameRenamePending) return;
  const epoch = state.sessionEpoch; const userId = state.user?.id;
  state.inboxReadAllPending = true; state.inboxActionError = ''; renderRoute();
  try {
    const data = await apiRequest('/api/inbox/read-all', { method: 'POST', body: '{}' });
    if (!isCurrentUserSession(epoch, userId)) return;
    state.inboxUnreadCount = Number(data.unreadCount || 0);
    state.inboxItems = state.inboxItems.map((item) => ({ ...item, readAt: item.readAt || new Date().toISOString() })).filter(matchesInboxFilters);
    await refreshInbox(epoch, userId);
  } catch (error) {
    if (isCurrentUserSession(epoch, userId)) state.inboxActionError = error.message || '全部标记已读失败。';
  } finally {
    if (isCurrentUserSession(epoch, userId)) { state.inboxReadAllPending = false; renderRoute(); }
  }
}
async function loadMoreInbox() {
  if (state.inboxLoading || !state.inboxNextBefore) return;
  await refreshInbox(state.sessionEpoch, state.user?.id, { append: true });
}
function changeInboxFilters(read, tag) {
  state.inboxReadFilter = read; state.inboxTagFilter = tag; state.inboxActionError = '';
  void refreshInbox(state.sessionEpoch, state.user?.id, { clear: true });
}
function bindMessages() {
  document.querySelector('#refreshInboxButton')?.addEventListener('click', loadInboxFresh);
  document.querySelectorAll('[data-inbox-read]').forEach((button) => button.addEventListener('click', () => markInboxRead(button.dataset.inboxRead)));
  document.querySelectorAll('[data-inbox-tag]').forEach((button) => button.addEventListener('click', () => toggleInboxTag(button.dataset.inboxId, button.dataset.inboxTag)));
  document.querySelector('#markAllInboxReadButton')?.addEventListener('click', markAllInboxRead);
  document.querySelector('#loadMoreInboxButton')?.addEventListener('click', loadMoreInbox);
  document.querySelector('#inboxReadFilter')?.addEventListener('change', (event) => changeInboxFilters(event.target.value, state.inboxTagFilter));
  document.querySelector('#inboxTagFilter')?.addEventListener('change', (event) => changeInboxFilters(state.inboxReadFilter, event.target.value));
  document.querySelector('#resetInboxFiltersButton')?.addEventListener('click', () => changeInboxFilters('all', 'all'));
}
function renderRules() {
  if (state.rulesStatus === 'loading' || state.rulesStatus === 'idle') return '<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span>RULE CATALOG</p><h1>规则目录<span class="heading-period">.</span></h1></div></section><div class="empty-state" role="status">正在加载规则目录…</div></div>';
  if (state.rulesStatus === 'error') return `<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span>RULE CATALOG</p><h1>规则目录<span class="heading-period">.</span></h1></div></section><div class="error-state" role="alert"><strong>规则目录暂时无法加载</strong><p>${esc(state.rulesError)}</p><button class="button button-light" type="button" id="retryRulesButton">重试</button></div></div>`;
  const rules = state.rules;
  const filtered = rules.filter((rule) => ruleMatchesRuleFilter(rule, state.ruleFilter) && (!state.ruleQuery || `${rule.titleZh || ''} ${rule.titleEn || ''} ${rule.category || ''} ${(rule.rulesZh || []).join(' ')} ${(rule.rulesEn || []).join(' ')}`.toLowerCase().includes(state.ruleQuery.toLowerCase())));
  const totals = rules.reduce((sum, rule) => { const quality = rule.quality || {}; sum.errors += (quality.errors || []).filter((entry)=>!entry.ignored).length; sum.warnings += (quality.warnings || []).length; return sum; }, { errors: 0, warnings: 0 });
  const problemRules = rules.filter((rule) => (rule.quality?.errors || []).filter((entry)=>!entry.ignored).length + (rule.quality?.warnings || []).length > 0).length;
  return `<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span>RULE CATALOG</p><h1>规则目录<span class="heading-period">.</span></h1><p class="page-description">规则允许先保存为草稿；名称、规则描述与例题分别完成独立审核。</p></div>${button('<span class="button-plus">+</span>新建规则', 'addRuleButton')}</section><section class="rule-quality-summary" aria-label="目录质量概况"><div><span>目录规则</span><strong>${rules.length}</strong></div><div><span>受影响规则</span><strong>${problemRules}</strong></div><div class="quality-count-error"><span>错误项</span><strong>${totals.errors}</strong></div><div class="quality-count-warning"><span>待审核项</span><strong>${totals.warnings}</strong></div></section><section class="rule-catalog-tools"><label class="rule-search"><span class="sr-only">搜索规则</span><input id="ruleSearch" type="search" value="${esc(state.ruleQuery)}" placeholder="搜索中英文名称、分类或规则" /></label><div class="rule-filter-tabs" role="group" aria-label="规则筛选">${[['all','全部'],['problem','有问题'],['error','错误'],['warning','待审核']].map(([key,label]) => `<button type="button" class="rule-filter-button ${state.ruleFilter === key ? 'active' : ''}" data-rule-filter="${key}">${label}</button>`).join('')}</div></section><div class="rule-catalog">${filtered.length ? filtered.map((rule) => renderRuleCard(rule, rules)).join('') : '<div class="empty-state">没有符合筛选条件的规则。</div>'}</div></div>`;
}
function clauseMarkup(clauses = []) { return `<ol class="rule-clauses">${clauses.map((clause) => `<li>${esc(clause)}</li>`).join('')}</ol>`; }
function ruleTitle(rule) { return rule.titleZh || rule.titleEn || '未命名规则'; }
function ruleDisplayName(rule) { return [rule.titleZh, rule.titleEn].filter(Boolean).join(' / ') || '未命名规则'; }
function ruleLabel(rule) { return esc([rule.titleZh, rule.titleEn].filter(Boolean).join(' / ') || '未命名规则'); }
function ruleTitlePair(rule) { const primary = rule.titleZh || rule.titleEn || '未命名规则'; const secondary = rule.titleZh && rule.titleEn ? ` <small>${esc(rule.titleEn)}</small>` : ''; return `${esc(primary)}${secondary}`; }
function normalizeRuleSearch(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ''); }
function filterRuleOptions(query, rules = state.rules) {
  const normalizedQuery = normalizeRuleSearch(query);
  if (!normalizedQuery) return [...rules];
  return rules.filter((rule) => normalizeRuleSearch(`${rule.titleZh || ''} ${rule.titleEn || ''} ${rule.category || ''}`).includes(normalizedQuery));
}
function ruleMatchesRuleFilter(rule, filter) { const quality = rule.quality || {}; const errors = (quality.errors || []).filter((entry)=>!entry.ignored); const warnings = quality.warnings || []; if (filter === 'problem') return errors.length + warnings.length > 0; if (filter === 'error') return errors.length > 0; if (filter === 'warning') return warnings.length > 0; return true; }
const auditLabels = { name: '名称', description: '规则描述', example: '例题' };
function renderRuleCard(rule, allRules) {
  const quality = rule.quality || { errors: [], warnings: [], groups: {} };
  const errors = (quality.errors || []).filter((entry)=>!entry.ignored); const warnings = quality.warnings || []; const groups = quality.groups || {};
  const baseRule = allRules.find((item) => String(item.id) === String(rule.baseRuleId));
  const creator = rule.creator ? (rule.creator.username || rule.creator.name || '成员') : '系统导入';
  const auditCards = ['name', 'description', 'example'].map((item) => renderAuditGroup(rule, item, groups[item] || {}, errors, warnings)).join('');
  const exampleAuthor = String(rule.exampleAuthor || '').trim();
  const exampleAuthorMarkup = exampleAuthor ? `<p class="rule-example-author">例题作者：${esc(exampleAuthor)}</p>` : '';
  const exampleLink = isConcretePenpaPuzzleUrl(rule.exampleUrl) ? `<a class="rule-example-link" href="${esc(rule.exampleUrl)}" target="_blank" rel="noopener noreferrer">打开 Penpa 例题 ↗</a>` : '<p class="rule-missing">尚未提供有效的 Penpa 例题</p>';
  return `<article class="rule-card" data-rule-card="${esc(rule.id)}"><div class="rule-card-heading"><div><span class="rule-category">${esc(rule.category || '未分类')}</span><h2>${ruleTitlePair(rule)}</h2><p class="rule-creator">创建者：${esc(creator)}</p></div><div class="rule-card-actions">${rule.isVariant ? '<span class="rule-variant">变体</span>' : ''}<button type="button" class="button button-light rule-edit-button" data-rule-edit="${esc(rule.id)}">编辑</button><button type="button" class="button button-light rule-delete-button" data-rule-delete="${esc(rule.id)}" data-delete-token="${esc(rule.deleteToken || '')}" data-edit-version="${esc(rule.editVersion || '')}" data-rule-title="${esc(ruleTitle(rule))}" aria-label="删除规则：${esc(ruleTitle(rule))}" ${rule.deleteToken ? '' : 'disabled title="无法确认规则身份，请刷新目录"'}>删除</button></div></div>${rule.isVariant ? `<p class="rule-base">原始规则：${esc(rule.baseRuleTitleZh || rule.baseRuleTitleEn || (baseRule ? ruleTitle(baseRule) : '未指定'))}</p>` : ''}<div class="rule-quality-inline">${errors.length ? `<span class="quality-error-pill">${errors.length} 项错误</span>` : '<span class="quality-ok-pill">无错误项</span>'}${warnings.length ? `<span class="quality-warning-pill">${warnings.length} 项待审核</span>` : ''}</div>${warnings.length ? `<ul class="rule-quality-messages">${warnings.map((entry)=>`<li class="warning">${esc(entry.message)}</li>`).join('')}</ul>` : ''}${renderQualityErrors(rule.quality?.errors || [], 'rule', rule.id)}<div class="rule-language-grid"><section><h3>规则 · 中文</h3>${rule.rulesZh?.length ? clauseMarkup(rule.rulesZh) : '<p class="rule-missing">尚未填写中文规则描述</p>'}</section><section><h3>Rules · English</h3>${rule.rulesEn?.length ? clauseMarkup(rule.rulesEn) : '<p class="rule-optional">English description is optional.</p>'}</section></div><div class="rule-example">${exampleAuthorMarkup}${exampleLink}</div><section class="rule-audit-grid" aria-label="独立审核">${auditCards}</section></article>`;
}
function renderAuditGroup(rule, item, group, errors, warnings) {
  const itemErrors = errors.filter((entry) => entry.item === item);
  const itemWarnings = warnings.filter((entry) => entry.item === item);
  const incomplete = group.status === 'incomplete' || itemErrors.length > 0;
  const rejected = Boolean(group.rejected) || group.status === 'rejected';
  const approvals = Number(group.approvalCount || 0); const required = Number(group.requiredApprovals || 3);
  const approvedBy = (group.currentReviews || []).filter((review) => review.decision === 'approve' && review.active !== false).map((review) => review.username || review.name || '成员');
  const rejectionSuggestion = group.rejectionSuggestion || (group.currentReviews || []).find((review) => review.decision === 'reject')?.suggestion;
  const currentReview = (group.currentReviews || []).find((review) => String(review.userId) === String(state.user?.id));
  const history = group.history || [];
  const statusLabel = rejected ? '有打回意见' : group.status === 'approved' ? '已通过' : incomplete ? '内容未完整' : `${approvals}/${required} 通过`;
  const approveDisabled = incomplete || rejected || group.status === 'approved' || currentReview?.decision === 'approve';
  return `<article class="rule-audit-item ${rejected ? 'is-rejected' : ''} ${group.status === 'approved' ? 'is-approved' : ''}"><header><div><h3>${auditLabels[item]}</h3><span class="audit-status">${statusLabel}</span></div><span class="audit-count" title="需要不同账号独立审核">${approvals}/${required} 位成员</span></header>${incomplete ? `<p class="audit-explanation">${itemErrors.map((entry) => esc(entry.message)).join('；') || '补齐缺项后才能通过'}</p>` : `<p class="audit-reviewers">${approvedBy.length ? `通过成员：${approvedBy.map(esc).join('、')}` : '等待成员审核'}</p>`}${rejected ? `<div class="audit-rejection"><strong>审计建议</strong><p>${esc(rejectionSuggestion || '未填写建议')}</p></div>` : ''}${itemWarnings.map((entry) => `<p class="audit-explanation">${esc(entry.message)}</p>`).join('')}<div class="audit-actions"><button type="button" class="button button-light" data-rule-audit="approve" data-rule-id="${esc(rule.id)}" data-audit-item="${item}" ${approveDisabled ? 'disabled' : ''} title="${incomplete ? '补齐缺项后才能通过' : rejected ? '被打回的内容需先实际修改' : group.status === 'approved' ? '本审核项已有三位成员通过' : ''}">✓ ${currentReview?.decision === 'approve' ? '已通过' : '通过'}</button><button type="button" class="text-button audit-reject-button" data-rule-audit="reject" data-rule-id="${esc(rule.id)}" data-audit-item="${item}" ${currentReview?.decision === 'reject' ? 'disabled' : ''}>打回并建议</button></div>${history.length ? `<details class="audit-history"><summary>审核记录（${history.length}）</summary><ol>${history.map((entry) => `<li><strong>${esc(entry.username || entry.name || '成员')}</strong> · ${entry.decision === 'approve' ? '通过' : '打回'} · 第 ${esc(entry.revision)} 版 · ${esc(entry.createdAt || '')}${entry.suggestion ? `<p>${esc(entry.suggestion)}</p>` : ''}</li>`).join('')}</ol></details>` : ''}</article>`;
}


function renderFiles() { const folders = state.folders; return `<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span>FILE MANAGER</p><h1>文件管理<span class="heading-period">.</span></h1><p class="page-description">把来源、年份和题集放进清晰的文件夹。</p></div>${button('<span class="button-plus">+</span>新建文件夹', 'newFolderButton')}</section><section class="file-toolbar"><div class="file-breadcrumb"><button type="button" data-file-home>全部文件</button>${state.filePath.slice(1).map((part) => `<span> / </span><strong>${esc(part)}</strong>`).join('')}</div><div class="file-actions"><button class="button button-light" type="button" id="sortFilesButton">按最近更新</button><button class="icon-button bordered" type="button" title="列表视图">☷</button></div></section><section class="file-layout"><div class="file-main"><div class="file-section-heading"><span>FOLDERS</span><span>${folders.length} 个文件夹</span></div><div class="folder-cards">${folders.map((folder) => `<button class="folder-card" type="button" data-folder="${esc(folder.id)}"><span class="folder-card-icon">▰</span><strong>${esc(folder.name)}</strong><small>${folder.count} puzzles <span>→</span></small></button>`).join('')}<button class="folder-card folder-card-new" type="button" id="newFolderCard"><span>+</span><strong>新建文件夹</strong></button></div><div class="file-section-heading file-section-heading-spaced"><span>RECENT FILES</span><span>按最近修改</span></div><div class="file-table"><div class="file-row file-head"><span>名称</span><span>位置</span><span>题目</span><span>更新</span></div>${[['Spring Selection', 'Logic Masters India / 2026', '08', '今天'], ['Paper & Pencil / Vol. 01', '日本パズル協会 / 2025', '24', '2 天前'], ['Example Puzzles', '个人收藏 / 2024', '12', '上周']].map(([name, location, count, updated]) => `<a class="file-row" href="#puzzle-128"><span class="file-name"><span class="file-mini-icon">▰</span><strong>${name}</strong></span><span class="muted">${location}</span><span>${count}</span><span class="muted">${updated}</span></a>`).join('')}</div></div><aside class="file-aside"><div class="file-aside-icon">⌘</div><h2>你的题目，<br /><em>有自己的位置。</em></h2><p>用来源、年份和题集整理资料。文件夹可以无限嵌套，之后也能随时移动。</p><div class="tree-mini"><span>⌄　▰ Logic Masters India</span><span>　⌄　▰ 2026</span><span>　　 ›　▰ Spring Selection</span></div></aside></section></div>`; }

function renderRecords() { const completed = state.puzzles.filter((puzzle) => puzzle.completed); return `<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span>PERSONAL LOG</p><h1>我的记录<span class="heading-period">.</span></h1><p class="page-description">这里保存你完成过的题目和评分。</p></div></section><section class="record-summary"><div><span>已完成</span><strong>${completed.length}</strong></div><div><span>已评分</span><strong>${completed.filter((puzzle) => puzzle.userRating).length}</strong></div><div><span>平均喜爱程度</span><strong>—</strong></div></section><section class="record-list"><div class="file-section-heading"><span>COMPLETED PUZZLES</span><span>${completed.length} 条记录</span></div>${completed.length ? completed.map((puzzle) => `<a class="record-row" href="#puzzle-${puzzle.number}"><span class="record-check">✓</span><span><strong>${esc(puzzle.title)}</strong><small>#${puzzle.number} · ${esc(puzzle.author)}</small></span><span class="muted">查看题目 →</span></a>`).join('') : '<div class="empty-state">还没有完成的题目。去题库挑一道开始吧。</div>'}</section></div>`; }
function renderAuthors() { const authors = [...new Set(state.puzzles.map((puzzle) => puzzle.author))]; return `<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span>CREATORS</p><h1>作者<span class="heading-period">.</span></h1><p class="page-description">按照作者浏览他们命制的所有题目。</p></div></section><div class="author-grid">${authors.map((author, index) => { const authored = state.puzzles.filter((puzzle) => puzzle.author === author); return `<a href="#library" class="author-card"><span class="author-card-avatar avatar-${['coral', 'mint', 'navy', 'amber'][index % 4]}">${esc(author[0] || '?')}</span><strong>${esc(author)}</strong><small>${authored.length} 道题目</small><span>查看题目 →</span></a>`; }).join('') || '<div class="empty-state">题库还没有作者记录。</div>'}</div></div>`; }

function openPuzzle(number) { window.location.hash = `#puzzle-${number}`; }
function renderPuzzlePage(number, scope = 'library') {
  const isCalendar = scope === 'calendar';
  const puzzles = isCalendar ? [...state.calendarPuzzles, ...state.calendarLeftovers] : state.puzzles;
  const puzzle = puzzles.find((item) => Number(item.number) === Number(number));
  if (!puzzle) return `<div class="page-wrap-inner"><div class="empty-state">找不到这道${isCalendar ? '日历' : ''}谜题。</div><a class="back-link" href="#${isCalendar ? 'calendar' : 'library'}">返回${isCalendar ? '谜题日历' : '题库'}</a></div>`;
  const hasRating = puzzle.userRating;
  const rule = puzzle.rule;
  const ruleSection = rule ? `<details open><summary>${ruleTitlePair(rule)}</summary>${rule.isVariant ? `<p class="rule-base">变体自：${esc(rule.baseRuleTitleZh || rule.baseRuleTitleEn || ruleTitle(state.rules.find((item) => String(item.id) === String(rule.baseRuleId)) || {}))}</p>` : ''}<div class="rule-language-grid"><section><h3>规则 · 中文</h3>${clauseMarkup(rule.rulesZh)}</section><section><h3>Rules · English</h3>${clauseMarkup(rule.rulesEn)}</section></div></details>` : `<details><summary>查看题目规则</summary><p>${esc(puzzle.rules || '暂未提供规则。')}</p></details>`;
  const isCalendarOwner = isCalendar && String(puzzle.submittedBy?.id) === String(state.user?.id);
  const isLeftover = isCalendar && puzzle.calendarStatus === 'leftover';
  const dateControl = isCalendarOwner ? `<div class="detail-block"><h3>建议日期</h3><div class="form-field">${renderCalendarDateInputs('suggestedDateEdit', puzzle.calendarYear || 2028, puzzle.suggestedMonthDay || (puzzle.suggestedDate ? puzzle.suggestedDate.slice(5) : ''))}</div><button class="button button-light date-save-button" id="saveSuggestedDateButton" type="button">保存日期</button></div>` : '';
  const deletePuzzleControl = isCalendarOwner ? `<button class="button button-danger puzzle-delete-button" id="deleteCalendarPuzzleButton" type="button" data-puzzle-number="${esc(puzzle.number)}" data-delete-token="${esc(puzzle.deleteToken || '')}" data-puzzle-title="${esc(puzzle.title)}" data-return-route="${esc(state.calendarReturnRoute)}" aria-label="删除日历谜题：${esc(puzzle.title)}" ${puzzle.deleteToken ? '' : 'disabled title="无法确认投稿身份，请刷新页面"'}>删除此投稿</button>` : '';
  const reviewHistory = (puzzle.reviewHistory || []).map((round) => `<li><strong>第 ${Number(round.reviewRound) || 1} 轮 · ${esc(calendarStatusLabel(round.status))}</strong><span class="calendar-review-history-summary">${esc(calendarReviewSummary(round))} · ${Number(round.evaluationCount || 0)} 份评价 · ${calendarDifficultyMarkup(puzzle, { averageDifficulty: round.averageDifficulty })}</span>${calendarReviewParticipantsMarkup(round.scoreParticipants)}</li>`).join('');
  const calendarReview = isCalendar ? `<section class="calendar-review-panel"><div class="calendar-review-stat"><span>当前轮次</span><strong>第 ${Number(puzzle.reviewRound) || 1} 轮 · ${esc(calendarStatusLabel(calendarAreaOf(puzzle)))}</strong></div><div class="calendar-review-stat"><span>当前喜爱程度</span><strong>${esc(calendarReviewSummary(puzzle.review))}</strong></div><div class="calendar-review-stat"><span>全体难度评价</span><strong>${calendarDifficultyMarkup(puzzle, puzzle.evaluationSummary)}</strong></div><div class="calendar-review-stat"><span>你的喜爱程度</span><strong>${esc(calendarVoteLabel(puzzle.userVote) || '尚未评分')}</strong></div>${puzzle.evaluation ? `<p class="calendar-personal-evaluation">你的难度：${Number(puzzle.evaluation.difficulty) || '—'} / 6 · 评价标签：${esc((puzzle.evaluation.tags || []).join('、') || '未选')}</p>` : ''}<div class="calendar-participant-section"><h3>第 ${Number(puzzle.reviewRound) || 1} 轮喜爱评分成员</h3>${calendarReviewParticipantsMarkup(puzzle.review?.scoreParticipants)}${ratingParticipantsMarkup(puzzle.ratingParticipants, '评分者（全部轮次）')}</div>${reviewHistory ? `<details class="calendar-review-history"><summary>轮次历史（${puzzle.reviewHistory.length}）</summary><ol>${reviewHistory}</ol></details>` : ''}</section>` : '';
  const reviewAction = isCalendar ? (isLeftover ? `<div class="detail-block record-panel"><h3>本轮已归档</h3><p class="record-help">该投稿在第 ${Number(puzzle.reviewRound) || 1} 轮被暂存。重新进入会开启新一轮评分，并保留历史评价与评分记录。</p>${button('重新进入新一轮', 'reenterCalendarPuzzleButton', 'button button-dark')}</div>` : `<div class="detail-block record-panel"><h3>完成与评价</h3><p class="record-help">完成题目后提交难度、标签和本轮喜爱评分。喜爱评分在通过后仍可修改。</p>${button(puzzle.completed ? '✓ 已完成 · 修改喜爱评分' : '标记完成并评价', 'completePuzzleButton', puzzle.completed ? 'button button-dark' : 'button button-light')}</div>`) : `<div class="detail-block record-panel"><h3>ANSWER RECORD</h3><p class="record-help">完成题目后，分别评价逻辑难度、通灵难度和喜爱程度。</p><button class="button ${puzzle.completed ? 'button-dark' : 'button-light'}" id="completePuzzleButton" type="button">${puzzle.completed ? '✓ 已完成 · 修改评分' : '标记为已完成'}</button>${hasRating ? `<div class="submitted-rating"><span>我的评分</span>${ratingMarkup(puzzle.userRating, 1)}</div>` : ''}${ratingParticipantsMarkup(puzzle.ratingParticipants)}</div>`;
  const authorName = puzzle.author || puzzle.submittedBy?.name || '未知作者';
  const authorLabel = isCalendar ? esc(authorName) : `<a href="#authors">${esc(authorName)}</a>`;
  return `<div class="page-wrap-inner puzzle-page"><a class="back-link" href="#${isCalendar ? state.calendarReturnRoute : 'library'}">← 返回${isCalendar ? ({pending:'我的未完成谜题',leftovers:'leftover 区',allocation:'待分配区',finished:'完成区'})[state.calendarReturnRoute] || '待审核区' : '题库'}</a><section class="puzzle-header"><div><p class="eyebrow"><span class="eyebrow-line"></span>${isCalendar ? 'CALENDAR PUZZLE' : 'PUZZLE'} #${puzzle.number}</p><h1>${esc(puzzle.title)}<span class="heading-period">.</span></h1><p class="puzzle-meta-large">${esc(puzzle.type)}　·　由 ${authorLabel} 发布${isCalendar ? `　·　${esc(calendarDateLabel(puzzle))}` : `　·　${puzzle.votes} 位解题者评分`}</p></div><div class="puzzle-header-tags">${tagMarkup(puzzle.tags)}${isCalendarOwner ? '<button type="button" class="button button-light" id="editCalendarPuzzleButton">编辑题目</button>' : ''}${!isCalendar ? '<button class="tag-add-button" type="button" id="addTagButton">+ 添加标签</button>' : deletePuzzleControl}</div></section>${calendarReview}${isCalendar ? renderCalendarWorkflow(puzzle) : ''}<section class="puzzle-content-grid"><div class="puzzle-board-column"><div class="embed-toolbar"><span class="embed-label">${puzzle.inputMode === 'blank' ? 'SELF-CONTAINED' : 'OPEN PUZZLE'}</span></div><div class="puzzle-embed" id="puzzleEmbed">${renderEmbed(puzzle)}</div><div class="puzzle-open-actions">${puzzle.inputMode === 'blank' ? '<span class="muted">这是一个内置填空题</span>' : '<span class="muted">外部题目通过上方工具按钮在新标签页打开</span>'}</div></div><aside class="puzzle-sidebar"><div class="detail-block"><h3>作者的话</h3><p>${esc(puzzle.note || '暂无说明。')}</p></div><div class="detail-block"><h3>规则</h3>${ruleSection}</div>${dateControl}${reviewAction}${!isCalendar ? '<div class="detail-block"><h3>留言板</h3><p class="muted">还没有留言。</p><div class="comment-box"><input type="text" placeholder="写下你的想法" aria-label="留言内容" /><button type="button" id="commentButton">发送</button></div></div>' : ''}</aside></section>${isCalendar ? renderCalendarComments(puzzle) : ''}</div>`;
}

function renderPuzzleOpenTools(puzzle) {
  const links = buildPuzzleToolLinks(puzzle.url);
  const trustedUrl = parseTrustedPuzzleUrl(puzzle.url);
  if (!links.length || !trustedUrl) {
    return `<div class="tool-launch-panel tool-launch-blocked" role="alert"><span class="tool-launch-kicker">BLOCKED</span><strong>该链接不在支持的工具范围内</strong><p>请使用 puzz.link、pzv3、pzprxs、pzplus 或 Penpa 系列的官方题目链接。</p></div>`;
  }
  const hasPayload = hasConcretePuzzlePayload(trustedUrl.href);
  const isPenpa = getPuzzleSource(trustedUrl.href) === 'penpa+';
  const keyboardButton = isPenpa && hasPayload ? button('启用键盘操作', 'enablePenpaKeyboardButton', 'button button-light solver-keyboard-button') : '';
  const toolbar = `<div class="solver-toolbar"><div class="solver-toolbar-copy"><span class="tool-launch-kicker">IN-PAGE SOLVER</span><strong>页内解题</strong></div><div class="tool-link-list">${links.map((link) => `<a class="tool-link-button" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer"><span>${esc(link.name)}</span><strong>在新标签页解题 ↗</strong></a>`).join('')}${keyboardButton}</div></div>`;
  if (!hasPayload) {
    return `<div class="solver-shell">${toolbar}<div class="solver-empty"><strong>这个示例还没有具体题面 URL</strong><p>为避免加载网站首页文本，页内模块已停用。请使用上方工具按钮打开。</p></div></div>`;
  }
  return `<div class="solver-shell">${toolbar}<div class="solver-frame"><iframe src="${esc(trustedUrl.href)}" title="${esc(puzzle.title)}"${isPenpa ? ' data-penpa-keyboard' : ''}></iframe></div><p class="solver-note">上方按钮会打开对应网站；当前模块直接在页面内加载原题。${isPenpa ? '点击题目格子后，可直接使用方向键和数字键；若键盘无响应，可点击“启用键盘操作”后再点击格子。' : ''}</p></div>`;
}

function renderEmbed(puzzle) {
  if (puzzle.inputMode === 'blank') return `<div class="blank-puzzle"><span class="blank-kicker">FILL IN</span><h2>${esc(puzzle.title)}</h2><p>请根据规则填写答案。</p><label><span>你的答案</span><input id="blankAnswer" type="text" placeholder="输入答案" /></label><button type="button" class="button button-dark" id="checkBlankButton">检查答案</button><p id="blankResult" class="blank-result"></p></div>`;
  return renderPuzzleOpenTools(puzzle);
}

function isSupportedPuzzleUrl(value) { return parseTrustedPuzzleUrl(value) !== null; }

function openRating(number, scope = 'library') { const isCalendar = scope === 'calendar'; const puzzles = isCalendar ? [...state.calendarPuzzles, ...state.calendarLeftovers] : state.puzzles; const puzzle = puzzles.find((item) => Number(item.number) === Number(number)); if (!puzzle) return; if (isCalendar) return openCalendarEvaluation(puzzle); const current = puzzle.userRating || [3, 3, 3]; openModal(`<p class="modal-eyebrow">ANSWER RECORD · #${puzzle.number}</p><h2 id="modalTitle">完成并评分</h2><p class="modal-intro">请在完成 ${esc(puzzle.title)} 后，为三个维度各给出 1–5 分。</p><div class="rating-form"><label><span>✎ 逻辑难度 <b id="logicValue">${current[0]}</b></span><input type="range" id="logicRating" min="1" max="5" step="1" value="${current[0]}" /></label><label><span>♧ 通灵难度 <b id="intuitionValue">${current[1]}</b></span><input type="range" id="intuitionRating" min="1" max="5" step="1" value="${current[1]}" /></label><label><span>♥ 喜爱程度 <b id="loveValue">${current[2]}</b></span><input type="range" id="loveRating" min="1" max="5" step="1" value="${current[2]}" /></label></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button('提交完成记录', 'submitRatingButton')}</div>`); ['logic', 'intuition', 'love'].forEach((key) => { const input = document.querySelector(`#${key}Rating`); const output = document.querySelector(`#${key}Value`); input.addEventListener('input', () => { output.textContent = input.value; }); }); document.querySelector('#submitRatingButton').addEventListener('click', async () => { const ratings = ['logic', 'intuition', 'love'].map((key) => Number(document.querySelector(`#${key}Rating`).value)); const requestEpoch = state.sessionEpoch; const userId = state.user?.id; try { const data = await apiRequest(`/api/puzzles/${number}/complete-rating`, { method: 'POST', body: JSON.stringify({ logic: ratings[0], intuition: ratings[1], enjoyment: ratings[2] }) }); if (!isCurrentUserSession(requestEpoch, userId)) return; applyPuzzleData(data.puzzles); closeModal(); renderRoute(); showToast('完成记录已保存，平均评分已更新'); } catch (error) { if (isCurrentUserSession(requestEpoch, userId)) showToast(error.message); } }); }
async function refreshCalendarData(epoch = state.sessionEpoch, userId = state.user?.id) { const [activeData, leftoverData] = await Promise.all([apiRequest('/api/calendar/puzzles'), apiRequest('/api/calendar/leftovers')]); if (!isCurrentUserSession(epoch, userId)) return false; state.calendarPuzzles = (activeData.puzzles || []).map(normalizePuzzle); state.calendarLeftovers = (leftoverData.puzzles || []).map(normalizePuzzle); return true; }
function calendarVoteLabel(vote) { return vote==='veto'?'一票否决':[-2,-1,0,1,2].includes(vote)?`${vote>0?'+':''}${vote} 分`:''; }
function openCalendarEvaluation(puzzle) {
  if (puzzle.calendarStatus === 'leftover') return;
  const difficulty = Number(puzzle.evaluation?.difficulty) || 0;
  const tags = Array.isArray(puzzle.evaluation?.tags) ? puzzle.evaluation.tags : [];
  const vote = puzzle.userVote ?? '';
  openModal(`<p class="modal-eyebrow">CALENDAR REVIEW · ROUND ${Number(puzzle.reviewRound) || 1}</p><h2 id="modalTitle">完成与评价</h2><p class="modal-intro">完成「${esc(puzzle.title)}」后提交你的难度、标签和本轮喜爱程度评分。标签可选 0–6 项；喜爱评分在通过后仍可修改。</p><fieldset class="calendar-evaluation-fieldset"><legend>难度（必选）</legend><div class="difficulty-options">${[1,2,3,4,5,6].map((value) => `<label><input type="radio" name="calendarDifficulty" value="${value}" ${value === difficulty ? 'checked' : ''} /><span>${value}</span></label>`).join('')}</div></fieldset><fieldset class="calendar-evaluation-fieldset"><legend>评价标签（可选）</legend><div class="calendar-tag-options">${CALENDAR_REVIEW_TAGS.map((tag) => `<label><input type="checkbox" name="calendarTag" value="${esc(tag)}" ${tags.includes(tag) ? 'checked' : ''} /><span>${esc(tag)}</span></label>`).join('')}</div></fieldset><fieldset class="calendar-evaluation-fieldset"><legend>喜爱程度（必选）</legend><div class="calendar-vote-options">${CALENDAR_REVIEW_VOTES.map((value) => `<label><input type="radio" name="calendarVote" value="${value}" ${value === vote ? 'checked' : ''} /><span>${calendarVoteLabel(value)}</span></label>`).join('')}</div><p class="form-help">至少三名不同成员评分且未四舍五入的平均分严格大于 0 才通过；一票否决会立即转入 leftover。</p></fieldset><div class="modal-error" id="calendarEvaluationError" role="alert" aria-live="polite"></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button('提交完成与评分', 'submitCalendarEvaluationButton')}</div>`);
  const errorNode = document.querySelector('#calendarEvaluationError');
  const submit = document.querySelector('#submitCalendarEvaluationButton');
  submit.addEventListener('click', async () => {
    if (submit.disabled) return;
    const selectedDifficulty = Number(document.querySelector('input[name="calendarDifficulty"]:checked')?.value);
    const selectedVote = document.querySelector('input[name="calendarVote"]:checked')?.value;
    if (!selectedDifficulty || !selectedVote) { errorNode.textContent = '请选择难度和喜爱程度评分。'; return; }
    const selectedTags = [...document.querySelectorAll('input[name="calendarTag"]:checked')].map((input) => input.value);
    const requestEpoch = state.sessionEpoch; const userId = state.user?.id; const modalStillOpen = () => errorNode.isConnected;
    submit.disabled = true; submit.textContent = '正在提交…';
    try {
      const data = await apiRequest(`/api/calendar/puzzles/${encodeURIComponent(puzzle.number)}/complete-rating`, { method: 'POST', body: JSON.stringify({ difficulty: selectedDifficulty, tags: selectedTags, vote: selectedVote==='veto'?'veto':Number(selectedVote), expectedReviewRound: Number(puzzle.reviewRound) || 1 }) });
      if (!isCurrentUserSession(requestEpoch, userId)) return;
      applyCalendarPuzzle(data.puzzle);
      const mayClose = modalStillOpen(); if (mayClose) closeModal(); updateCalendarReviewPage(data.puzzle); if (mayClose) showToast('完成记录与本轮喜爱程度评分已保存');
    } catch (error) {
      if (!isCurrentUserSession(requestEpoch, userId) || !modalStillOpen()) return;
      if (error.status === 409) { try { await refreshCalendarData(requestEpoch, userId); } catch {} if (!isCurrentUserSession(requestEpoch, userId) || !modalStillOpen()) return; renderRoute(); errorNode.textContent = '本轮状态已变化，数据已刷新。请取消并重新打开表单后再操作；未自动重试本次提交。'; submit.disabled = true; submit.textContent = '轮次已更新'; }
      else { errorNode.textContent = error.message || '提交失败，请稍后重试。'; submit.disabled = false; submit.textContent = '提交完成与评分'; }
    }
  });
}
function openCalendarReentry(puzzle) {
  const target = { number: puzzle.number, title: puzzle.title, reviewRound: Number(puzzle.reviewRound) || 1 };
  openModal(`<p class="modal-eyebrow">CALENDAR REENTRY · ROUND ${target.reviewRound}</p><h2 id="modalTitle">重新进入新一轮</h2><p class="modal-intro">确认将「${esc(target.title)}」重新放入活动日历？这会开启第 ${target.reviewRound + 1} 轮并重置当前喜爱程度；此前轮次、完成记录和评价会保留。</p><div class="modal-error" id="calendarReentryError" role="alert" aria-live="polite"></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button('确认重新进入', 'confirmCalendarReentryButton', 'button button-dark')}</div>`);
  const errorNode = document.querySelector('#calendarReentryError'); const confirm = document.querySelector('#confirmCalendarReentryButton');
  confirm.addEventListener('click', async () => {
    if (confirm.disabled) return;
    const requestEpoch = state.sessionEpoch; const userId = state.user?.id; confirm.disabled = true; confirm.textContent = '正在重新进入…';
    try {
      const data = await apiRequest(`/api/calendar/puzzles/${encodeURIComponent(target.number)}/reenter`, { method: 'POST', body: JSON.stringify({ expectedReviewRound: target.reviewRound }) });
      if (!isCurrentUserSession(requestEpoch, userId)) return;
      applyCalendarPuzzle(data.puzzle);
      const mayClose = errorNode.isConnected; if (mayClose) closeModal(); state.calendarReturnRoute = 'calendar'; const detailHash = `#calendar-puzzle-${target.number}`; if (window.location.hash === detailHash) updateCalendarReviewPage(data.puzzle); else window.location.hash = detailHash; if (mayClose) showToast(`「${target.title}」已进入新一轮`);
    } catch (error) {
      if (!isCurrentUserSession(requestEpoch, userId) || !errorNode.isConnected) return;
      if (error.status === 409) { try { await refreshCalendarData(requestEpoch, userId); } catch {} if (!isCurrentUserSession(requestEpoch, userId) || !errorNode.isConnected) return; errorNode.textContent = '轮次已被其他成员更新，列表已刷新。请取消后重新打开确认框。'; confirm.disabled = true; confirm.textContent = '轮次已更新'; }
      else { errorNode.textContent = error.message || '无法重新进入，请稍后重试。'; confirm.disabled = false; confirm.textContent = '确认重新进入'; }
    }
  });
}
function bindLibrary() { document.querySelector('#addPuzzleButton')?.addEventListener('click', openAddPuzzle); document.querySelector('#filterButton')?.addEventListener('click', () => { const row = document.querySelector('#filterRow'); row.hidden = !row.hidden; }); document.querySelectorAll('.filter-pill').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.filter; state.visible = 6; renderRoute(); })); document.querySelectorAll('.segment').forEach((button) => button.addEventListener('click', () => { state.sort = button.dataset.sort; renderRoute(); })); document.querySelector('#loadMoreButton')?.addEventListener('click', () => { state.visible = Math.min(state.visible + 2, filteredPuzzles().length); renderRoute(); showToast('已加载更多题目'); }); document.querySelector('#noticeButton')?.addEventListener('click', () => showToast('公告详情将在公告模块接入后开放')); }
function ruleSearchPickerMarkup(prefix, selectedRule = null) {
  return `<div class="submission-rule-picker"><input id="${prefix}Search" type="search" role="combobox" aria-label="搜索规则" aria-autocomplete="list" aria-expanded="false" aria-controls="${prefix}Options" autocomplete="off" value="${selectedRule ? esc(ruleDisplayName(selectedRule)) : ''}" placeholder="搜索中英文规则或分类" /><input id="${prefix}" type="hidden" value="${selectedRule ? esc(selectedRule.id) : ''}" /><div class="submission-rule-dropdown" id="${prefix}Dropdown" hidden><div id="${prefix}Options" class="submission-rule-options" role="listbox" aria-label="规则选项"></div><p id="${prefix}Status" class="submission-rule-status" role="status" hidden></p></div></div>`;
}
function bindRuleSearchPicker(prefix, availableRules, onChange = () => {}) {
  const searchInput = document.getElementById(`${prefix}Search`);
  const selectedIdInput = document.getElementById(prefix);
  const dropdown = document.getElementById(`${prefix}Dropdown`);
  const optionsNode = document.getElementById(`${prefix}Options`);
  const statusNode = document.getElementById(`${prefix}Status`);
  let matchingRules = [];
  let activeRuleIndex = -1;
  const preview = onChange;
  const renderOptions = (query) => {
    matchingRules = filterRuleOptions(query, availableRules());
    if (!matchingRules.length) {
      optionsNode.innerHTML = '';
      statusNode.textContent = availableRules().length ? '没有匹配的规则。' : '规则目录为空，请先创建规则。';
      statusNode.hidden = false;
      searchInput.removeAttribute('aria-activedescendant');
      return;
    }
    statusNode.hidden = true;
    optionsNode.innerHTML = matchingRules.map((rule, index) => `<div id="${prefix}Option-${index}" class="submission-rule-option ${index === activeRuleIndex ? 'is-active' : ''}" role="option" aria-selected="${String(rule.id) === selectedIdInput.value}" data-rule-option="${index}"><span>${esc(ruleDisplayName(rule))}</span><small>${esc(rule.category || '未分类')}</small>${String(rule.id) === selectedIdInput.value ? '<b aria-hidden="true">✓</b>' : ''}</div>`).join('');
    if (activeRuleIndex >= 0 && activeRuleIndex < matchingRules.length) {
      const activeOptionId = `${prefix}Option-${activeRuleIndex}`;
      searchInput.setAttribute('aria-activedescendant', activeOptionId);
      document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
    } else searchInput.removeAttribute('aria-activedescendant');
  };
  const openOptions = (query = searchInput.value) => {
    dropdown.hidden = false;
    searchInput.setAttribute('aria-expanded', 'true');
    renderOptions(query);
  };
  const closeOptions = () => {
    dropdown.hidden = true;
    searchInput.setAttribute('aria-expanded', 'false');
    searchInput.removeAttribute('aria-activedescendant');
    activeRuleIndex = -1;
  };
  const chooseRule = (rule) => {
    if (!rule) return;
    selectedIdInput.value = String(rule.id);
    searchInput.value = ruleDisplayName(rule);
    closeOptions();
    preview();
  };
  searchInput.addEventListener('focus', () => {
    if (selectedIdInput.value) searchInput.select();
    activeRuleIndex = -1;
    openOptions(selectedIdInput.value ? '' : searchInput.value);
  });
  searchInput.addEventListener('input', () => {
    selectedIdInput.value = '';
    activeRuleIndex = -1;
    preview();
    openOptions(searchInput.value);
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (dropdown.hidden) openOptions(searchInput.value);
      if (!matchingRules.length) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      activeRuleIndex = activeRuleIndex < 0 ? (direction > 0 ? 0 : matchingRules.length - 1) : (activeRuleIndex + direction + matchingRules.length) % matchingRules.length;
      renderOptions(searchInput.value);
    } else if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && !dropdown.hidden && activeRuleIndex >= 0) {
      event.preventDefault();
      chooseRule(matchingRules[activeRuleIndex]);
    } else if (event.key === 'Escape' && !dropdown.hidden) {
      event.preventDefault();
      closeOptions();
    }
  });
  optionsNode.addEventListener('click', (event) => {
    const option = event.target.closest('[data-rule-option]');
    if (option) chooseRule(matchingRules[Number(option.dataset.ruleOption)]);
  });
  let optionPointerActive = false;
  optionsNode.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('[data-rule-option]')) return;
    optionPointerActive = true;
    const finishPointer = () => {
      document.removeEventListener('pointerup', finishPointer);
      document.removeEventListener('pointercancel', finishPointer);
      window.setTimeout(() => {
        optionPointerActive = false;
        if (!searchInput.closest('.submission-rule-picker').contains(document.activeElement)) closeOptions();
      }, 0);
    };
    document.addEventListener('pointerup', finishPointer);
    document.addEventListener('pointercancel', finishPointer);
  });
  searchInput.addEventListener('blur', () => window.setTimeout(() => {
    if (optionPointerActive) return;
    if (!searchInput.closest('.submission-rule-picker').contains(document.activeElement)) closeOptions();
  }, 0));
  preview();
}
function renderPenpaGuidelines() {
  const guidelines = state.penpaGuidelines;
  return `<aside class="penpa-guidelines"><strong>Penpa+ 制图规范</strong><p>请按当前规范检查题面与答案的图层、Visibility、网格、颜色及图形尺寸，并展开阅读全文后审核。</p><details><summary>查看完整制图规范（docs/penpa.md）</summary><pre>${esc(guidelines?.text || '正在加载制图规范，请稍候。')}</pre></details></aside>`;
}
function calendarLinkFields(prefix, puzzle = {}) {
  const legacy = normalizeCalendarLinks({url:puzzle.url || ''}).value || {};
  return `<label class="form-field"><span>Penpa 编辑链接（上传时可留空）</span><input id="${prefix}PenpaEdit" type="url" maxlength="4096" value="${esc(puzzle.penpaEditUrl ?? legacy.penpaEditUrl ?? '')}" placeholder="https://penpa-edit.com/?m=edit&p=…" /></label><label class="form-field"><span>Penpa 解题链接</span><input id="${prefix}PenpaSolve" type="url" maxlength="4096" value="${esc(puzzle.penpaSolveUrl ?? legacy.penpaSolveUrl ?? '')}" placeholder="https://penpa-edit.com/?m=solve&p=…" /></label><label class="form-field"><span>puzz.link / fork 链接（可选）</span><input id="${prefix}Puzzlink" type="url" maxlength="4096" value="${esc(puzzle.puzzlinkUrl ?? legacy.puzzlinkUrl ?? '')}" placeholder="https://puzz.link/p?…" /></label><p class="form-help">上传时至少提供 Penpa 解题或 puzz.link 链接之一。支持 puzz.link、pzplus.tck.mn、pzprxs.vercel.app 和 pzv.jp 的具体题目链接。至少三人评分且平均分大于 0 通过后需补齐两种 Penpa 链接；fork 链接可留空。</p>${renderPenpaGuidelines()}`;
}
function readCalendarLinks(prefix, inputMode = 'external') {
  return normalizeCalendarLinks({inputMode,penpaEditUrl:document.getElementById(`${prefix}PenpaEdit`).value,penpaSolveUrl:document.getElementById(`${prefix}PenpaSolve`).value,puzzlinkUrl:document.getElementById(`${prefix}Puzzlink`).value});
}
function openAddPuzzle(scope = 'library', draft = {}) {
  if (state.rulesStatus !== 'loaded') { requireRulesForModal('准备投稿', () => openAddPuzzle(scope, draft)); return; }
  const isCalendar = scope === 'calendar';
  const initialRule = state.rules.find((rule) => String(draft.ruleId || '') === String(rule.id));
  const initialRuleId = initialRule ? String(initialRule.id) : '';
  const uploaderName = state.user?.username || state.user?.name || '';
  const authorFields = isCalendar
    ? `<label class="form-field"><span>投稿用户</span><input id="newPuzzleUploader" type="text" value="${esc(uploaderName)}" readonly /><span class="form-help">投稿身份由登录账号确定。</span></label><label class="form-field"><span>题目作者 / 署名（可选）</span><input id="newPuzzleAuthor" type="text" value="${esc(draft.author || uploaderName)}" placeholder="题目作者名" /></label>`
    : `<label class="form-field"><span>作者</span><input id="newPuzzleAuthor" type="text" value="${esc(draft.author || '')}" placeholder="作者名" /></label>`;
  openModal(`<p class="modal-eyebrow">${isCalendar ? 'PRIVATE CALENDAR' : 'NEW LIBRARY ENTRY'}</p><h2 id="modalTitle">${isCalendar ? '提交日历谜题' : '添加一道题目'}</h2><p class="modal-intro">先选择目录中的规则；如果没有合适规则，可以创建后自动返回此表单。</p><div class="form-field"><span id="submissionRuleLabel">规则（必选）</span><div class="submission-rule-picker"><input id="submissionRuleSearch" type="search" role="combobox" aria-labelledby="submissionRuleLabel" aria-autocomplete="list" aria-expanded="false" aria-controls="submissionRuleOptions" aria-required="true" autocomplete="off" value="${initialRule ? esc(ruleDisplayName(initialRule)) : ''}" placeholder="搜索中英文规则或分类" /><input id="submissionRule" type="hidden" value="${esc(initialRuleId)}" /><div class="submission-rule-dropdown" id="submissionRuleDropdown" hidden><div id="submissionRuleOptions" class="submission-rule-options" role="listbox" aria-labelledby="submissionRuleLabel"></div><p id="submissionRuleStatus" class="submission-rule-status" role="status" hidden></p></div></div><button class="text-button rule-create-inline" id="createRuleFromSubmission" type="button">＋ 新建规则</button></div><div id="submissionRulePreview" class="submission-rule-preview"></div><label class="form-field"><span>题目标题</span><input id="newPuzzleTitle" type="text" value="${esc(draft.title || '')}" placeholder="例如：Five Cells" /></label>${isCalendar ? calendarLinkFields('newPuzzle',draft) : `<label class="form-field"><span>题目链接（外链题目可填写）</span><input id="newPuzzleUrl" type="url" value="${esc(draft.url || '')}" placeholder="https://puzz.link/..." /></label>`}${authorFields}<label class="form-field"><span>类型</span><select id="newPuzzleMode"><option value="external" ${draft.inputMode !== 'blank' ? 'selected' : ''}>外部题目（puzz.link / penpa+）</option><option value="blank" ${draft.inputMode === 'blank' ? 'selected' : ''}>纯填空题</option></select></label><label class="form-field"><span>作者说明（可选）</span><textarea id="newPuzzleNote" rows="3" placeholder="简要介绍这道题">${esc(draft.note || '')}</textarea></label><label class="form-field"><span>答案（纯填空题可选）</span><input id="newPuzzleAnswer" type="text" value="${esc(draft.answer || '')}" placeholder="答案" /></label>${isCalendar ? `<div class="form-field"><span>建议年份和日期（日期可选）</span>${renderCalendarDateInputs('newPuzzleDate', Number(draft.calendarYear) || 2028, draft.suggestedMonthDay || (draft.suggestedDate ? draft.suggestedDate.slice(5) : ''))}</div>` : ''}<div class="modal-error" id="submissionError" role="alert"></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button('保存题目', 'savePuzzleButton')}</div>`);
  if (isCalendar) bindCalendarDateInputs('newPuzzleDate');
  bindRuleSearchPicker('submissionRule', () => state.rules, () => {
    const rule = state.rules.find((item) => String(item.id) === document.querySelector('#submissionRule').value);
    document.querySelector('#submissionRulePreview').innerHTML = rule ? `<strong>${ruleTitlePair(rule)}</strong>${clauseMarkup(rule.rulesZh)}` : '<span class="muted">选择目录规则后可预览规则。</span>';
  });
  document.querySelector('#createRuleFromSubmission').addEventListener('click', () => { state.submissionDraft = { scope, draft: captureSubmissionDraft() }; openRuleEditor({ fromSubmission: true }); });
  document.querySelector('#savePuzzleButton').addEventListener('click', async () => {
    const title = document.querySelector('#newPuzzleTitle').value.trim(); const mode = document.querySelector('#newPuzzleMode').value; const links = isCalendar ? readCalendarLinks('newPuzzle',mode) : null; const url = isCalendar ? links.value?.url || '' : document.querySelector('#newPuzzleUrl').value.trim(); const ruleId = document.querySelector('#submissionRule').value;
    if (!title || !ruleId) { document.querySelector('#submissionError').textContent = title ? '请选择规则，或先创建一条新规则。' : '请填写题目标题。'; return; }
    if (links?.error) { document.querySelector('#submissionError').textContent = links.error; return; }
    if (mode === 'external' && !isSupportedPuzzleUrl(url)) { document.querySelector('#submissionError').textContent = '外部题目必须使用受支持的 puzz.link、Penpa+ 或同类工具链接。'; return; }
    const calendarDate = isCalendar ? readCalendarDateFields('newPuzzleDate') : null;
    if (calendarDate?.error) { document.querySelector('#submissionError').textContent = calendarDate.error; return; }
    const input = { title, ruleId, type: mode === 'blank' ? '填空题' : '逻辑题', author: document.querySelector('#newPuzzleAuthor').value.trim() || state.user.name, source: mode === 'blank' ? '填空题' : getPuzzleSource(url), url, inputMode: mode, answer: document.querySelector('#newPuzzleAnswer').value.trim(), note: document.querySelector('#newPuzzleNote').value.trim() };
    if (isCalendar) { Object.assign(input,links.value); input.author = document.querySelector('#newPuzzleAuthor').value.trim() || state.user.username || state.user.name; input.calendarYear = calendarDate.calendarYear; input.suggestedMonthDay = calendarDate.suggestedMonthDay; }
    const requestEpoch = state.sessionEpoch; const userId = state.user?.id; const errorNode = document.querySelector('#submissionError');
    try {
      const path = isCalendar ? '/api/calendar/puzzles' : '/api/puzzles'; const data = await apiRequest(path, { method: 'POST', body: JSON.stringify(input) });
      if (isCalendar) { state.calendarPuzzles = data.puzzles.map(normalizePuzzle); const puzzle = normalizePuzzle(data.puzzle || state.calendarPuzzles.find((item) => item.number === Math.max(...state.calendarPuzzles.map((item) => item.number)))); closeModal(); window.location.hash = `#calendar-puzzle-${puzzle.number}`; }
      else { applyPuzzleData(data.puzzles); const newest = Math.max(...state.puzzles.map((puzzle) => puzzle.number)); closeModal(); window.location.hash = `#puzzle-${newest}`; }
      showToast('题目已创建');
    } catch (error) { if (isCurrentUserSession(requestEpoch, userId) && errorNode.isConnected) errorNode.textContent = error.message; }
  });
}
function captureSubmissionDraft() { const draft = { ruleId: document.querySelector('#submissionRule')?.value || '', title: document.querySelector('#newPuzzleTitle')?.value || '', url: document.querySelector('#newPuzzleUrl')?.value || '', author: document.querySelector('#newPuzzleAuthor')?.value || '', inputMode: document.querySelector('#newPuzzleMode')?.value || 'external', note: document.querySelector('#newPuzzleNote')?.value || '', answer: document.querySelector('#newPuzzleAnswer')?.value || '' }; if (document.querySelector('#newPuzzlePenpaEdit')) { for (const [key,id] of [['penpaEditUrl','PenpaEdit'],['penpaSolveUrl','PenpaSolve'],['puzzlinkUrl','Puzzlink']]) draft[key] = document.getElementById(`newPuzzle${id}`).value; } if (document.querySelector('#newPuzzleDateYear')) Object.assign(draft, readCalendarDateFields('newPuzzleDate')); return draft; }
function openRuleEditor({ fromSubmission = false, draft = null, rule = null } = {}) {
  if (state.rulesStatus !== 'loaded') { requireRulesForModal('打开规则编辑器', () => openRuleEditor({ fromSubmission, draft, rule })); return; }
  const editing = Boolean(rule);
  const rejectedItems = editing ? ['name', 'description', 'example'].filter((item) => rule.quality?.groups?.[item]?.rejected || rule.quality?.groups?.[item]?.status === 'rejected') : [];
  const rejectedHint = rejectedItems.length ? `<p class="audit-edit-warning" role="note">${rejectedItems.map((item) => auditLabels[item]).join('、')}已被打回。只有实际修改该项内容后才会重新开始审核；重新保存相同内容不会清除打回状态。</p>` : '';
  const selectedBase = state.rules.find((item) => String(item.id) === String(rule?.baseRuleId));
  openModal(`<p class="modal-eyebrow">RULE CATALOG</p><h2 id="modalTitle">${editing ? '编辑规则' : '新建规则'}</h2><p class="modal-intro">名称、规则描述、例题会分别审核。可先保存草稿，留空项会标示为待补充。</p>${rejectedHint}<label class="form-field"><span>中文名称</span><input id="ruleTitleZh" type="text" value="${esc(rule?.titleZh || '')}" aria-label="规则中文名称" /></label><label class="form-field"><span>English name</span><input id="ruleTitleEn" type="text" value="${esc(rule?.titleEn || '')}" aria-label="Rule English name" /></label><label class="form-field"><span>分类 <b class="required-mark">必填</b></span><select id="ruleCategory"><option value="">选择分类</option>${ruleCategories.map((item) => `<option ${rule?.category === item ? 'selected' : ''}>${item}</option>`).join('')}</select></label><label class="form-field"><span>规则描述 · 中文（每行一条，可留空）</span><textarea id="ruleClausesZh" rows="4" aria-label="中文规则描述，每行一条">${esc((rule?.rulesZh || draft?.rulesZh || []).join('\n'))}</textarea></label><label class="form-field"><span>Rules · English (one clause per line, optional)</span><textarea id="ruleClausesEn" rows="4" aria-label="English rule description, one clause per line">${esc((rule?.rulesEn || draft?.rulesEn || []).join('\n'))}</textarea></label><label class="form-field"><span>例题作者（可留空）</span><input id="ruleExampleAuthor" type="text" maxlength="200" value="${esc(rule?.exampleAuthor || '')}" aria-label="例题作者" /></label><label class="form-field"><span>例题 Penpa URL（可留空）</span><input id="ruleExampleUrl" type="url" maxlength="4096" value="${esc(rule?.exampleUrl || '')}" placeholder="https://penpa-edit.com/..." /></label><label class="variant-toggle"><input id="ruleIsVariant" type="checkbox" ${rule?.isVariant ? 'checked' : ''} /> 这是变体规则</label><div class="form-field" id="baseRuleField" ${rule?.isVariant ? '' : 'hidden'}><span>原始规则（可后补）</span>${ruleSearchPickerMarkup('ruleBase', selectedBase)}</div><div class="modal-error" id="ruleError" role="alert" aria-live="polite"></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button(editing ? '保存修改' : '保存规则草稿', 'saveRuleButton')}</div>`);
  bindRuleSearchPicker('ruleBase', () => state.rules.filter((item) => !item.isVariant && String(item.id) !== String(rule?.id)));
  document.querySelector('#ruleIsVariant').addEventListener('change', (event) => { document.querySelector('#baseRuleField').hidden = !event.target.checked; });
  document.querySelector('#saveRuleButton').addEventListener('click', async () => {
    const titleZh = document.querySelector('#ruleTitleZh').value.trim(); const titleEn = document.querySelector('#ruleTitleEn').value.trim(); const category = document.querySelector('#ruleCategory').value; const isVariant = document.querySelector('#ruleIsVariant').checked; const baseRuleId = document.querySelector('#ruleBase').value || null; const rulesZh = document.querySelector('#ruleClausesZh').value.split('\n').map((item) => item.trim()).filter(Boolean); const rulesEn = document.querySelector('#ruleClausesEn').value.split('\n').map((item) => item.trim()).filter(Boolean); const exampleUrl = document.querySelector('#ruleExampleUrl').value.trim(); const exampleAuthor = document.querySelector('#ruleExampleAuthor').value.trim();
    const errorNode = document.querySelector('#ruleError');
    if (isVariant && document.querySelector('#ruleBaseSearch').value.trim() && !baseRuleId) { errorNode.textContent = '请从搜索结果选择原始规则，或清空搜索后暂不选择。'; return; }
    if (!category) { errorNode.textContent = '请选择规则分类。'; return; }
    if (!titleZh && !titleEn) { errorNode.textContent = '至少填写中文或英文名称，之后可再补齐另一种语言。'; return; }
    if (exampleAuthor.length > 200) { errorNode.textContent = '例题作者不能超过 200 个字符。'; return; }
    if (exampleUrl.length > 4096) { errorNode.textContent = '例题链接不能超过 4096 个字符。'; return; }
    if (exampleUrl && !isConcretePenpaPuzzleUrl(exampleUrl)) { errorNode.textContent = '例题必须是具体的 Penpa 谜题链接（请勿填写首页或其他谜题平台）。'; return; }
    const payload = { titleZh, titleEn, category, rulesZh, rulesEn, exampleUrl, exampleAuthor, isVariant, baseRuleId, ...(editing ? { expectedRevisions: rule.revisions, expectedEditVersion: rule.editVersion } : {}) };
    const requestEpoch = state.sessionEpoch; const userId = state.user?.id;
    const saveButton = document.querySelector('#saveRuleButton'); saveButton.disabled = true; saveButton.textContent = editing ? '正在保存…' : '正在创建…';
    try {
      const data = await apiRequest(editing ? `/api/rules/${encodeURIComponent(rule.id)}` : '/api/rules', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      if (!isCurrentUserSession(requestEpoch, userId)) return;
      if (Array.isArray(data.rules)) state.rules = data.rules;
      else if (data.rule) state.rules = editing ? state.rules.map((item) => String(item.id) === String(rule.id) ? data.rule : item) : [...state.rules, data.rule];
      else await refreshRules(requestEpoch, userId);
      const savedRule = data.rule || state.rules.find((item) => String(item.id) === String(rule?.id || data.id));
      if (savedRule) applyRuleToCalendarPuzzles(savedRule);
      const changedAuditItems = editing && savedRule?.revisions ? ['name', 'description', 'example'].filter((item) => savedRule.revisions[item] !== rule.revisions?.[item]) : [];
      const saveMessage = !editing ? '规则草稿已创建。' : changedAuditItems.length ? `已保存；${changedAuditItems.map((item) => auditLabels[item]).join('、')}审核重新开始，其他项进度保留。` : '已保存；审核进度保持不变。';
      const editorStillOpen = errorNode.isConnected;
      if (editorStillOpen) closeModal();
      if (fromSubmission && editorStillOpen) openAddPuzzle(state.submissionDraft?.scope || 'calendar', { ...(state.submissionDraft?.draft || draft || {}), ruleId: savedRule?.id || '' });
      else { renderRoute(); if (editorStillOpen) showToast(saveMessage); }
      state.submissionDraft = null;
    } catch (error) {
      if (!isCurrentUserSession(requestEpoch, userId)) return;
      if (error.status === 409) { if (errorNode.isConnected) closeModal(); try { await refreshRules(requestEpoch, userId); } catch { if (!isCurrentUserSession(requestEpoch, userId)) return; showToast('这条规则版本已更新，但刷新目录失败；请稍后重试。'); return; } if (!isCurrentUserSession(requestEpoch, userId)) return; renderRoute(); showToast('这条规则已被其他成员修改，目录已刷新；请基于最新版本重新编辑。'); return; }
      if (errorNode.isConnected) errorNode.textContent = error.message;
      if (errorNode.isConnected) { saveButton.disabled = false; saveButton.textContent = editing ? '保存修改' : '保存规则草稿'; }
    }
  });
}
async function refreshRules(epoch = state.sessionEpoch, userId = state.user?.id) { const data = await apiRequest('/api/rules'); if (!isCurrentUserSession(epoch, userId)) return false; state.rules = data.rules || []; state.rulesStatus = 'loaded'; state.rulesError = ''; return true; }
function bindRuleCatalog(root = document) {
  bindQualityIgnores(root);
  root.querySelectorAll('[data-rule-edit]').forEach((button) => button.addEventListener('click', () => {
    const rule = state.rules.find((item) => String(item.id) === String(button.dataset.ruleEdit));
    if (rule) openRuleEditor({ rule });
  }));
  root.querySelectorAll('[data-rule-delete]').forEach((button) => button.addEventListener('click', () => {
    openDeleteRuleConfirmation({ id: button.dataset.ruleDelete, deleteToken: button.dataset.deleteToken, editVersion: Number(button.dataset.editVersion), title: button.dataset.ruleTitle });
  }));
  root.querySelectorAll('[data-rule-filter]').forEach((button) => button.addEventListener('click', () => { state.ruleFilter = button.dataset.ruleFilter; renderRoute(); }));
  const search = root.querySelector('#ruleSearch');
  search?.addEventListener('input', () => {
    const start = search.selectionStart; const end = search.selectionEnd;
    state.ruleQuery = search.value;
    renderRoute();
    const next = root.querySelector('#ruleSearch'); next?.focus(); next?.setSelectionRange(start, end);
  });
  root.querySelectorAll('[data-rule-audit]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.ruleAudit === 'approve') submitRuleAudit(button.dataset.ruleId, button.dataset.auditItem, 'approve');
    else openAuditReject(button.dataset.ruleId, button.dataset.auditItem);
  }));
}
function openDeleteRuleConfirmation(target) {
  const title = target.title || '未命名规则';
  openModal(`<p class="modal-eyebrow">RULE CATALOG</p><h2 id="modalTitle">删除规则</h2><p class="modal-intro">确认删除规则「${esc(title)}」？此操作无法撤销，并会一并删除这条规则的审核记录。若谜题或其他规则仍在引用它，目录会保留规则并显示原因。</p><div class="modal-error" id="deleteRuleError" role="alert" aria-live="polite"></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button('确认删除规则', 'confirmDeleteRuleButton', 'button button-danger')}</div>`);
  const errorNode = document.querySelector('#deleteRuleError');
  const confirmButton = document.querySelector('#confirmDeleteRuleButton');
  confirmButton.addEventListener('click', async () => {
    if (confirmButton.disabled) return;
    const requestEpoch = state.sessionEpoch;
    const userId = state.user?.id;
    confirmButton.disabled = true;
    confirmButton.textContent = '正在删除…';
    try {
      const data = await apiRequest(`/api/rules/${encodeURIComponent(target.id)}`, { method: 'DELETE', body: JSON.stringify({ deleteToken: target.deleteToken, expectedEditVersion: target.editVersion }) });
      if (!isCurrentUserSession(requestEpoch, userId)) return;
      if (Array.isArray(data.rules)) state.rules = data.rules;
      else await refreshRules(requestEpoch, userId);
      if (!isCurrentUserSession(requestEpoch, userId)) return;
      const confirmationStillOpen = errorNode.isConnected;
      if (confirmationStillOpen) closeModal();
      renderRoute();
      if (confirmationStillOpen) showToast(`规则「${title}」已删除`);
    } catch (error) {
      if (!isCurrentUserSession(requestEpoch, userId) || !errorNode.isConnected) return;
      errorNode.textContent = error.message || '规则删除失败，请稍后重试。';
      confirmButton.disabled = error.status === 409;
      confirmButton.textContent = error.status === 409 ? '无法删除' : '确认删除规则';
    }
  });
}
function openAuditReject(ruleId, item) {
  const rule = state.rules.find((entry) => String(entry.id) === String(ruleId)); if (!rule) return;
  openModal(`<p class="modal-eyebrow">RULE AUDIT · ${auditLabels[item]}</p><h2 id="modalTitle">打回并提供建议</h2><p class="modal-intro">打回后，这个审核项需要实际修改内容才能重新开始审核。建议可以留空；现有批准也会保留在历史记录中。</p><label class="form-field"><span>审计建议（可选）</span><textarea id="auditSuggestion" rows="4" maxlength="500" placeholder="指出建议补充或修改的内容"></textarea></label><div class="modal-error" id="auditError" role="alert" aria-live="polite"></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button('确认打回', 'confirmAuditReject')}</div>`);
  document.querySelector('#confirmAuditReject').addEventListener('click', () => submitRuleAudit(ruleId, item, 'reject', document.querySelector('#auditSuggestion').value.trim(), document.querySelector('#auditError')));
}
function updateAuditedRule(rule) {
  applyRuleToCalendarPuzzles(rule);
  state.rules = state.rules.map((entry) => String(entry.id) === String(rule.id) ? rule : entry);
  const card = document.querySelector(`[data-rule-card="${rule.id}"]`);
  if (!card) return;
  if (!ruleMatchesRuleFilter(rule, state.ruleFilter)) card.remove();
  else {
    const openHistories = [...card.querySelectorAll('.audit-history')].map((details) => details.open);
    card.outerHTML = renderRuleCard(rule, state.rules);
    const replacement = document.querySelector(`[data-rule-card="${rule.id}"]`);
    replacement.querySelectorAll('.audit-history').forEach((details, index) => { details.open = Boolean(openHistories[index]); });
    bindRuleCatalog(replacement);
  }
  const rules = state.rules;
  const values = [rules.length, rules.filter((entry) => (entry.quality?.errors?.filter((error)=>!error.ignored).length || 0) + (entry.quality?.warnings?.length || 0) > 0).length,
    rules.reduce((sum, entry) => sum + (entry.quality?.errors?.filter((error)=>!error.ignored).length || 0), 0), rules.reduce((sum, entry) => sum + (entry.quality?.warnings?.length || 0), 0)];
  document.querySelectorAll('.rule-quality-summary strong').forEach((node, index) => { node.textContent = values[index]; });
  const catalog = document.querySelector('.rule-catalog');
  if (catalog && !catalog.querySelector('[data-rule-card]')) catalog.innerHTML = '<div class="empty-state">没有符合筛选条件的规则。</div>';
}
async function submitRuleAudit(ruleId, item, decision, suggestion = '', errorNode = null) {
  const rule = state.rules.find((entry) => String(entry.id) === String(ruleId)); if (!rule) return;
  const requestEpoch = state.sessionEpoch; const userId = state.user?.id; const revision = rule.revisions?.[item];
  const key = `${requestEpoch}:${ruleId}`;
  if (state.auditPending.has(key)) return;
  state.auditPending.add(key);
  const controls = [...document.querySelectorAll(`[data-rule-card="${ruleId}"] [data-rule-audit]`), ...document.querySelectorAll('#confirmAuditReject')];
  const original = controls.map((control) => ({control, disabled: control.disabled, text: control.textContent}));
  controls.forEach((control) => { control.disabled = true; });
  const active = decision === 'reject' ? document.querySelector('#confirmAuditReject') : controls.find((control) => control.dataset.auditItem === item && control.dataset.ruleAudit === decision);
  if (active) active.textContent = '正在提交…';
  try {
    const data = await apiRequest(`/api/rules/${encodeURIComponent(ruleId)}/audits`, { method: 'POST', body: JSON.stringify({ item, decision, ...(decision === 'reject' ? { suggestion } : {}), revision }) });
    if (!isCurrentUserSession(requestEpoch, userId)) return;
    if (decision === 'reject' && errorNode?.isConnected) closeModal();
    updateAuditedRule(data.rule);
    showToast(decision === 'approve' ? '审核通过已记录。' : '打回建议已记录；本项内容需实际修改后才能重新审核。');
  } catch (error) {
    if (!isCurrentUserSession(requestEpoch, userId)) return;
    if (error.status === 409) {
      try {
        const data = await apiRequest(`/api/rules/${encodeURIComponent(ruleId)}`);
        if (!isCurrentUserSession(requestEpoch, userId)) return;
        if (decision === 'reject' && errorNode?.isConnected) closeModal();
        updateAuditedRule(data.rule);
        showToast('审核内容已更新，已刷新当前版本；请核对后重新操作。');
      } catch { if (isCurrentUserSession(requestEpoch, userId)) showToast('刷新规则失败，请稍后重试。'); }
    } else if (errorNode?.isConnected) errorNode.textContent = error.message;
    else showToast(error.message);
  } finally {
    state.auditPending.delete(key);
    original.forEach(({control, disabled, text}) => { if (control.isConnected) { control.disabled = disabled; control.textContent = text; } });
  }
}
function bindPenpaKeyboard() {
  const iframe = document.querySelector('#puzzleEmbed iframe[data-penpa-keyboard]');
  if (!iframe) return;
  const focusSolver = (automatic = false) => {
    if (!iframe.isConnected || !modalBackdrop.hidden) return;
    if (automatic && !document.hasFocus()) return;
    // Penpa cancels canvas mousedown, so the browser may keep focus outside its frame.
    iframe.focus({ preventScroll: true });
    iframe.contentWindow?.focus();
  };
  document.querySelector('#enablePenpaKeyboardButton')?.addEventListener('click', () => focusSolver());
  iframe.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'mouse') focusSolver(true);
  });
}
function bindPuzzleReviewActions(number, scope, puzzle) {
  document.querySelector('#completePuzzleButton')?.addEventListener('click', () => openRating(number, scope));
  document.querySelector('#reenterCalendarPuzzleButton')?.addEventListener('click', () => puzzle && openCalendarReentry(puzzle));
}
function updateCalendarReviewPage(puzzle) {
  const route = getRoute();
  if (route.name !== 'calendar-puzzle' || Number(route.number) !== Number(puzzle.number)) { renderRoute(); return; }
  const template = document.createElement('template');
  template.innerHTML = renderPuzzlePage(puzzle.number, 'calendar');
  for (const selector of ['.calendar-review-panel', '.record-panel', '.calendar-workflow-panel']) {
    const previous = document.querySelector(selector);
    const replacement = template.content.querySelector(selector);
    if (previous && replacement) previous.replaceWith(replacement);
  }
  bindPuzzleReviewActions(puzzle.number, 'calendar', puzzle);
  bindCalendarWorkflow(puzzle);
  const panel = document.querySelector('.calendar-review-panel');
  if (panel) bindDifficultySpoilers(panel);
  const reveal = document.querySelector('#revealCommentsButton');
  if (puzzle.completed && reveal && !reveal.hidden) reveal.click();
}
function applyCalendarPuzzle(puzzle) {
  const normalized = normalizePuzzle(puzzle);
  state.calendarPuzzles = state.calendarPuzzles.filter((entry) => Number(entry.number) !== Number(puzzle.number));
  state.calendarLeftovers = state.calendarLeftovers.filter((entry) => Number(entry.number) !== Number(puzzle.number));
  (puzzle.calendarStatus === 'leftover' ? state.calendarLeftovers : state.calendarPuzzles).push(normalized);
}
function openSharedPenpaEditor(puzzle) {
  if (!puzzle || calendarAreaOf(puzzle)!=='allocation') return;
  openModal(`<p class="modal-eyebrow">CALENDAR PUZZLE · #${puzzle.number}</p><h2 id="modalTitle">共同补充 Penpa 链接</h2><p class="modal-intro">待分配区的题目可由任意登录成员补充或修改两种 Penpa 链接。链接改变后，制图审计将重新开始；做题评价与日期分配保留。</p><label class="form-field"><span>Penpa 编辑链接</span><input id="sharedPenpaEdit" type="url" maxlength="4096" value="${esc(puzzle.penpaEditUrl)}" placeholder="https://penpa-edit.com/?m=edit&p=…" /></label><label class="form-field"><span>Penpa 解题链接</span><input id="sharedPenpaSolve" type="url" maxlength="4096" value="${esc(puzzle.penpaSolveUrl)}" placeholder="https://penpa-edit.com/?m=solve&p=…" /></label>${renderPenpaGuidelines()}<div class="modal-error" id="sharedPenpaError" role="alert" aria-live="polite"></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button('保存 Penpa 链接','saveSharedPenpaButton')}</div>`);
  const errorNode=document.querySelector('#sharedPenpaError');
  const save=document.querySelector('#saveSharedPenpaButton');
  save.addEventListener('click',async()=>{
    if (save.disabled) return;
    const input={penpaEditUrl:document.querySelector('#sharedPenpaEdit').value.trim(),penpaSolveUrl:document.querySelector('#sharedPenpaSolve').value.trim(),expectedEditVersion:puzzle.editVersion,expectedReviewRound:puzzle.reviewRound};
    const links=normalizeCalendarLinks({...input,inputMode:puzzle.inputMode},puzzle);
    if (links.error) { errorNode.textContent=links.error;return; }
    const epoch=state.sessionEpoch; const userId=state.user?.id;
    save.disabled=true;errorNode.textContent='';
    try {
      const data=await apiRequest(`/api/calendar/puzzles/${puzzle.number}/penpa-links`,{method:'PATCH',body:JSON.stringify(input)});
      if (!isCurrentUserSession(epoch,userId)) return;
      applyCalendarPuzzle(data.puzzle);
      if (errorNode.isConnected) closeModal();
      const frame=document.querySelector('#puzzleEmbed');
      if (frame&&data.puzzle.inputMode==='external'&&data.puzzle.url!==puzzle.url) {
        frame.innerHTML=renderEmbed(data.puzzle);
        bindPenpaKeyboard();
      }
      updateCalendarReviewPage(data.puzzle);
      showToast('Penpa 链接已保存；链接改变后需重新制图审计。');
    } catch(error) {
      if (isCurrentUserSession(epoch,userId)&&errorNode.isConnected) errorNode.textContent=error.status===409?'题目已更新或已离开待分配区，请关闭窗口并刷新后重试。':error.message;
    } finally { if (save.isConnected) save.disabled=false; }
  });
}
function openUsernameEditor() {
  if (!state.user || state.usernameRenamePending) return;
  if (state.inboxPendingIds.size || state.inboxReadAllPending) { showToast('请等待消息保存完成后再修改用户名。'); return; }
  const expectedUsername=state.user.username;
  openModal(`<p class="modal-eyebrow">MEMBER ACCOUNT</p><h2 id="modalTitle">修改用户名</h2><p class="modal-intro">修改后使用新用户名和原密码登录。账号、题目、评价、完成记录及当前登录会话保持不变。</p><label class="form-field"><span>新用户名</span><input id="newUsername" type="text" maxlength="64" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(expectedUsername)}" /></label><p class="form-help">2–32 个字符，可使用字母、数字、下划线和连字符。用户名不区分大小写且不能与其他成员重复。</p><div class="modal-error" id="usernameEditError" role="alert" aria-live="polite"></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button('保存用户名','saveUsernameButton')}</div>`);
  const errorNode=document.querySelector('#usernameEditError'); const save=document.querySelector('#saveUsernameButton');
  save.addEventListener('click',async()=>{
    if (save.disabled || state.usernameRenamePending) return;
    if (state.inboxPendingIds.size || state.inboxReadAllPending) { errorNode.textContent='请等待消息保存完成后再修改用户名。'; return; }
    const normalized=normalizeUsername(document.querySelector('#newUsername').value.trim());
    if (!normalized) { errorNode.textContent='用户名需为 2–32 个字符，可使用字母、数字、下划线和连字符。';return; }
    const epoch=state.sessionEpoch; const userId=state.user.id;
    let renameEpoch=epoch;
    save.disabled=true;state.usernameRenamePending=true;errorNode.textContent='';renderRoute();
    try {
      const data=await apiRequest('/api/account/username',{method:'PATCH',body:JSON.stringify({username:normalized.username,expectedUsername})});
      if (!isCurrentUserSession(epoch,userId)) return;
      state.sessionEpoch+=1;state.user=data.user;invalidateRules();
      renameEpoch=state.sessionEpoch;
      inboxLoadAttempt += 1; inboxLoadController?.abort(); inboxLoadController = null;
      state.inboxLoading = false; state.inboxError = ''; state.inboxActionError = '';
      if (errorNode.isConnected) closeModal();
      await loadPrivateData();
      showToast('用户名已修改，之后请使用新用户名登录。');
    } catch(error) {
      if (isCurrentUserSession(epoch,userId)&&errorNode.isConnected) errorNode.textContent=error.message;
    } finally {
      if (save.isConnected) save.disabled=false;
      if (isCurrentUserSession(renameEpoch,userId)) { state.usernameRenamePending=false;renderRoute(); }
    }
  });
}
function openCalendarPuzzleEditor(puzzle) {
  if (!puzzle) return;
  openModal(`<p class="modal-eyebrow">CALENDAR PUZZLE · #${puzzle.number}</p><h2 id="modalTitle">编辑题目</h2><label class="form-field"><span>题目名称</span><input id="editPuzzleTitle" type="text" maxlength="200" value="${esc(puzzle.title)}" /></label>${calendarLinkFields('editPuzzle',puzzle)}<label class="variant-toggle"><input id="clearPuzzleReviews" type="checkbox" /> 清除过去的做题评价</label><p class="form-help">默认保留评价。勾选后会清除所有轮次的难度、标签和喜爱评分与否决，并开启新一轮审核；完成记录和留言保留。</p><div class="modal-error" id="editPuzzleError" role="alert" aria-live="polite"></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button('保存修改', 'savePuzzleEditButton')}</div>`);
  const errorNode = document.querySelector('#editPuzzleError');
  const saveButton = document.querySelector('#savePuzzleEditButton');
  saveButton.addEventListener('click', async () => {
    if (saveButton.disabled) return;
    const title = document.querySelector('#editPuzzleTitle').value.trim();
    const links = readCalendarLinks('editPuzzle',puzzle.inputMode);
    const url = links.value?.url || '';
    const clearReviews = document.querySelector('#clearPuzzleReviews').checked;
    if (!title) { errorNode.textContent = '请填写题目名称。'; return; }
    if (links.error) { errorNode.textContent = links.error; return; }
    if (puzzle.inputMode === 'external' && !isSupportedPuzzleUrl(url)) { errorNode.textContent = '请填写受支持的题目工具链接。'; return; }
    const epoch = state.sessionEpoch; const userId = state.user?.id;
    errorNode.textContent = ''; saveButton.disabled = true; saveButton.textContent = '正在保存…';
    try {
      const data = await apiRequest(`/api/calendar/puzzles/${puzzle.number}`, { method: 'PATCH', body: JSON.stringify({ title, ...links.value, clearReviews, expectedEditVersion: puzzle.editVersion, expectedReviewRound: puzzle.reviewRound }) });
      if (!isCurrentUserSession(epoch, userId)) return;
      applyCalendarPuzzle(data.puzzle);
      if (errorNode.isConnected) closeModal();
      renderRoute(); showToast(clearReviews ? '题目已更新，旧评价已清除，可以重新评价。' : '题目已更新，原有评价已保留。');
    } catch (error) {
      if (!isCurrentUserSession(epoch, userId)) return;
      if (errorNode.isConnected) errorNode.textContent = error.status === 409 ? '题目已更新，请关闭窗口并刷新后重新编辑。' : error.message;
    } finally {
      if (saveButton.isConnected) { saveButton.disabled = false; saveButton.textContent = '保存修改'; }
    }
  });
}
function renderCalendarComments(puzzle) {
  return `<section class="calendar-comments" aria-labelledby="calendarCommentsTitle"><h2 id="calendarCommentsTitle">题目留言</h2><p class="muted">留言可能包含解题思路；完成题目后自动显示，未完成时需主动展开。</p>${puzzle.completed ? '' : '<button type="button" class="button button-light" id="revealCommentsButton" aria-expanded="false" aria-controls="calendarCommentsList">剧透 · 点击查看留言</button>'}<div id="calendarCommentsList" ${puzzle.completed ? '' : 'hidden'} aria-live="polite"></div><form id="calendarCommentForm"><label class="form-field"><span>留言内容</span><textarea id="calendarCommentBody" rows="3" maxlength="2000" required placeholder="写下你的想法；任何评分或否决后均可留言"></textarea></label><div class="modal-error" id="calendarCommentError" role="alert" aria-live="polite"></div><button type="submit" class="button button-dark" id="sendCalendarCommentButton">发送留言</button></form></section>`;
}
function bindCalendarComments(puzzle) {
  const list = document.querySelector('#calendarCommentsList');
  const revealButton = document.querySelector('#revealCommentsButton');
  const form = document.querySelector('#calendarCommentForm');
  const input = document.querySelector('#calendarCommentBody');
  const sendButton = document.querySelector('#sendCalendarCommentButton');
  const errorNode = document.querySelector('#calendarCommentError');
  const epoch = state.sessionEpoch; const userId = state.user?.id;
  let revealed = puzzle.completed;
  let loadVersion = 0;
  const loadComments = async () => {
    if (!revealed || !list.isConnected) return;
    const version = ++loadVersion; list.hidden = false; list.textContent = '正在加载留言…';
    if (revealButton) { revealButton.disabled = true; revealButton.setAttribute('aria-expanded', 'true'); }
    try {
      const data = await apiRequest(`/api/calendar/puzzles/${puzzle.number}/comments${puzzle.completed ? '' : '?reveal=1'}`);
      if (!isCurrentUserSession(epoch, userId) || !list.isConnected || version !== loadVersion) return;
      list.innerHTML = data.comments.length ? `<ol class="calendar-comment-list">${data.comments.map((comment) => `<li><div><strong>${esc(comment.username || comment.name || '成员')}</strong><time>${esc(comment.createdAt)}</time></div><p>${esc(comment.body)}</p></li>`).join('')}</ol>` : '<p class="muted">还没有留言。</p>';
      if (revealButton?.isConnected) revealButton.hidden = true;
    } catch (error) {
      if (isCurrentUserSession(epoch, userId) && list.isConnected && version === loadVersion) {
        list.innerHTML = '<p role="alert">留言加载失败，请重试。</p><button type="button" class="button button-light" id="retryCalendarComments">重试</button>';
        list.querySelector('#retryCalendarComments').addEventListener('click', loadComments);
      }
    } finally { if (version === loadVersion && revealButton?.isConnected) revealButton.disabled = false; }
  };
  revealButton?.addEventListener('click', () => { revealed = true; void loadComments(); });
  if (revealed) void loadComments();
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (sendButton.disabled) return;
    const draft = input.value; const body = draft.trim();
    if (!body) { errorNode.textContent = '请填写留言。'; return; }
    errorNode.textContent = ''; sendButton.disabled = true; sendButton.textContent = '正在发送…';
    try {
      await apiRequest(`/api/calendar/puzzles/${puzzle.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
      if (!isCurrentUserSession(epoch, userId) || !form.isConnected) return;
      if (input.value === draft) input.value = '';
      showToast('留言已保存。');
      await loadComments();
    } catch (error) { if (isCurrentUserSession(epoch, userId) && errorNode.isConnected) errorNode.textContent = error.message; }
    finally { if (sendButton.isConnected) { sendButton.disabled = false; sendButton.textContent = '发送留言'; } }
  });
}
function bindPuzzle(number, scope = 'library') {
  const isCalendar = scope === 'calendar'; const puzzle = (isCalendar ? [...state.calendarPuzzles, ...state.calendarLeftovers] : state.puzzles).find((item) => Number(item.number) === Number(number));
  bindPenpaKeyboard();
  if (isCalendar && puzzle) { bindCalendarDateInputs('suggestedDateEdit'); bindCalendarComments(puzzle); bindCalendarWorkflow(puzzle); }
  document.querySelector('#editCalendarPuzzleButton')?.addEventListener('click', () => openCalendarPuzzleEditor([...state.calendarPuzzles,...state.calendarLeftovers].find((entry)=>Number(entry.number)===Number(number))));
  bindPuzzleReviewActions(number, scope, puzzle);
  document.querySelector('#addTagButton')?.addEventListener('click', () => openTagEditor(number));
  document.querySelector('#deleteCalendarPuzzleButton')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    openDeleteCalendarPuzzleConfirmation({ number: button.dataset.puzzleNumber, deleteToken: button.dataset.deleteToken, title: button.dataset.puzzleTitle, returnRoute: button.dataset.returnRoute });
  });
  document.querySelector('#saveSuggestedDateButton')?.addEventListener('click', async () => { const fields = readCalendarDateFields('suggestedDateEdit'); if (fields.error) { showToast(fields.error); return; } const requestEpoch = state.sessionEpoch; const userId = state.user?.id; try { const data = await apiRequest(`/api/calendar/puzzles/${number}`, { method: 'PATCH', body: JSON.stringify(fields) }); if (!isCurrentUserSession(requestEpoch, userId)) return; applyCalendarPuzzle(data.puzzle); renderRoute(); showToast('建议日期已保存'); } catch (error) { if (isCurrentUserSession(requestEpoch, userId)) showToast(error.message); } });
  if (puzzle) bindBlank(puzzle);
  document.querySelector('#commentButton')?.addEventListener('click', () => showToast('留言功能将在账户系统接入后启用'));
}
function openDeleteCalendarPuzzleConfirmation(target) {
  const title = target.title || '未命名谜题';
  openModal(`<p class="modal-eyebrow">PRIVATE PUZZLE CALENDAR</p><h2 id="modalTitle">删除日历谜题</h2><p class="modal-intro">确认删除投稿「${esc(title)}」？这会同时删除这道谜题的评分、完成记录和标签，且无法撤销。</p><div class="modal-error" id="deleteCalendarPuzzleError" role="alert" aria-live="polite"></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button('确认删除谜题', 'confirmDeleteCalendarPuzzleButton', 'button button-danger')}</div>`);
  const errorNode = document.querySelector('#deleteCalendarPuzzleError');
  const confirmButton = document.querySelector('#confirmDeleteCalendarPuzzleButton');
  confirmButton.addEventListener('click', async () => {
    if (confirmButton.disabled) return;
    const requestEpoch = state.sessionEpoch;
    const userId = state.user?.id;
    confirmButton.disabled = true;
    confirmButton.textContent = '正在删除…';
    try {
      const data = await apiRequest(`/api/calendar/puzzles/${encodeURIComponent(target.number)}`, { method: 'DELETE', body: JSON.stringify({ deleteToken: target.deleteToken }) });
      if (!isCurrentUserSession(requestEpoch, userId)) return;
      if (Array.isArray(data.puzzles)) state.calendarPuzzles = data.puzzles.map(normalizePuzzle);
      await refreshCalendarData(requestEpoch, userId);
      if (!isCurrentUserSession(requestEpoch, userId)) return;
      state.calendarReturnRoute = ['pending', 'leftovers', 'allocation', 'finished'].includes(target.returnRoute) ? target.returnRoute : 'calendar';
      const confirmationStillOpen = errorNode.isConnected;
      if (confirmationStillOpen) closeModal();
      window.location.hash = `#${state.calendarReturnRoute}`;
      if (confirmationStillOpen) showToast(`谜题「${title}」已删除`);
    } catch (error) {
      if (!isCurrentUserSession(requestEpoch, userId) || !errorNode.isConnected) return;
      errorNode.textContent = error.message || '谜题删除失败，请稍后重试。';
      confirmButton.disabled = error.status === 409;
      confirmButton.textContent = error.status === 409 ? '无法删除' : '确认删除谜题';
    }
  });
}
function openTagEditor(number) { openModal(`<p class="modal-eyebrow">PUZZLE TAGS</p><h2 id="modalTitle">添加标签</h2><p class="modal-intro">标签用于题库筛选；题型标签和 Wrong Puzzle、Example Puzzle 等状态标签可以同时存在。</p><label class="form-field"><span>标签名称</span><input id="newTagName" type="text" placeholder="例如：Sudoku" /></label><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button('保存标签', 'saveTagButton')}</div>`); document.querySelector('#saveTagButton').addEventListener('click', async () => { const tag = document.querySelector('#newTagName').value.trim(); if (!tag) { showToast('请填写标签名称'); return; } const requestEpoch = state.sessionEpoch; const userId = state.user?.id; try { const data = await apiRequest(`/api/puzzles/${number}/tags`, { method: 'POST', body: JSON.stringify({ tag }) }); applyPuzzleData(data.puzzles); closeModal(); renderRoute(); showToast('标签已保存'); } catch (error) { if (isCurrentUserSession(requestEpoch, userId)) showToast(error.message); } }); }
function bindBlank(puzzle) { document.querySelector('#checkBlankButton')?.addEventListener('click', () => { const answer = document.querySelector('#blankAnswer').value.trim().toLowerCase(); const expected = String(puzzle.answer || '').toLowerCase(); const result = document.querySelector('#blankResult'); if (!answer) { result.textContent = '请填写答案。'; result.className = 'blank-result error'; } else if (expected && answer === expected) { result.textContent = '答案正确，可以提交完成记录。'; result.className = 'blank-result success'; } else { result.textContent = expected ? '还不正确，再试一次。' : '答案已记录，点击完成后进行评分。'; result.className = 'blank-result'; } }); }
function bindCalendar(routeName = 'calendar') { const origin = routeName; document.querySelector('#calendarMonth')?.addEventListener('change',(event)=>{state.calendarMonth=Number(event.target.value);renderRoute();}); document.querySelector('#calendarViewYear')?.addEventListener('change',(event)=>{const year=Number(event.target.value);if(Number.isInteger(year)&&year>=1000&&year<=9999){state.calendarViewYear=year;renderRoute();}}); document.querySelectorAll('[data-month-puzzle]').forEach((link)=>link.addEventListener('click',()=>{state.calendarReturnRoute='finished';})); const openSubmission = () => { state.calendarReturnRoute = origin; openAddPuzzle('calendar'); }; document.querySelector('#addCalendarPuzzleButton')?.addEventListener('click', openSubmission); document.querySelector('#emptyCalendarAdd')?.addEventListener('click', openSubmission); document.querySelector('#calendarSort')?.addEventListener('change', (event) => { state.calendarSort = event.target.value; renderRoute(); }); document.querySelectorAll('.calendar-row').forEach((row) => row.addEventListener('click', (event) => { if (event.defaultPrevented || event.target.closest('button')) return; state.calendarReturnRoute = origin; if (!event.target.closest('a')) window.location.hash = `#${row.dataset.puzzleRoute}`; })); }
function bindLeftovers() { document.querySelectorAll('.calendar-row').forEach((row) => row.addEventListener('click', (event) => { if (event.defaultPrevented || event.target.closest('button')) return; state.calendarReturnRoute = 'leftovers'; if (!event.target.closest('a')) window.location.hash = `#${row.dataset.puzzleRoute}`; })); }

function renderHome() { return `<div class="page-wrap-inner home-page"><section class="workspace-header"><div><p class="eyebrow"><span class="eyebrow-line"></span>PUZZLE ARCHIVE</p><h1>工作台<span class="heading-period">.</span></h1><p class="page-description">从公告开始，进入题库、题集和索引。</p></div></section><section class="home-notice-board"><div class="notice-strip" aria-label="公告"><div class="notice-symbol">✦</div><div class="notice-copy"><span class="notice-kicker">公告 · OCT 2026</span><strong>秋季谜题交换开始了</strong><span>提交你的原创题目，和朋友交换一场解题。</span></div><button class="text-button" type="button" id="noticeButton">查看公告 <span>→</span></button></div><div class="notice-strip notice-strip-secondary"><div class="notice-symbol">◎</div><div class="notice-copy"><span class="notice-kicker">最近更新 · OCT 2026</span><strong>题库持续更新</strong><span>探索公开题库，或进入受信任成员的日历与规则目录。</span></div><a class="text-button" href="#library">进入题库 <span>→</span></a></div></section><section class="home-links"><a href="#library" class="home-link-card"><span class="home-link-icon">▤</span><span><small>EXPLORE</small><strong>题库</strong><em>${state.puzzles.length} 道题目 →</em></span></a><a href="#collections" class="home-link-card"><span class="home-link-icon">▥</span><span><small>CURATED</small><strong>题集列表</strong><em>${state.collections.length} 个题集 →</em></span></a><a href="#files" class="home-link-card"><span class="home-link-icon">⌘</span><span><small>ORGANIZE</small><strong>索引与文件</strong><em>按来源与年份浏览 →</em></span></a><a href="#calendar" class="home-link-card"><span class="home-link-icon">▦</span><span><small>TRUSTED SPACE</small><strong>谜题日历</strong><em>${state.calendarPuzzles.length} 道日历谜题 →</em></span></a><a href="#rules" class="home-link-card"><span class="home-link-icon">≡</span><span><small>CATALOG</small><strong>规则管理</strong><em>${state.rules.length} 条规则 →</em></span></a></section></div>`; }

function renderCollections() { const collections = state.collections; return `<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span>CURATED SETS</p><h1>题集列表<span class="heading-period">.</span></h1><p class="page-description">按主题、比赛和编辑精选浏览一组题目。</p></div>${button('<span class="button-plus">+</span>新建题集', 'newCollectionButton')}</section><section class="collection-directory collection-directory-first"><div class="section-heading compact"><div class="section-title-group"><h2>全部题集</h2><span class="count-badge">${String(collections.length).padStart(2, '0')}</span></div><span class="mono muted">DATABASE COLLECTIONS</span></div><div class="collection-list">${collections.length ? collections.map((collection) => `<a class="collection-row collection-row-large" href="#collection-${collection.id}"><span class="collection-cover ${collection.id % 2 ? 'cover-green' : 'cover-red'}">${collection.id % 2 ? 'N°' : 'PB'}<span>${collection.year || 'SET'}</span></span><span class="collection-info"><strong>${esc(collection.name)}</strong><small>${Number(collection.puzzle_count || 0)} puzzles · ${collection.year || '未定年份'} · ${esc(collection.source || '未注明来源')}</small><em>${esc(collection.description || '')}</em></span><span class="collection-arrow">↗</span></a>`).join('') : '<div class="empty-state">还没有题集。</div>'}</div></section></div>`; }

function renderCollectionPage(id) { const collection = state.currentCollection && Number(state.currentCollection.id) === Number(id) ? state.currentCollection : state.collections.find((item) => Number(item.id) === Number(id)); if (!collection) return `<div class="page-wrap-inner"><div class="empty-state">正在加载题集……</div></div>`; const puzzles = collection.puzzles || []; return `<div class="page-wrap-inner collection-page"><a class="back-link" href="#collections">← 返回题集列表</a><section class="collection-detail-header"><div><p class="eyebrow"><span class="eyebrow-line"></span>COLLECTION · ${collection.year || '—'}</p><h1>${esc(collection.name)}<span class="heading-period">.</span></h1><p class="page-description">${esc(collection.description || '')}</p><p class="collection-detail-meta">${esc(collection.source || '未注明来源')}　·　${puzzles.length} 道题目</p></div><span class="collection-detail-mark">${collection.year ? String(collection.year).slice(-2) : 'SET'}</span></section><section class="collection-detail-grid"><div><div class="section-heading compact"><div class="section-title-group"><h2>题目</h2><span class="count-badge">${String(puzzles.length).padStart(2, '0')}</span></div><span class="mono muted">ORDERED BY COLLECTION</span></div><div class="collection-puzzle-list">${puzzles.map((puzzle, index) => `<a class="collection-puzzle-row" href="#puzzle-${puzzle.number}"><span class="collection-puzzle-number">${String(index + 1).padStart(2, '0')}</span><span><strong>${esc(puzzle.title)}</strong><small>${esc(puzzle.type)} · ${esc(puzzle.author)}</small></span><span class="collection-puzzle-status">${puzzle.completed ? '✓ 已完成' : '未完成'}　→</span></a>`).join('') || '<div class="empty-state">题集暂时没有题目。</div>'}</div></div><aside class="collection-materials"><span class="materials-kicker">REFERENCE MATERIALS</span><h2>资料</h2>${[['IB', collection.ib], ['PB', collection.pb], ['SB', collection.sb]].map(([label, value]) => `<div class="material-row"><span>${label}</span><strong>${esc(value || '尚未添加')}</strong><button type="button" title="打开资料">↗</button>`).join('')}</aside></section></div>`; }

async function loadCollection(id) { if (!state.api) return; try { const data = await apiRequest(`/api/collections/${id}`); state.currentCollection = data.collection; renderRoute(); } catch (error) { showToast(error.message); } }
function bindCollectionList() { document.querySelector('#newCollectionButton')?.addEventListener('click', () => showToast('题集创建表单将在下一阶段接入')); document.querySelectorAll('a[href^="#collection-"]').forEach((link) => link.addEventListener('click', () => { const id = Number(link.getAttribute('href').split('-')[1]); state.currentCollection = null; loadCollection(id); })); }
function renderAuthGate() {
  if (!state.sessionChecked) return '<section class="auth-gate" role="status">正在确认登录状态…</section>';
  if (state.serviceError && !state.user) return `<section class="auth-gate" role="alert"><p class="eyebrow">SERVICE STATUS</p><h1>服务暂不可用</h1><p>${esc(state.serviceError)}</p><button class="button button-dark" type="button" id="retrySessionButton">重试</button></section>`;
  const registering = state.authMode === 'register';
  const busy = state.authBusy || state.logoutPending;
  const authStatus = state.logoutPending ? '正在安全退出…' : state.authError;
  return `<section class="auth-gate auth-page"><div class="auth-brand"><span class="brand-mark">PA</span><span><strong>PuzArchive</strong><small>private puzzle archive</small></span></div><p class="eyebrow">TRUSTED MEMBERS</p><h1>${registering ? '创建成员账号' : '欢迎回来'}<span class="heading-period">.</span></h1><p>${registering ? '同一个邀请码可重复注册不同账号，不会被消耗。这里仅使用用户名和密码。' : '登录后继续浏览成员共同投稿的谜题日历。'}</p><div class="auth-switch" role="group" aria-label="账号操作"><button type="button" data-auth-mode="login" aria-pressed="${!registering}" ${busy ? 'disabled' : ''}>登录</button><button type="button" data-auth-mode="register" aria-pressed="${registering}" ${busy ? 'disabled' : ''}>注册</button></div><form id="authForm" novalidate>${registering ? `<label class="form-field"><span>邀请码</span><input id="authInviteCode" name="inviteCode" type="password" autocomplete="off" ${busy ? 'disabled' : ''} required /></label>` : ''}<label class="form-field"><span>用户名</span><input id="authUsername" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" ${busy ? 'disabled' : ''} required /></label><label class="form-field"><span>密码</span><input id="authPassword" name="password" type="password" autocomplete="${registering ? 'new-password' : 'current-password'}" ${busy ? 'disabled' : ''} required /></label>${registering ? `<label class="form-field"><span>确认密码</span><input id="authPasswordConfirm" name="passwordConfirm" type="password" autocomplete="new-password" ${busy ? 'disabled' : ''} required /></label>` : ''}<div class="auth-error" id="authError" role="alert" aria-live="polite">${esc(authStatus)}</div><button class="button button-dark auth-submit" type="submit" ${busy ? 'disabled' : ''}>${state.logoutPending ? '正在退出…' : state.authBusy ? '处理中…' : registering ? '使用邀请码注册' : '登录'}</button></form><p class="auth-footnote">同一个邀请码可重复注册不同账号，不会被消耗。</p></section>`;
}
function renderRoute() {
  document.body.dataset.authState = !state.sessionChecked ? 'checking' : state.user ? 'authenticated' : 'unauthenticated';
  const route = state.user ? normalizeAuthenticatedRoute() : getRoute();
  setBreadcrumb(route.name);
  const profileName = state.user?.username || state.user?.name || '?';
  document.querySelector('#profileButton').innerHTML = state.user ? `<span class="avatar avatar-amber">${esc(profileName.slice(0, 1))}</span><span class="profile-copy"><strong>${esc(profileName)}</strong><small>成员账号 · 退出</small></span><span class="profile-more">···</span>` : '<span class="avatar avatar-amber">?</span><span class="profile-copy"><strong>未登录</strong><small>需要账号</small></span><span class="profile-more">···</span>';
  const authButton = document.querySelector('#loginButton');
  document.querySelector('#changeUsernameButton').hidden = !state.user;
  document.querySelector('#changeUsernameButton').disabled = state.usernameRenamePending;
  authButton.classList.toggle('is-logout', Boolean(state.user));
  authButton.innerHTML = '退出 <span>↗</span>';
  authButton.setAttribute('aria-label', '退出登录');
  document.querySelector('#syncStatusText').textContent = state.user ? '私人数据库已连接' : state.serviceError ? '服务不可用' : '等待登录';
  const inboxButton = document.querySelector('#inboxButton');
  const inboxBadge = document.querySelector('#inboxUnreadBadge');
  if (inboxButton && inboxBadge) {
    inboxBadge.hidden = state.inboxUnreadCount <= 0;
    inboxBadge.textContent = state.inboxUnreadCount > 99 ? '99+' : String(state.inboxUnreadCount);
    inboxButton.setAttribute('aria-label', `收件箱，${state.inboxUnreadCount} 条未读`);
    inboxButton.title = state.inboxUnreadCount ? `收件箱：${state.inboxUnreadCount} 条未读` : '收件箱';
  }
  if (!state.sessionChecked || !state.user) { app.innerHTML = renderAuthGate(); document.querySelector('#retrySessionButton')?.addEventListener('click', bootstrapDatabase); bindAuthGate(); return; }
  if (state.privateLoading) { app.innerHTML = '<div class="page-wrap-inner"><div class="empty-state" role="status">正在加载私人数据…</div></div>'; return; }
  if (state.serviceError) { app.innerHTML = `<div class="page-wrap-inner"><div class="error-state" role="alert"><strong>私人数据暂时无法加载</strong><p>${esc(state.serviceError)}</p><button class="button button-light" type="button" id="retryPrivateButton">重试</button></div></div>`; document.querySelector('#retryPrivateButton')?.addEventListener('click', loadPrivateData); return; }
  const enteredMessages = route.name === 'messages' && state.lastPrivateRouteName !== 'messages';
  state.lastPrivateRouteName = route.name;
  app.innerHTML = route.name === 'rules' ? renderRules() : route.name === 'calendar-puzzle' ? renderPuzzlePage(route.number, 'calendar') : route.name === 'leftovers' ? renderCalendarLeftovers() : route.name === 'messages' ? renderMessages() : renderCalendar(route.name);
  if (['calendar', 'pending', 'allocation', 'finished'].includes(route.name)) bindCalendar(route.name);
  if (route.name === 'leftovers') bindLeftovers();
  if (route.name === 'messages') bindMessages();
  if (route.name === 'rules') { document.querySelector('#addRuleButton')?.addEventListener('click', () => openRuleEditor()); document.querySelector('#retryRulesButton')?.addEventListener('click', () => { void loadRules(); }); bindRuleCatalog(); if (state.rulesStatus === 'idle' || state.rulesStatus === 'loading') void loadRules(); }
  if (route.name === 'calendar-puzzle') bindPuzzle(route.number, 'calendar');
  bindDifficultySpoilers();
  if (enteredMessages) void loadInboxFresh();
}
function bindFiles() { document.querySelector('#newFolderButton')?.addEventListener('click', openNewFolder); document.querySelector('#newFolderCard')?.addEventListener('click', openNewFolder); document.querySelectorAll('[data-folder]').forEach((folder) => folder.addEventListener('click', () => { state.filePath = ['全部文件', folder.querySelector('strong').textContent]; renderRoute(); showToast(`已打开文件夹：${state.filePath[1]}`); })); document.querySelector('[data-file-home]')?.addEventListener('click', () => { state.filePath = ['全部文件']; renderRoute(); }); document.querySelector('#sortFilesButton')?.addEventListener('click', (event) => { event.currentTarget.textContent = event.currentTarget.textContent === '按最近更新' ? '按名称排序' : '按最近更新'; showToast('文件排序方式已切换'); }); }
function openNewFolder() { openModal(`<p class="modal-eyebrow">FILE MANAGER</p><h2 id="modalTitle">新建文件夹</h2><p class="modal-intro">文件夹可以表示来源、年份或题集，并且可以继续嵌套。</p><label class="form-field"><span>文件夹名称</span><input id="newFolderName" type="text" placeholder="例如：2026" /></label><label class="form-field"><span>上级文件夹（可选）</span><select id="newFolderParent"><option value="">根目录</option>${state.folders.map((folder) => `<option value="${esc(folder.id)}">${esc(folder.name)}</option>`).join('')}</select></label><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button('创建文件夹', 'createFolderButton')}</div>`); document.querySelector('#createFolderButton').addEventListener('click', async () => { const name = document.querySelector('#newFolderName').value.trim(); if (!name) { showToast('请填写文件夹名称'); return; } const parent = document.querySelector('#newFolderParent').value || null; try { const data = await apiRequest('/api/folders', { method: 'POST', body: JSON.stringify({ name, parentId: parent }) }); state.folders = data.folders.map((folder) => ({ id: String(folder.id), name: folder.name, count: folder.count, parent: folder.parent })); closeModal(); renderRoute(); showToast(`文件夹「${name}」已创建`); } catch (error) { showToast(error.message); } }); }

function bindAuthGate() {
  document.querySelectorAll('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => {
    if (state.authBusy || state.logoutPending || state.authMode === button.dataset.authMode) return;
    state.authEpoch += 1;
    state.authMode = button.dataset.authMode;
    state.authError = '';
    renderRoute();
    document.querySelector('#authUsername')?.focus();
  }));
  document.querySelector('#authForm')?.addEventListener('submit', submitAuthForm);
}
function authFieldError(username, password, confirmPassword, inviteCode) {
  if (!username) return '请输入用户名。';
  if (!normalizeUsername(username)) return '用户名需为 2–32 个字符，可使用字母、数字、下划线和连字符。';
  if (state.authMode === 'register' && !inviteCode) return '请输入邀请码。';
  if (state.authMode === 'register' && !validateAccountPassword(password)) return '密码需为 8–128 个字符，最多 512 字节。';
  if (!password) return '请输入密码。';
  if (state.authMode === 'register' && password !== confirmPassword) return '两次输入的密码不一致。';
  return '';
}
async function submitAuthForm(event) {
  event.preventDefault();
  if (state.authBusy || state.logoutPending) return;
  const authAttempt = ++state.authEpoch;
  const attemptedMode = state.authMode;
  const rawUsername = document.querySelector('#authUsername').value;
  const username = normalizeUsername(rawUsername)?.username || rawUsername.normalize('NFKC');
  const password = document.querySelector('#authPassword').value;
  const confirmPassword = document.querySelector('#authPasswordConfirm')?.value || '';
  const inviteCode = document.querySelector('#authInviteCode')?.value || '';
  const validationError = authFieldError(username, password, confirmPassword, inviteCode);
  const errorNode = document.querySelector('#authError');
  if (validationError) { errorNode.textContent = validationError; return; }
  state.authBusy = true;
  state.authError = '';
  const submitButton = document.querySelector('.auth-submit');
  submitButton.disabled = true;
  submitButton.textContent = state.authMode === 'register' ? '正在注册…' : '正在登录…';
  try {
    const registering = attemptedMode === 'register';
    const data = await apiRequest(registering ? '/api/register' : '/api/session', {
      method: 'POST',
      body: JSON.stringify(registering ? { inviteCode, username, password } : { username, password })
    });
    if (authAttempt !== state.authEpoch || attemptedMode !== state.authMode || state.user) return;
    if (!data.user) throw new Error('服务器没有返回账号信息，请重试。');
    state.sessionEpoch += 1;
    state.user = data.user;
    state.sessionChecked = true;
    state.authBusy = false;
    state.authError = '';
    state.serviceError = '';
    normalizeAuthenticatedRoute();
    renderRoute();
    const sessionEpoch = state.sessionEpoch;
    const welcomeName = state.user.username || state.user.name;
    await loadPrivateData();
    if (state.sessionEpoch === sessionEpoch && state.user) showToast(`欢迎，${welcomeName}`);
  } catch (error) {
    if (authAttempt !== state.authEpoch || attemptedMode !== state.authMode || state.user) return;
    state.authBusy = false;
    state.authError = error.message || '操作失败，请检查输入后重试。';
    if (errorNode.isConnected) errorNode.textContent = state.authError;
    if (submitButton.isConnected) {
      submitButton.disabled = false;
      submitButton.textContent = state.authMode === 'register' ? '使用邀请码注册' : '登录';
    }
  }
}
async function logout() {
  if (!state.user || state.logoutPending) return;
  state.logoutPending = true;
  const request = apiRequest('/api/session', { method: 'DELETE' });
  clearPrivateState();
  state.sessionChecked = true;
  state.authMode = 'login';
  renderRoute();
  try {
    await request;
  } catch {
    state.authError = '退出请求未能完成。请重新登录后再试。';
  } finally {
    state.logoutPending = false;
    renderRoute();
  }
}
document.querySelector('#loginButton').addEventListener('click', logout);
document.querySelector('#profileButton').addEventListener('click', logout);
document.querySelector('#changeUsernameButton').addEventListener('click', openUsernameEditor);
document.querySelector('#inboxButton')?.addEventListener('click', () => { if (state.user && getRoute().name === 'messages') void loadInboxFresh(); else window.location.hash = '#messages'; });
modalBackdrop.addEventListener('click', (event) => { if (event.target === modalBackdrop || event.target.closest('.modal-close') || event.target.closest('.modal-cancel')) closeModal(); });
window.addEventListener('hashchange', renderRoute);
renderRoute();
bootstrapDatabase();
