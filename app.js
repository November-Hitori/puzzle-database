import { getPuzzleSource, hasConcretePuzzlePayload, isConcretePenpaPuzzleUrl, parseTrustedPuzzleUrl } from './puzzle-url.mjs';
import { buildPuzzleToolLinks } from './puzzle-tool-links.mjs';
import { normalizeUsername, validateAccountPassword } from './auth-policy.mjs';

const state = {
  puzzles: [],
  calendarPuzzles: [],
  rules: [],
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
  authError: '',
  authEpoch: 0,
  logoutPending: false,
  serviceError: '',
  privateLoading: false,
  sessionEpoch: 0,
  calendarSort: 'date',
  calendarReturnRoute: 'calendar',
  ruleFilter: 'all',
  ruleQuery: '',
  submissionDraft: null
};
const app = document.querySelector('#app');
const modalBackdrop = document.querySelector('#modalBackdrop');
const modalContent = document.querySelector('#modalContent');
const toastElement = document.querySelector('#toast');
let toastTimer;

async function apiRequest(path, options = {}) {
  const authEndpoint = ['/api/session', '/api/register'].includes(path);
  const requestEpoch = state.sessionEpoch;
  const requestUserId = state.user?.id;
  const authenticatedAtStart = Boolean(state.user);
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...options });
  let payload = {};
  if (response.status !== 204) {
    try { payload = await response.json(); }
    catch (error) {
      if (!authEndpoint && (requestEpoch !== state.sessionEpoch || String(state.user?.id) !== String(requestUserId))) throw new Error('请求已取消。');
      throw error;
    }
  }
  if (!authEndpoint && (requestEpoch !== state.sessionEpoch || String(state.user?.id) !== String(requestUserId))) throw new Error('请求已取消。');
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    message = payload.error || message;
    if (response.status === 401 && state.sessionChecked && authenticatedAtStart && !authEndpoint) handleUnauthorized();
    const error = new Error(message); error.status = response.status; throw error;
  }
  return payload;
}
function applyPuzzleData(puzzles) { state.puzzles = puzzles.map((puzzle) => ({ ...puzzle, ratings: (puzzle.ratings || [0, 0, 0]).map(Number), tags: puzzle.tags || [], userRating: puzzle.userRating || null, votes: Number(puzzle.votes || 0) })); }
async function bootstrapDatabase() { clearPrivateState(); const epoch = ++state.sessionEpoch; state.sessionChecked = false; state.authError = ''; renderRoute(); try { const session = await apiRequest('/api/session'); if (epoch !== state.sessionEpoch) return; state.sessionChecked = true; state.user = session.user || null; if (!state.user) { renderRoute(); return; } normalizeAuthenticatedRoute(); renderRoute(); await loadPrivateData(); } catch (error) { if (epoch !== state.sessionEpoch) return; state.sessionChecked = true; state.user = null; state.serviceError = error.message || '服务暂不可用'; renderRoute(); } }
async function loadPrivateData() { if (!state.user) return; const epoch = state.sessionEpoch; const userId = state.user.id; state.privateLoading = true; state.serviceError = ''; renderRoute(); try { const [ruleData, calendarData] = await Promise.all([apiRequest('/api/rules'), apiRequest('/api/calendar/puzzles')]); if (epoch !== state.sessionEpoch || !state.user || String(state.user.id) !== String(userId)) return; state.rules = ruleData.rules || []; state.calendarPuzzles = (calendarData.puzzles || []).map(normalizePuzzle); state.privateLoading = false; renderRoute(); } catch (error) { if (epoch !== state.sessionEpoch || !state.user || String(state.user.id) !== String(userId)) return; state.privateLoading = false; state.serviceError = error.message || '无法加载私人数据'; renderRoute(); } }
function normalizePuzzle(puzzle) { return { ...puzzle, ratings: (puzzle.ratings || [0, 0, 0]).map(Number), userRating: puzzle.userRating || null, votes: Number(puzzle.votes || 0), tags: puzzle.tags || [] }; }
function isCurrentUserSession(epoch, userId) { return epoch === state.sessionEpoch && Boolean(state.user) && String(state.user.id) === String(userId); }
function clearPrivateState() { state.sessionEpoch += 1; state.authEpoch += 1; state.user = null; state.puzzles = []; state.calendarPuzzles = []; state.rules = []; state.folders = []; state.collections = []; state.currentCollection = null; state.submissionDraft = null; state.calendarReturnRoute = 'calendar'; state.serviceError = ''; state.authError = ''; state.privateLoading = false; state.authBusy = false; clearTimeout(toastTimer); toastElement.classList.remove('show'); toastElement.textContent = ''; closeModal(); }
function handleUnauthorized() { clearPrivateState(); state.sessionChecked = true; state.authMode = 'login'; state.authError = '登录状态已失效，请重新登录。'; renderRoute(); }
function esc(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function ratingMarkup(values, votes) { return `<div class="rating-set" title="${votes} 位解题者的平均评分"><span class="rating-item">✎ <b>${values[0].toFixed(1)}</b></span><span class="rating-item">♧ <b>${values[1].toFixed(1)}</b></span><span class="rating-item">♥ <b>${values[2].toFixed(1)}</b></span></div>`; }
function tagMarkup(tags) { return `<div class="tag-list">${tags.map((tag) => `<span class="tag ${tag === 'Wrong Puzzle' ? 'warning' : tag === 'Example Puzzle' ? 'type' : ''}">${esc(tag)}</span>`).join('')}</div>`; }
function showToast(message) { if (document.body.dataset.authState !== 'authenticated') return; toastElement.textContent = message; toastElement.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastElement.classList.remove('show'), 2600); }
function openModal(content) { modalContent.innerHTML = content; modalBackdrop.hidden = false; document.body.style.overflow = 'hidden'; }
function closeModal() { modalBackdrop.hidden = true; modalContent.innerHTML = ''; document.body.style.overflow = ''; }
function button(text, id = '', className = 'button button-dark') { return `<button class="${className}" type="button"${id ? ` id="${id}"` : ''}>${text}</button>`; }

function getRoute() { const hash = window.location.hash.slice(1) || 'home'; const calendarMatch = hash.match(/^calendar-puzzle-(\d+)$/); const puzzleMatch = hash.match(/^puzzle-(\d+)$/); const collectionMatch = hash.match(/^collection-(\d+)$/); if (calendarMatch) return { name: 'calendar-puzzle', number: Number(calendarMatch[1]) }; if (puzzleMatch) return { name: 'puzzle', number: Number(puzzleMatch[1]) }; if (collectionMatch) return { name: 'collection', id: Number(collectionMatch[1]) }; return { name: hash.split('/')[0] || 'home' }; }
function normalizeAuthenticatedRoute() { const route = getRoute(); if (!['calendar', 'pending', 'rules', 'calendar-puzzle'].includes(route.name)) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#calendar`); return getRoute(); }
function setBreadcrumb(name) { const labels = { home: '谜题日历', library: '谜题日历', collections: '谜题日历', collection: '谜题日历', files: '谜题日历', records: '谜题日历', authors: '谜题日历', puzzle: '谜题日历', pending: '我的未完成谜题', calendar: '谜题日历', 'calendar-puzzle': '日历谜题', rules: '规则管理' }; const crumb = document.querySelector('#breadcrumbCurrent'); if (crumb) crumb.textContent = labels[name] || '谜题日历'; const activeRoute = name === 'calendar-puzzle' ? 'calendar' : name; document.querySelectorAll('[data-route-link]').forEach((link) => link.classList.toggle('active', link.dataset.routeLink === activeRoute)); }

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
function renderCalendar(pending = false) {
  const puzzles = [...state.calendarPuzzles].filter((puzzle) => !pending || !puzzle.completed).sort((a, b) => {
    const ad = a.suggestedDate || '9999-99-99'; const bd = b.suggestedDate || '9999-99-99';
    return state.calendarSort === 'newest' ? b.number - a.number : ad.localeCompare(bd) || b.number - a.number;
  });
  const rows = puzzles.map((puzzle) => `<a class="calendar-row ${puzzle.completed ? 'is-completed' : ''}" href="#calendar-puzzle-${puzzle.number}"><span class="calendar-date">${puzzle.suggestedDate ? esc(puzzle.suggestedDate) : '日期未定'}</span><span class="calendar-info"><strong>${esc(puzzle.title)}</strong><small>${puzzle.rule ? ruleLabel(puzzle.rule) : esc(puzzle.type)} · ${esc(puzzle.submittedBy?.name || puzzle.author || '未知作者')}</small></span><span class="calendar-progress">${puzzle.completed ? '✓ 你已完成' : '待你解题'}</span><span class="calendar-rating">${ratingMarkup(puzzle.ratings, puzzle.votes)}</span><span class="calendar-arrow">→</span></a>`).join('');
  const pageTitle = pending ? '我的未完成谜题' : '谜题日历';
  const emptyState = pending
    ? `<div class="empty-state calendar-empty"><strong>没有待解题目</strong><span>这份清单只统计你自己的完成记录。</span><a class="button button-light" href="#calendar">查看全部投稿</a></div>`
    : `<div class="empty-state calendar-empty"><strong>日历还没有谜题</strong><span>可以先从规则目录中选择规则，再提交第一道日历谜题。</span>${button('提交日历谜题', 'emptyCalendarAdd', 'button button-light')}</div>`;
  return `<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span>PRIVATE PUZZLE CALENDAR</p><h1>${pageTitle}<span class="heading-period">.</span></h1><p class="page-description">全部成员的投稿共同收录；完成状态只属于你自己。建议日期可留空。</p></div>${button('<span class="button-plus">+</span>提交日历谜题', 'addCalendarPuzzleButton')}</section><nav class="calendar-view-switch" aria-label="日历视图"><a class="${pending ? '' : 'active'}" href="#calendar">全部投稿 <span>${state.calendarPuzzles.length}</span></a><a class="${pending ? 'active' : ''}" href="#pending">我的未完成 <span>${state.calendarPuzzles.filter((puzzle) => !puzzle.completed).length}</span></a></nav><section class="calendar-toolbar"><div class="section-title-group"><h2>${pending ? '待你解题' : '全部日历谜题'}</h2><span class="count-badge">${String(puzzles.length).padStart(2, '0')}</span></div><label class="calendar-sort-label" for="calendarSort">排序</label><select id="calendarSort" aria-label="日历谜题排序"><option value="date" ${state.calendarSort === 'date' ? 'selected' : ''}>建议日期</option><option value="newest" ${state.calendarSort === 'newest' ? 'selected' : ''}>最近提交</option></select></section><div class="calendar-list">${puzzles.length ? rows : emptyState}</div></div>`;
}
function renderRules() {
  const rules = state.rules;
  const filtered = rules.filter((rule) => ruleMatchesRuleFilter(rule, state.ruleFilter) && (!state.ruleQuery || `${rule.titleZh || ''} ${rule.titleEn || ''} ${rule.category || ''} ${(rule.rulesZh || []).join(' ')} ${(rule.rulesEn || []).join(' ')}`.toLowerCase().includes(state.ruleQuery.toLowerCase())));
  const totals = rules.reduce((sum, rule) => { const quality = rule.quality || {}; sum.errors += (quality.errors || []).length; sum.warnings += (quality.warnings || []).length; return sum; }, { errors: 0, warnings: 0 });
  const problemRules = rules.filter((rule) => (rule.quality?.errors || []).length + (rule.quality?.warnings || []).length > 0).length;
  return `<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span>RULE CATALOG</p><h1>规则目录<span class="heading-period">.</span></h1><p class="page-description">规则允许先保存为草稿；名称、规则描述与例题分别完成独立审核。</p></div>${button('<span class="button-plus">+</span>新建规则', 'addRuleButton')}</section><section class="rule-quality-summary" aria-label="目录质量概况"><div><span>目录规则</span><strong>${rules.length}</strong></div><div><span>受影响规则</span><strong>${problemRules}</strong></div><div class="quality-count-error"><span>错误项</span><strong>${totals.errors}</strong></div><div class="quality-count-warning"><span>待审核项</span><strong>${totals.warnings}</strong></div></section><section class="rule-catalog-tools"><label class="rule-search"><span class="sr-only">搜索规则</span><input id="ruleSearch" type="search" value="${esc(state.ruleQuery)}" placeholder="搜索中英文名称、分类或规则" /></label><div class="rule-filter-tabs" role="group" aria-label="规则筛选">${[['all','全部'],['problem','有问题'],['error','错误'],['warning','待审核']].map(([key,label]) => `<button type="button" class="rule-filter-button ${state.ruleFilter === key ? 'active' : ''}" data-rule-filter="${key}">${label}</button>`).join('')}</div></section><div class="rule-catalog">${filtered.length ? filtered.map((rule) => renderRuleCard(rule, rules)).join('') : '<div class="empty-state">没有符合筛选条件的规则。</div>'}</div></div>`;
}
function clauseMarkup(clauses = []) { return `<ol class="rule-clauses">${clauses.map((clause) => `<li>${esc(clause)}</li>`).join('')}</ol>`; }
function ruleTitle(rule) { return rule.titleZh || rule.titleEn || '未命名规则'; }
function ruleDisplayName(rule) { return [rule.titleZh, rule.titleEn].filter(Boolean).join(' / ') || '未命名规则'; }
function ruleLabel(rule) { return esc([rule.titleZh, rule.titleEn].filter(Boolean).join(' / ') || '未命名规则'); }
function ruleTitlePair(rule) { const primary = rule.titleZh || rule.titleEn || '未命名规则'; const secondary = rule.titleZh && rule.titleEn ? ` <small>${esc(rule.titleEn)}</small>` : ''; return `${esc(primary)}${secondary}`; }
function normalizeRuleSearch(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ''); }
function filterRuleOptions(query) {
  const normalizedQuery = normalizeRuleSearch(query);
  if (!normalizedQuery) return [...state.rules];
  return state.rules.filter((rule) => normalizeRuleSearch(`${rule.titleZh || ''} ${rule.titleEn || ''} ${rule.category || ''}`).includes(normalizedQuery));
}
function ruleMatchesRuleFilter(rule, filter) { const quality = rule.quality || {}; const errors = quality.errors || []; const warnings = quality.warnings || []; if (filter === 'problem') return errors.length + warnings.length > 0; if (filter === 'error') return errors.length > 0; if (filter === 'warning') return warnings.length > 0; return true; }
const auditLabels = { name: '名称', description: '规则描述', example: '例题' };
function renderRuleCard(rule, allRules) {
  const quality = rule.quality || { errors: [], warnings: [], groups: {} };
  const errors = quality.errors || []; const warnings = quality.warnings || []; const groups = quality.groups || {};
  const baseRule = allRules.find((item) => String(item.id) === String(rule.baseRuleId));
  const auditCards = ['name', 'description', 'example'].map((item) => renderAuditGroup(rule, item, groups[item] || {}, errors, warnings)).join('');
  const exampleAuthor = String(rule.exampleAuthor || '').trim();
  const exampleAuthorMarkup = exampleAuthor ? `<p class="rule-example-author">例题作者：${esc(exampleAuthor)}</p>` : '';
  const exampleLink = isConcretePenpaPuzzleUrl(rule.exampleUrl) ? `<a class="rule-example-link" href="${esc(rule.exampleUrl)}" target="_blank" rel="noopener noreferrer">打开 Penpa 例题 ↗</a>` : '<p class="rule-missing">尚未提供有效的 Penpa 例题</p>';
  return `<article class="rule-card" data-rule-card="${esc(rule.id)}"><div class="rule-card-heading"><div><span class="rule-category">${esc(rule.category || '未分类')}</span><h2>${ruleTitlePair(rule)}</h2></div><div class="rule-card-actions">${rule.isVariant ? '<span class="rule-variant">变体</span>' : ''}<button type="button" class="button button-light rule-edit-button" data-rule-edit="${esc(rule.id)}">编辑</button><button type="button" class="button button-light rule-delete-button" data-rule-delete="${esc(rule.id)}" data-delete-token="${esc(rule.deleteToken || '')}" data-edit-version="${esc(rule.editVersion || '')}" data-rule-title="${esc(ruleTitle(rule))}" aria-label="删除规则：${esc(ruleTitle(rule))}" ${rule.deleteToken ? '' : 'disabled title="无法确认规则身份，请刷新目录"'}>删除</button></div></div>${rule.isVariant ? `<p class="rule-base">原始规则：${esc(rule.baseRuleTitleZh || rule.baseRuleTitleEn || (baseRule ? ruleTitle(baseRule) : '未指定'))}</p>` : ''}<div class="rule-quality-inline">${errors.length ? `<span class="quality-error-pill">${errors.length} 项错误</span>` : '<span class="quality-ok-pill">无错误项</span>'}${warnings.length ? `<span class="quality-warning-pill">${warnings.length} 项待审核</span>` : ''}</div>${errors.length || warnings.length ? `<ul class="rule-quality-messages">${[...errors.map((entry) => ({ ...entry, severity: 'error' })), ...warnings.map((entry) => ({ ...entry, severity: 'warning' }))].map((entry) => `<li class="${entry.severity}">${esc(entry.message)}</li>`).join('')}</ul>` : ''}<div class="rule-language-grid"><section><h3>规则 · 中文</h3>${rule.rulesZh?.length ? clauseMarkup(rule.rulesZh) : '<p class="rule-missing">尚未填写中文规则描述</p>'}</section><section><h3>Rules · English</h3>${rule.rulesEn?.length ? clauseMarkup(rule.rulesEn) : '<p class="rule-optional">English description is optional.</p>'}</section></div><div class="rule-example">${exampleAuthorMarkup}${exampleLink}</div><section class="rule-audit-grid" aria-label="独立审核">${auditCards}</section></article>`;
}
function renderAuditGroup(rule, item, group, errors, warnings) {
  const itemErrors = errors.filter((entry) => entry.item === item);
  const itemWarnings = warnings.filter((entry) => entry.item === item);
  const incomplete = group.status === 'incomplete' || itemErrors.length > 0;
  const rejected = Boolean(group.rejected) || group.status === 'rejected';
  const approvals = Number(group.approvalCount || 0); const required = Number(group.requiredApprovals || 3);
  const approvedBy = (group.currentReviews || []).filter((review) => review.decision === 'approve' && review.active !== false).map((review) => review.name || '成员');
  const rejectionSuggestion = group.rejectionSuggestion || (group.currentReviews || []).find((review) => review.decision === 'reject')?.suggestion;
  const currentReview = (group.currentReviews || []).find((review) => String(review.userId) === String(state.user?.id));
  const history = group.history || [];
  const statusLabel = rejected ? '有打回意见' : group.status === 'approved' ? '已通过' : incomplete ? '内容未完整' : `${approvals}/${required} 通过`;
  const approveDisabled = incomplete || rejected || group.status === 'approved' || currentReview?.decision === 'approve';
  return `<article class="rule-audit-item ${rejected ? 'is-rejected' : ''} ${group.status === 'approved' ? 'is-approved' : ''}"><header><div><h3>${auditLabels[item]}</h3><span class="audit-status">${statusLabel}</span></div><span class="audit-count" title="需要不同账号独立审核">${approvals}/${required} 位成员</span></header>${incomplete ? `<p class="audit-explanation">${itemErrors.map((entry) => esc(entry.message)).join('；') || '补齐缺项后才能通过'}</p>` : `<p class="audit-reviewers">${approvedBy.length ? `通过成员：${approvedBy.map(esc).join('、')}` : '等待成员审核'}</p>`}${rejected ? `<div class="audit-rejection"><strong>审计建议</strong><p>${esc(rejectionSuggestion || '未填写建议')}</p></div>` : ''}${itemWarnings.map((entry) => `<p class="audit-explanation">${esc(entry.message)}</p>`).join('')}<div class="audit-actions"><button type="button" class="button button-light" data-rule-audit="approve" data-rule-id="${esc(rule.id)}" data-audit-item="${item}" ${approveDisabled ? 'disabled' : ''} title="${incomplete ? '补齐缺项后才能通过' : rejected ? '被打回的内容需先实际修改' : group.status === 'approved' ? '本审核项已有三位成员通过' : ''}">✓ ${currentReview?.decision === 'approve' ? '已通过' : '通过'}</button><button type="button" class="text-button audit-reject-button" data-rule-audit="reject" data-rule-id="${esc(rule.id)}" data-audit-item="${item}" ${currentReview?.decision === 'reject' ? 'disabled' : ''}>打回并建议</button></div>${history.length ? `<details class="audit-history"><summary>审核记录（${history.length}）</summary><ol>${history.map((entry) => `<li><strong>${esc(entry.name || '成员')}</strong> · ${entry.decision === 'approve' ? '通过' : '打回'} · 第 ${esc(entry.revision)} 版 · ${esc(entry.createdAt || '')}${entry.suggestion ? `<p>${esc(entry.suggestion)}</p>` : ''}</li>`).join('')}</ol></details>` : ''}</article>`;
}


function renderFiles() { const folders = state.folders; return `<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span>FILE MANAGER</p><h1>文件管理<span class="heading-period">.</span></h1><p class="page-description">把来源、年份和题集放进清晰的文件夹。</p></div>${button('<span class="button-plus">+</span>新建文件夹', 'newFolderButton')}</section><section class="file-toolbar"><div class="file-breadcrumb"><button type="button" data-file-home>全部文件</button>${state.filePath.slice(1).map((part) => `<span> / </span><strong>${esc(part)}</strong>`).join('')}</div><div class="file-actions"><button class="button button-light" type="button" id="sortFilesButton">按最近更新</button><button class="icon-button bordered" type="button" title="列表视图">☷</button></div></section><section class="file-layout"><div class="file-main"><div class="file-section-heading"><span>FOLDERS</span><span>${folders.length} 个文件夹</span></div><div class="folder-cards">${folders.map((folder) => `<button class="folder-card" type="button" data-folder="${esc(folder.id)}"><span class="folder-card-icon">▰</span><strong>${esc(folder.name)}</strong><small>${folder.count} puzzles <span>→</span></small></button>`).join('')}<button class="folder-card folder-card-new" type="button" id="newFolderCard"><span>+</span><strong>新建文件夹</strong></button></div><div class="file-section-heading file-section-heading-spaced"><span>RECENT FILES</span><span>按最近修改</span></div><div class="file-table"><div class="file-row file-head"><span>名称</span><span>位置</span><span>题目</span><span>更新</span></div>${[['Spring Selection', 'Logic Masters India / 2026', '08', '今天'], ['Paper & Pencil / Vol. 01', '日本パズル協会 / 2025', '24', '2 天前'], ['Example Puzzles', '个人收藏 / 2024', '12', '上周']].map(([name, location, count, updated]) => `<a class="file-row" href="#puzzle-128"><span class="file-name"><span class="file-mini-icon">▰</span><strong>${name}</strong></span><span class="muted">${location}</span><span>${count}</span><span class="muted">${updated}</span></a>`).join('')}</div></div><aside class="file-aside"><div class="file-aside-icon">⌘</div><h2>你的题目，<br /><em>有自己的位置。</em></h2><p>用来源、年份和题集整理资料。文件夹可以无限嵌套，之后也能随时移动。</p><div class="tree-mini"><span>⌄　▰ Logic Masters India</span><span>　⌄　▰ 2026</span><span>　　 ›　▰ Spring Selection</span></div></aside></section></div>`; }

function renderRecords() { const completed = state.puzzles.filter((puzzle) => puzzle.completed); return `<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span>PERSONAL LOG</p><h1>我的记录<span class="heading-period">.</span></h1><p class="page-description">这里保存你完成过的题目和评分。</p></div></section><section class="record-summary"><div><span>已完成</span><strong>${completed.length}</strong></div><div><span>已评分</span><strong>${completed.filter((puzzle) => puzzle.userRating).length}</strong></div><div><span>平均喜爱程度</span><strong>—</strong></div></section><section class="record-list"><div class="file-section-heading"><span>COMPLETED PUZZLES</span><span>${completed.length} 条记录</span></div>${completed.length ? completed.map((puzzle) => `<a class="record-row" href="#puzzle-${puzzle.number}"><span class="record-check">✓</span><span><strong>${esc(puzzle.title)}</strong><small>#${puzzle.number} · ${esc(puzzle.author)}</small></span><span class="muted">查看题目 →</span></a>`).join('') : '<div class="empty-state">还没有完成的题目。去题库挑一道开始吧。</div>'}</section></div>`; }
function renderAuthors() { const authors = [...new Set(state.puzzles.map((puzzle) => puzzle.author))]; return `<div class="page-wrap-inner"><section class="page-heading"><div><p class="eyebrow"><span class="eyebrow-line"></span>CREATORS</p><h1>作者<span class="heading-period">.</span></h1><p class="page-description">按照作者浏览他们命制的所有题目。</p></div></section><div class="author-grid">${authors.map((author, index) => { const authored = state.puzzles.filter((puzzle) => puzzle.author === author); return `<a href="#library" class="author-card"><span class="author-card-avatar avatar-${['coral', 'mint', 'navy', 'amber'][index % 4]}">${esc(author[0] || '?')}</span><strong>${esc(author)}</strong><small>${authored.length} 道题目</small><span>查看题目 →</span></a>`; }).join('') || '<div class="empty-state">题库还没有作者记录。</div>'}</div></div>`; }

function openPuzzle(number) { window.location.hash = `#puzzle-${number}`; }
function renderPuzzlePage(number, scope = 'library') {
  const isCalendar = scope === 'calendar';
  const puzzles = isCalendar ? state.calendarPuzzles : state.puzzles;
  const puzzle = puzzles.find((item) => Number(item.number) === Number(number));
  if (!puzzle) return `<div class="page-wrap-inner"><div class="empty-state">找不到这道${isCalendar ? '日历' : ''}谜题。</div><a class="back-link" href="#${isCalendar ? 'calendar' : 'library'}">返回${isCalendar ? '谜题日历' : '题库'}</a></div>`;
  const hasRating = puzzle.userRating;
  const rule = puzzle.rule;
  const ruleSection = rule ? `<details open><summary>${ruleTitlePair(rule)}</summary>${rule.isVariant ? `<p class="rule-base">变体自：${esc(rule.baseRuleTitleZh || rule.baseRuleTitleEn || ruleTitle(state.rules.find((item) => String(item.id) === String(rule.baseRuleId)) || {}))}</p>` : ''}<div class="rule-language-grid"><section><h3>规则 · 中文</h3>${clauseMarkup(rule.rulesZh)}</section><section><h3>Rules · English</h3>${clauseMarkup(rule.rulesEn)}</section></div></details>` : `<details><summary>查看题目规则</summary><p>${esc(puzzle.rules || '暂未提供规则。')}</p></details>`;
  const isCalendarOwner = isCalendar && String(puzzle.submittedBy?.id) === String(state.user?.id);
  const dateControl = isCalendarOwner ? `<div class="detail-block"><h3>建议日期</h3><label class="inline-date-label" for="suggestedDateEdit">${puzzle.suggestedDate ? esc(puzzle.suggestedDate) : '尚未安排'}</label><input id="suggestedDateEdit" type="date" value="${esc(puzzle.suggestedDate || '')}" /><button class="button button-light date-save-button" id="saveSuggestedDateButton" type="button">保存日期</button></div>` : '';
  const deletePuzzleControl = isCalendarOwner ? `<button class="button button-danger puzzle-delete-button" id="deleteCalendarPuzzleButton" type="button" data-puzzle-number="${esc(puzzle.number)}" data-delete-token="${esc(puzzle.deleteToken || '')}" data-puzzle-title="${esc(puzzle.title)}" data-return-route="${esc(state.calendarReturnRoute === 'pending' ? 'pending' : 'calendar')}" aria-label="删除日历谜题：${esc(puzzle.title)}" ${puzzle.deleteToken ? '' : 'disabled title="无法确认投稿身份，请刷新页面"'}>删除此投稿</button>` : '';
  const authorName = puzzle.author || puzzle.submittedBy?.name || '未知作者';
  const authorLabel = isCalendar ? esc(authorName) : `<a href="#authors">${esc(authorName)}</a>`;
  return `<div class="page-wrap-inner puzzle-page"><a class="back-link" href="#${isCalendar ? state.calendarReturnRoute : 'library'}">← 返回${isCalendar ? (state.calendarReturnRoute === 'pending' ? '我的未完成谜题' : '谜题日历') : '题库'}</a><section class="puzzle-header"><div><p class="eyebrow"><span class="eyebrow-line"></span>${isCalendar ? 'CALENDAR PUZZLE' : 'PUZZLE'} #${puzzle.number}</p><h1>${esc(puzzle.title)}<span class="heading-period">.</span></h1><p class="puzzle-meta-large">${esc(puzzle.type)}　·　由 ${authorLabel} 发布　·　${puzzle.votes} 位解题者评分${isCalendar ? `　·　建议日期 ${esc(puzzle.suggestedDate || '未定')}` : ''}</p></div><div class="puzzle-header-tags">${tagMarkup(puzzle.tags)}${!isCalendar ? '<button class="tag-add-button" type="button" id="addTagButton">+ 添加标签</button>' : deletePuzzleControl}</div></section><section class="puzzle-content-grid"><div class="puzzle-board-column"><div class="embed-toolbar"><span class="embed-label">${puzzle.inputMode === 'blank' ? 'SELF-CONTAINED' : 'OPEN PUZZLE'}</span></div><div class="puzzle-embed" id="puzzleEmbed">${renderEmbed(puzzle)}</div><div class="puzzle-open-actions">${puzzle.inputMode === 'blank' ? '<span class="muted">这是一个内置填空题</span>' : '<span class="muted">外部题目通过上方工具按钮在新标签页打开</span>'}</div></div><aside class="puzzle-sidebar"><div class="detail-block"><h3>作者的话</h3><p>${esc(puzzle.note || '暂无说明。')}</p></div><div class="detail-block"><h3>规则</h3>${ruleSection}</div>${dateControl}<div class="detail-block record-panel"><h3>ANSWER RECORD</h3><p class="record-help">完成题目后，分别评价逻辑难度、通灵难度和喜爱程度。</p><button class="button ${puzzle.completed ? 'button-dark' : 'button-light'}" id="completePuzzleButton" type="button">${puzzle.completed ? '✓ 已完成 · 修改评分' : '标记为已完成'}</button>${hasRating ? `<div class="submitted-rating"><span>我的评分</span>${ratingMarkup(puzzle.userRating, 1)}</div>` : ''}</div>${!isCalendar ? '<div class="detail-block"><h3>留言板</h3><p class="muted">还没有留言。</p><div class="comment-box"><input type="text" placeholder="写下你的想法" aria-label="留言内容" /><button type="button" id="commentButton">发送</button></div></div>' : ''}</aside></section></div>`;
}

function renderPuzzleOpenTools(puzzle) {
  const links = buildPuzzleToolLinks(puzzle.url);
  const trustedUrl = parseTrustedPuzzleUrl(puzzle.url);
  if (!links.length || !trustedUrl) {
    return `<div class="tool-launch-panel tool-launch-blocked" role="alert"><span class="tool-launch-kicker">BLOCKED</span><strong>该链接不在支持的工具范围内</strong><p>请使用 puzz.link、pzv3、pzprxs、pzplus 或 Penpa 系列的官方题目链接。</p></div>`;
  }
  const toolbar = `<div class="solver-toolbar"><div class="solver-toolbar-copy"><span class="tool-launch-kicker">IN-PAGE SOLVER</span><strong>页内解题</strong></div><div class="tool-link-list">${links.map((link) => `<a class="tool-link-button" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer"><span>${esc(link.name)}</span><strong>在新标签页解题 ↗</strong></a>`).join('')}</div></div>`;
  if (!hasConcretePuzzlePayload(trustedUrl.href)) {
    return `<div class="solver-shell">${toolbar}<div class="solver-empty"><strong>这个示例还没有具体题面 URL</strong><p>为避免加载网站首页文本，页内模块已停用。请使用上方工具按钮打开。</p></div></div>`;
  }
  return `<div class="solver-shell">${toolbar}<div class="solver-frame"><iframe src="${esc(trustedUrl.href)}" title="${esc(puzzle.title)}"></iframe></div><p class="solver-note">上方按钮会打开对应网站；当前模块直接在页面内加载原题。</p></div>`;
}

function renderEmbed(puzzle) {
  if (puzzle.inputMode === 'blank') return `<div class="blank-puzzle"><span class="blank-kicker">FILL IN</span><h2>${esc(puzzle.title)}</h2><p>请根据规则填写答案。</p><label><span>你的答案</span><input id="blankAnswer" type="text" placeholder="输入答案" /></label><button type="button" class="button button-dark" id="checkBlankButton">检查答案</button><p id="blankResult" class="blank-result"></p></div>`;
  return renderPuzzleOpenTools(puzzle);
}

function isSupportedPuzzleUrl(value) { return parseTrustedPuzzleUrl(value) !== null; }

function openRating(number, scope = 'library') { const isCalendar = scope === 'calendar'; const puzzles = isCalendar ? state.calendarPuzzles : state.puzzles; const puzzle = puzzles.find((item) => Number(item.number) === Number(number)); if (!puzzle) return; const current = puzzle.userRating || [3, 3, 3]; openModal(`<p class="modal-eyebrow">ANSWER RECORD · #${puzzle.number}</p><h2 id="modalTitle">完成并评分</h2><p class="modal-intro">请在完成 ${esc(puzzle.title)} 后，为三个维度各给出 1–5 分。</p><div class="rating-form"><label><span>✎ 逻辑难度 <b id="logicValue">${current[0]}</b></span><input type="range" id="logicRating" min="1" max="5" step="1" value="${current[0]}" /></label><label><span>♧ 通灵难度 <b id="intuitionValue">${current[1]}</b></span><input type="range" id="intuitionRating" min="1" max="5" step="1" value="${current[1]}" /></label><label><span>♥ 喜爱程度 <b id="loveValue">${current[2]}</b></span><input type="range" id="loveRating" min="1" max="5" step="1" value="${current[2]}" /></label></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button('提交完成记录', 'submitRatingButton')}</div>`); ['logic', 'intuition', 'love'].forEach((key) => { const input = document.querySelector(`#${key}Rating`); const output = document.querySelector(`#${key}Value`); input.addEventListener('input', () => { output.textContent = input.value; }); }); document.querySelector('#submitRatingButton').addEventListener('click', async () => { const ratings = ['logic', 'intuition', 'love'].map((key) => Number(document.querySelector(`#${key}Rating`).value)); const requestEpoch = state.sessionEpoch; const userId = state.user?.id; try { const path = isCalendar ? `/api/calendar/puzzles/${number}/complete-rating` : `/api/puzzles/${number}/complete-rating`; const data = await apiRequest(path, { method: 'POST', body: JSON.stringify({ logic: ratings[0], intuition: ratings[1], enjoyment: ratings[2] }) }); if (isCalendar) state.calendarPuzzles = data.puzzles.map(normalizePuzzle); else applyPuzzleData(data.puzzles); closeModal(); renderRoute(); showToast('完成记录已保存，平均评分已更新'); } catch (error) { if (isCurrentUserSession(requestEpoch, userId)) showToast(error.message); } }); }
function bindLibrary() { document.querySelector('#addPuzzleButton')?.addEventListener('click', openAddPuzzle); document.querySelector('#filterButton')?.addEventListener('click', () => { const row = document.querySelector('#filterRow'); row.hidden = !row.hidden; }); document.querySelectorAll('.filter-pill').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.filter; state.visible = 6; renderRoute(); })); document.querySelectorAll('.segment').forEach((button) => button.addEventListener('click', () => { state.sort = button.dataset.sort; renderRoute(); })); document.querySelector('#loadMoreButton')?.addEventListener('click', () => { state.visible = Math.min(state.visible + 2, filteredPuzzles().length); renderRoute(); showToast('已加载更多题目'); }); document.querySelector('#noticeButton')?.addEventListener('click', () => showToast('公告详情将在公告模块接入后开放')); }
function openAddPuzzle(scope = 'library', draft = {}) {
  const isCalendar = scope === 'calendar';
  const initialRule = state.rules.find((rule) => String(draft.ruleId || '') === String(rule.id));
  const initialRuleId = initialRule ? String(initialRule.id) : '';
  openModal(`<p class="modal-eyebrow">${isCalendar ? 'PRIVATE CALENDAR' : 'NEW LIBRARY ENTRY'}</p><h2 id="modalTitle">${isCalendar ? '提交日历谜题' : '添加一道题目'}</h2><p class="modal-intro">先选择目录中的规则；如果没有合适规则，可以创建后自动返回此表单。</p><div class="form-field"><span id="submissionRuleLabel">规则（必选）</span><div class="submission-rule-picker"><input id="submissionRuleSearch" type="search" role="combobox" aria-labelledby="submissionRuleLabel" aria-autocomplete="list" aria-expanded="false" aria-controls="submissionRuleOptions" aria-required="true" autocomplete="off" value="${initialRule ? esc(ruleDisplayName(initialRule)) : ''}" placeholder="搜索中英文规则或分类" /><input id="submissionRule" type="hidden" value="${esc(initialRuleId)}" /><div class="submission-rule-dropdown" id="submissionRuleDropdown" hidden><div id="submissionRuleOptions" class="submission-rule-options" role="listbox" aria-labelledby="submissionRuleLabel"></div><p id="submissionRuleStatus" class="submission-rule-status" role="status" hidden></p></div></div><button class="text-button rule-create-inline" id="createRuleFromSubmission" type="button">＋ 新建规则</button></div><div id="submissionRulePreview" class="submission-rule-preview"></div><label class="form-field"><span>题目标题</span><input id="newPuzzleTitle" type="text" value="${esc(draft.title || '')}" placeholder="例如：Five Cells" /></label><label class="form-field"><span>题目链接（外链题目可填写）</span><input id="newPuzzleUrl" type="url" value="${esc(draft.url || '')}" placeholder="https://puzz.link/..." /></label><label class="form-field"><span>作者</span><input id="newPuzzleAuthor" type="text" value="${esc(draft.author || '')}" placeholder="作者名" /></label><label class="form-field"><span>类型</span><select id="newPuzzleMode"><option value="external" ${draft.inputMode !== 'blank' ? 'selected' : ''}>外部题目（puzz.link / penpa+）</option><option value="blank" ${draft.inputMode === 'blank' ? 'selected' : ''}>纯填空题</option></select></label><label class="form-field"><span>作者说明（可选）</span><textarea id="newPuzzleNote" rows="3" placeholder="简要介绍这道题">${esc(draft.note || '')}</textarea></label><label class="form-field"><span>答案（纯填空题可选）</span><input id="newPuzzleAnswer" type="text" value="${esc(draft.answer || '')}" placeholder="答案" /></label>${isCalendar ? `<label class="form-field"><span>建议日期（可选）</span><input id="newPuzzleDate" type="date" value="${esc(draft.suggestedDate || '')}" /></label>` : ''}<div class="modal-error" id="submissionError" role="alert"></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button('保存题目', 'savePuzzleButton')}</div>`);
  const searchInput = document.querySelector('#submissionRuleSearch');
  const selectedIdInput = document.querySelector('#submissionRule');
  const dropdown = document.querySelector('#submissionRuleDropdown');
  const optionsNode = document.querySelector('#submissionRuleOptions');
  const statusNode = document.querySelector('#submissionRuleStatus');
  let matchingRules = [];
  let activeRuleIndex = -1;
  const preview = () => {
    const rule = state.rules.find((item) => String(item.id) === String(selectedIdInput.value));
    document.querySelector('#submissionRulePreview').innerHTML = rule ? `<strong>${ruleTitlePair(rule)}</strong>${clauseMarkup(rule.rulesZh)}` : '<span class="muted">选择目录规则后可预览规则。</span>';
  };
  const renderOptions = (query) => {
    matchingRules = filterRuleOptions(query);
    if (!matchingRules.length) {
      optionsNode.innerHTML = '';
      statusNode.textContent = state.rules.length ? '没有匹配的规则。' : '规则目录为空，请先创建规则。';
      statusNode.hidden = false;
      searchInput.removeAttribute('aria-activedescendant');
      return;
    }
    statusNode.hidden = true;
    optionsNode.innerHTML = matchingRules.map((rule, index) => `<div id="submissionRuleOption-${index}" class="submission-rule-option ${index === activeRuleIndex ? 'is-active' : ''}" role="option" aria-selected="${String(rule.id) === selectedIdInput.value}" data-rule-option="${index}"><span>${esc(ruleDisplayName(rule))}</span><small>${esc(rule.category || '未分类')}</small>${String(rule.id) === selectedIdInput.value ? '<b aria-hidden="true">✓</b>' : ''}</div>`).join('');
    if (activeRuleIndex >= 0 && activeRuleIndex < matchingRules.length) {
      const activeOptionId = `submissionRuleOption-${activeRuleIndex}`;
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
        if (!document.activeElement?.closest('.submission-rule-picker')) closeOptions();
      }, 0);
    };
    document.addEventListener('pointerup', finishPointer);
    document.addEventListener('pointercancel', finishPointer);
  });
  searchInput.addEventListener('blur', () => window.setTimeout(() => {
    if (optionPointerActive) return;
    if (!document.activeElement?.closest('.submission-rule-picker')) closeOptions();
  }, 0));
  preview();
  document.querySelector('#createRuleFromSubmission').addEventListener('click', () => { state.submissionDraft = { scope, draft: captureSubmissionDraft() }; openRuleEditor({ fromSubmission: true }); });
  document.querySelector('#savePuzzleButton').addEventListener('click', async () => {
    const title = document.querySelector('#newPuzzleTitle').value.trim(); const mode = document.querySelector('#newPuzzleMode').value; const url = document.querySelector('#newPuzzleUrl').value.trim(); const ruleId = document.querySelector('#submissionRule').value;
    if (!title || !ruleId) { document.querySelector('#submissionError').textContent = title ? '请选择规则，或先创建一条新规则。' : '请填写题目标题。'; return; }
    if (mode === 'external' && !isSupportedPuzzleUrl(url)) { document.querySelector('#submissionError').textContent = '外部题目必须使用受支持的 puzz.link、Penpa+ 或同类工具链接。'; return; }
    const input = { title, ruleId, type: mode === 'blank' ? '填空题' : '逻辑题', author: document.querySelector('#newPuzzleAuthor').value.trim() || state.user.name, source: mode === 'blank' ? '填空题' : getPuzzleSource(url), url, inputMode: mode, answer: document.querySelector('#newPuzzleAnswer').value.trim(), note: document.querySelector('#newPuzzleNote').value.trim() };
    if (isCalendar) input.suggestedDate = document.querySelector('#newPuzzleDate').value || null;
    const requestEpoch = state.sessionEpoch; const userId = state.user?.id; const errorNode = document.querySelector('#submissionError');
    try {
      const path = isCalendar ? '/api/calendar/puzzles' : '/api/puzzles'; const data = await apiRequest(path, { method: 'POST', body: JSON.stringify(input) });
      if (isCalendar) { state.calendarPuzzles = data.puzzles.map(normalizePuzzle); const puzzle = normalizePuzzle(data.puzzle || state.calendarPuzzles.find((item) => item.number === Math.max(...state.calendarPuzzles.map((item) => item.number)))); closeModal(); window.location.hash = `#calendar-puzzle-${puzzle.number}`; }
      else { applyPuzzleData(data.puzzles); const newest = Math.max(...state.puzzles.map((puzzle) => puzzle.number)); closeModal(); window.location.hash = `#puzzle-${newest}`; }
      showToast('题目已创建');
    } catch (error) { if (isCurrentUserSession(requestEpoch, userId) && errorNode.isConnected) errorNode.textContent = error.message; }
  });
}
function captureSubmissionDraft() { return { ruleId: document.querySelector('#submissionRule')?.value || '', title: document.querySelector('#newPuzzleTitle')?.value || '', url: document.querySelector('#newPuzzleUrl')?.value || '', author: document.querySelector('#newPuzzleAuthor')?.value || '', inputMode: document.querySelector('#newPuzzleMode')?.value || 'external', note: document.querySelector('#newPuzzleNote')?.value || '', answer: document.querySelector('#newPuzzleAnswer')?.value || '', suggestedDate: document.querySelector('#newPuzzleDate')?.value || '' }; }
function openRuleEditor({ fromSubmission = false, draft = null, rule = null } = {}) {
  const editing = Boolean(rule);
  const rejectedItems = editing ? ['name', 'description', 'example'].filter((item) => rule.quality?.groups?.[item]?.rejected || rule.quality?.groups?.[item]?.status === 'rejected') : [];
  const rejectedHint = rejectedItems.length ? `<p class="audit-edit-warning" role="note">${rejectedItems.map((item) => auditLabels[item]).join('、')}已被打回。只有实际修改该项内容后才会重新开始审核；重新保存相同内容不会清除打回状态。</p>` : '';
  const baseOptions = state.rules.filter((item) => !item.isVariant).map((item) => `<option value="${esc(item.id)}" ${String(rule?.baseRuleId || '') === String(item.id) ? 'selected' : ''}>${ruleLabel(item)}</option>`).join('');
  openModal(`<p class="modal-eyebrow">RULE CATALOG</p><h2 id="modalTitle">${editing ? '编辑规则' : '新建规则'}</h2><p class="modal-intro">名称、规则描述、例题会分别审核。可先保存草稿，留空项会标示为待补充。</p>${rejectedHint}<label class="form-field"><span>中文名称</span><input id="ruleTitleZh" type="text" value="${esc(rule?.titleZh || '')}" aria-label="规则中文名称" /></label><label class="form-field"><span>English name</span><input id="ruleTitleEn" type="text" value="${esc(rule?.titleEn || '')}" aria-label="Rule English name" /></label><label class="form-field"><span>分类 <b class="required-mark">必填</b></span><select id="ruleCategory"><option value="">选择分类</option>${ruleCategories.map((item) => `<option ${rule?.category === item ? 'selected' : ''}>${item}</option>`).join('')}</select></label><label class="form-field"><span>规则描述 · 中文（每行一条，可留空）</span><textarea id="ruleClausesZh" rows="4" aria-label="中文规则描述，每行一条">${esc((rule?.rulesZh || draft?.rulesZh || []).join('\n'))}</textarea></label><label class="form-field"><span>Rules · English (one clause per line, optional)</span><textarea id="ruleClausesEn" rows="4" aria-label="English rule description, one clause per line">${esc((rule?.rulesEn || draft?.rulesEn || []).join('\n'))}</textarea></label><label class="form-field"><span>例题作者（可留空）</span><input id="ruleExampleAuthor" type="text" maxlength="200" value="${esc(rule?.exampleAuthor || '')}" aria-label="例题作者" /></label><label class="form-field"><span>例题 Penpa URL（可留空）</span><input id="ruleExampleUrl" type="url" maxlength="4096" value="${esc(rule?.exampleUrl || '')}" placeholder="https://penpa-edit.com/..." /></label><label class="variant-toggle"><input id="ruleIsVariant" type="checkbox" ${rule?.isVariant ? 'checked' : ''} /> 这是变体规则</label><label class="form-field" id="baseRuleField" ${rule?.isVariant ? '' : 'hidden'}><span>原始规则（可后补）</span><select id="ruleBase"><option value="">暂不选择</option>${baseOptions}</select></label><div class="modal-error" id="ruleError" role="alert" aria-live="polite"></div><div class="modal-footer"><button class="button button-light modal-cancel" type="button">取消</button>${button(editing ? '保存修改' : '保存规则草稿', 'saveRuleButton')}</div>`);
  document.querySelector('#ruleIsVariant').addEventListener('change', (event) => { document.querySelector('#baseRuleField').hidden = !event.target.checked; });
  document.querySelector('#saveRuleButton').addEventListener('click', async () => {
    const titleZh = document.querySelector('#ruleTitleZh').value.trim(); const titleEn = document.querySelector('#ruleTitleEn').value.trim(); const category = document.querySelector('#ruleCategory').value; const isVariant = document.querySelector('#ruleIsVariant').checked; const baseRuleId = document.querySelector('#ruleBase').value || null; const rulesZh = document.querySelector('#ruleClausesZh').value.split('\n').map((item) => item.trim()).filter(Boolean); const rulesEn = document.querySelector('#ruleClausesEn').value.split('\n').map((item) => item.trim()).filter(Boolean); const exampleUrl = document.querySelector('#ruleExampleUrl').value.trim(); const exampleAuthor = document.querySelector('#ruleExampleAuthor').value.trim();
    const errorNode = document.querySelector('#ruleError');
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
async function refreshRules(epoch = state.sessionEpoch, userId = state.user?.id) { const data = await apiRequest('/api/rules'); if (!isCurrentUserSession(epoch, userId)) return false; state.rules = data.rules || []; return true; }
function bindRuleCatalog() {
  document.querySelectorAll('[data-rule-edit]').forEach((button) => button.addEventListener('click', () => {
    const rule = state.rules.find((item) => String(item.id) === String(button.dataset.ruleEdit));
    if (rule) openRuleEditor({ rule });
  }));
  document.querySelectorAll('[data-rule-delete]').forEach((button) => button.addEventListener('click', () => {
    openDeleteRuleConfirmation({ id: button.dataset.ruleDelete, deleteToken: button.dataset.deleteToken, editVersion: Number(button.dataset.editVersion), title: button.dataset.ruleTitle });
  }));
  document.querySelectorAll('[data-rule-filter]').forEach((button) => button.addEventListener('click', () => { state.ruleFilter = button.dataset.ruleFilter; renderRoute(); }));
  const search = document.querySelector('#ruleSearch');
  search?.addEventListener('input', () => {
    const start = search.selectionStart; const end = search.selectionEnd;
    state.ruleQuery = search.value;
    renderRoute();
    const next = document.querySelector('#ruleSearch'); next?.focus(); next?.setSelectionRange(start, end);
  });
  document.querySelectorAll('[data-rule-audit]').forEach((button) => button.addEventListener('click', () => {
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
async function submitRuleAudit(ruleId, item, decision, suggestion = '', errorNode = null) {
  const rule = state.rules.find((entry) => String(entry.id) === String(ruleId)); if (!rule) return;
  const requestEpoch = state.sessionEpoch; const userId = state.user?.id; const revision = rule.revisions?.[item];
  try {
    await apiRequest(`/api/rules/${encodeURIComponent(ruleId)}/audits`, { method: 'POST', body: JSON.stringify({ item, decision, ...(decision === 'reject' ? { suggestion } : {}), revision }) });
    if (!isCurrentUserSession(requestEpoch, userId)) return;
    await refreshRules(requestEpoch, userId);
    if (!isCurrentUserSession(requestEpoch, userId)) return;
    if (decision === 'reject' && errorNode?.isConnected) closeModal();
    renderRoute(); showToast(decision === 'approve' ? '审核通过已记录。' : '打回建议已记录；本项内容需实际修改后才能重新审核。');
  } catch (error) {
    if (!isCurrentUserSession(requestEpoch, userId)) return;
    if (error.status === 409) { if (decision === 'reject' && errorNode?.isConnected) closeModal(); try { await refreshRules(requestEpoch, userId); } catch { if (isCurrentUserSession(requestEpoch, userId)) showToast('审核版本已更新，但刷新目录失败；请稍后重试。'); return; } if (isCurrentUserSession(requestEpoch, userId)) { renderRoute(); showToast('审核内容已更新，已刷新当前版本；请核对后重新操作。'); } return; }
    if (errorNode?.isConnected) errorNode.textContent = error.message;
    else showToast(error.message);
  }
}
function bindPuzzle(number, scope = 'library') {
  const isCalendar = scope === 'calendar'; const puzzle = (isCalendar ? state.calendarPuzzles : state.puzzles).find((item) => Number(item.number) === Number(number));
  document.querySelector('#completePuzzleButton')?.addEventListener('click', () => openRating(number, scope));
  document.querySelector('#addTagButton')?.addEventListener('click', () => openTagEditor(number));
  document.querySelector('#deleteCalendarPuzzleButton')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    openDeleteCalendarPuzzleConfirmation({ number: button.dataset.puzzleNumber, deleteToken: button.dataset.deleteToken, title: button.dataset.puzzleTitle, returnRoute: button.dataset.returnRoute });
  });
  document.querySelector('#saveSuggestedDateButton')?.addEventListener('click', async () => { const requestEpoch = state.sessionEpoch; const userId = state.user?.id; try { const suggestedDate = document.querySelector('#suggestedDateEdit').value || null; const data = await apiRequest(`/api/calendar/puzzles/${number}`, { method: 'PATCH', body: JSON.stringify({ suggestedDate }) }); state.calendarPuzzles = data.puzzles.map(normalizePuzzle); renderRoute(); showToast('建议日期已保存'); } catch (error) { if (isCurrentUserSession(requestEpoch, userId)) showToast(error.message); } });
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
      else {
        const refreshed = await apiRequest('/api/calendar/puzzles');
        if (!isCurrentUserSession(requestEpoch, userId)) return;
        state.calendarPuzzles = (refreshed.puzzles || []).map(normalizePuzzle);
      }
      if (!isCurrentUserSession(requestEpoch, userId)) return;
      state.calendarReturnRoute = target.returnRoute === 'pending' ? 'pending' : 'calendar';
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
function bindCalendar(routeName = 'calendar') { const origin = routeName === 'pending' ? 'pending' : 'calendar'; const openSubmission = () => { state.calendarReturnRoute = origin; openAddPuzzle('calendar'); }; document.querySelector('#addCalendarPuzzleButton')?.addEventListener('click', openSubmission); document.querySelector('#emptyCalendarAdd')?.addEventListener('click', openSubmission); document.querySelector('#calendarSort')?.addEventListener('change', (event) => { state.calendarSort = event.target.value; renderRoute(); }); document.querySelectorAll('.calendar-row').forEach((row) => row.addEventListener('click', () => { state.calendarReturnRoute = origin; })); }

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
  return `<section class="auth-gate auth-page"><div class="auth-brand"><span class="brand-mark">PA</span><span><strong>PuzArchive</strong><small>private puzzle archive</small></span></div><p class="eyebrow">TRUSTED MEMBERS</p><h1>${registering ? '创建成员账号' : '欢迎回来'}<span class="heading-period">.</span></h1><p>${registering ? '同一个邀请码可重复注册不同账号，不会被消耗。这里仅使用用户名和密码。' : '登录后继续浏览成员共同投稿的谜题日历。'}</p><div class="auth-switch" role="group" aria-label="账号操作"><button type="button" data-auth-mode="login" aria-pressed="${!registering}" ${busy ? 'disabled' : ''}>登录</button><button type="button" data-auth-mode="register" aria-pressed="${registering}" ${busy ? 'disabled' : ''}>注册</button></div><form id="authForm" novalidate>${registering ? '<label class="form-field"><span>邀请码</span><input id="authInviteCode" name="inviteCode" type="password" autocomplete="off" required /></label>' : ''}<label class="form-field"><span>用户名</span><input id="authUsername" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required /></label><label class="form-field"><span>密码</span><input id="authPassword" name="password" type="password" autocomplete="${registering ? 'new-password' : 'current-password'}" required /></label>${registering ? '<label class="form-field"><span>确认密码</span><input id="authPasswordConfirm" name="passwordConfirm" type="password" autocomplete="new-password" required /></label>' : ''}<div class="auth-error" id="authError" role="alert" aria-live="polite">${esc(authStatus)}</div><button class="button button-dark auth-submit" type="submit" ${busy ? 'disabled' : ''}>${state.logoutPending ? '正在退出…' : state.authBusy ? '处理中…' : registering ? '使用邀请码注册' : '登录'}</button></form><p class="auth-footnote">同一个邀请码可重复注册不同账号，不会被消耗。</p></section>`;
}
function renderRoute() {
  document.body.dataset.authState = !state.sessionChecked ? 'checking' : state.user ? 'authenticated' : 'unauthenticated';
  const route = state.user ? normalizeAuthenticatedRoute() : getRoute();
  setBreadcrumb(route.name);
  const profileName = state.user?.username || state.user?.name || '?';
  document.querySelector('#profileButton').innerHTML = state.user ? `<span class="avatar avatar-amber">${esc(profileName.slice(0, 1))}</span><span class="profile-copy"><strong>${esc(profileName)}</strong><small>成员账号 · 退出</small></span><span class="profile-more">···</span>` : '<span class="avatar avatar-amber">?</span><span class="profile-copy"><strong>未登录</strong><small>需要账号</small></span><span class="profile-more">···</span>';
  const authButton = document.querySelector('#loginButton');
  authButton.classList.toggle('is-logout', Boolean(state.user));
  authButton.innerHTML = '退出 <span>↗</span>';
  authButton.setAttribute('aria-label', '退出登录');
  document.querySelector('#syncStatusText').textContent = state.user ? '私人数据库已连接' : state.serviceError ? '服务不可用' : '等待登录';
  if (!state.sessionChecked || !state.user) { app.innerHTML = renderAuthGate(); document.querySelector('#retrySessionButton')?.addEventListener('click', bootstrapDatabase); bindAuthGate(); return; }
  if (state.privateLoading) { app.innerHTML = '<div class="page-wrap-inner"><div class="empty-state" role="status">正在加载私人数据…</div></div>'; return; }
  if (state.serviceError) { app.innerHTML = `<div class="page-wrap-inner"><div class="error-state" role="alert"><strong>私人数据暂时无法加载</strong><p>${esc(state.serviceError)}</p><button class="button button-light" type="button" id="retryPrivateButton">重试</button></div></div>`; document.querySelector('#retryPrivateButton')?.addEventListener('click', loadPrivateData); return; }
  app.innerHTML = route.name === 'rules' ? renderRules() : route.name === 'calendar-puzzle' ? renderPuzzlePage(route.number, 'calendar') : renderCalendar(route.name === 'pending');
  if (['calendar', 'pending'].includes(route.name)) bindCalendar(route.name);
  if (route.name === 'rules') { document.querySelector('#addRuleButton')?.addEventListener('click', () => openRuleEditor()); bindRuleCatalog(); }
  if (route.name === 'calendar-puzzle') bindPuzzle(route.number, 'calendar');
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
  if (state.authMode === 'register' && !validateAccountPassword(password)) return '密码需为 12–128 个字符，最多 512 字节。';
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
modalBackdrop.addEventListener('click', (event) => { if (event.target === modalBackdrop || event.target.closest('.modal-close') || event.target.closest('.modal-cancel')) closeModal(); });
window.addEventListener('hashchange', renderRoute);
renderRoute();
bootstrapDatabase();
