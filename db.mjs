import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getRuleFieldErrors, isRuleItemComplete, RULE_AUDIT_ITEMS, RULE_REQUIRED_APPROVALS } from './rule-policy.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(rootDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const database = new DatabaseSync(process.env.PUZARCHIVE_DB_PATH || path.join(dataDir, 'puzarchive.sqlite'));

database.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS puzzles (
    id INTEGER PRIMARY KEY,
    number INTEGER NOT NULL UNIQUE,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    author TEXT NOT NULL,
    source TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    rules TEXT NOT NULL DEFAULT '',
    input_mode TEXT NOT NULL DEFAULT 'external',
    answer TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    scope TEXT NOT NULL DEFAULT 'public',
    rule_id INTEGER,
    suggested_date TEXT,
    submitted_by TEXT
  );

  CREATE TABLE IF NOT EXISTS puzzle_ratings (
    id INTEGER PRIMARY KEY,
    puzzle_id INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    logic INTEGER NOT NULL CHECK (logic BETWEEN 1 AND 5),
    intuition INTEGER NOT NULL CHECK (intuition BETWEEN 1 AND 5),
    enjoyment INTEGER NOT NULL CHECK (enjoyment BETWEEN 1 AND 5),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (puzzle_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS puzzle_completions (
    puzzle_id INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (puzzle_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    puzzle_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    year INTEGER,
    ib TEXT NOT NULL DEFAULT '',
    pb TEXT NOT NULL DEFAULT '',
    sb TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS collection_puzzles (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    puzzle_id INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (collection_id, puzzle_id)
  );

  CREATE TABLE IF NOT EXISTS puzzle_tags (
    puzzle_id INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (puzzle_id, tag)
  );

  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY,
    title_zh TEXT NOT NULL,
    title_en TEXT NOT NULL,
    rules_zh TEXT NOT NULL,
    rules_en TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('涂黑','填数','分区','置物','路径','其它')),
    is_variant INTEGER NOT NULL CHECK (is_variant IN (0,1)),
    base_rule_id INTEGER REFERENCES rules(id),
    example_url TEXT NOT NULL DEFAULT '',
    example_author TEXT NOT NULL DEFAULT '',
    name_revision INTEGER NOT NULL DEFAULT 1,
    description_revision INTEGER NOT NULL DEFAULT 1,
    example_revision INTEGER NOT NULL DEFAULT 1,
    edit_version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS member_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trusted_users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    access_code_hash TEXT NOT NULL DEFAULT '',
    username TEXT,
    username_key TEXT,
    password_hash TEXT,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS auth_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS registration_gate (
    id INTEGER PRIMARY KEY CHECK (id=1),
    token_hash TEXT NOT NULL UNIQUE,
    pending_legacy_user_id TEXT REFERENCES trusted_users(id),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS rule_item_revisions (
    rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    item TEXT NOT NULL CHECK(item IN ('name','description','example')),
    revision INTEGER NOT NULL CHECK(revision>0),
    content_json TEXT NOT NULL,
    changed_by_user_id TEXT REFERENCES trusted_users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(rule_id,item,revision)
  );
  CREATE TABLE IF NOT EXISTS rule_item_votes (
    rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    item TEXT NOT NULL CHECK(item IN ('name','description','example')),
    revision INTEGER NOT NULL CHECK(revision>0),
    user_id TEXT NOT NULL REFERENCES trusted_users(id),
    decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
    suggestion TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(rule_id,item,revision,user_id)
  );
  CREATE TABLE IF NOT EXISTS rule_item_audit_events (
    id INTEGER PRIMARY KEY,
    rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    item TEXT NOT NULL CHECK(item IN ('name','description','example')),
    revision INTEGER NOT NULL CHECK(revision>0),
    user_id TEXT NOT NULL REFERENCES trusted_users(id),
    decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
    suggestion TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Additive migration for databases created by the original prototype.
const puzzleColumns = new Set(database.prepare('PRAGMA table_info(puzzles)').all().map((column) => column.name));
for (const [name, definition] of [['scope', "TEXT NOT NULL DEFAULT 'public'"], ['rule_id', 'INTEGER'], ['suggested_date', 'TEXT'], ['submitted_by', 'TEXT']]) {
  if (!puzzleColumns.has(name)) database.exec(`ALTER TABLE puzzles ADD COLUMN ${name} ${definition}`);
}
const trustedUserColumns = new Set(database.prepare('PRAGMA table_info(trusted_users)').all().map((column)=>column.name));
if (!trustedUserColumns.has('access_code_hash')) database.exec("ALTER TABLE trusted_users ADD COLUMN access_code_hash TEXT NOT NULL DEFAULT ''");
for (const [name, definition] of [['username', 'TEXT'], ['username_key', 'TEXT'], ['password_hash', 'TEXT'], ['is_active', 'INTEGER NOT NULL DEFAULT 1']]) {
  if (!trustedUserColumns.has(name)) database.exec(`ALTER TABLE trusted_users ADD COLUMN ${name} ${definition}`);
}
database.exec("CREATE UNIQUE INDEX IF NOT EXISTS trusted_users_username_key ON trusted_users(username_key) WHERE username_key IS NOT NULL");
const ruleColumns=new Set(database.prepare('PRAGMA table_info(rules)').all().map((column)=>column.name));
for (const [name,definition] of [['example_url',"TEXT NOT NULL DEFAULT ''"],['example_author',"TEXT NOT NULL DEFAULT ''"],['name_revision','INTEGER NOT NULL DEFAULT 1'],['description_revision','INTEGER NOT NULL DEFAULT 1'],['example_revision','INTEGER NOT NULL DEFAULT 1'],['edit_version','INTEGER NOT NULL DEFAULT 1']]) {
  if (!ruleColumns.has(name)) database.exec(`ALTER TABLE rules ADD COLUMN ${name} ${definition}`);
}
const seedRuleRevision=database.prepare(`INSERT OR IGNORE INTO rule_item_revisions(rule_id,item,revision,content_json)
  VALUES (?,?,?,?)`);
for (const row of database.prepare('SELECT * FROM rules').all()) {
  seedRuleRevision.run(row.id,'name',row.name_revision,JSON.stringify({titleZh:row.title_zh,titleEn:row.title_en}));
  seedRuleRevision.run(row.id,'description',row.description_revision,JSON.stringify({rulesZh:JSON.parse(row.rules_zh),rulesEn:JSON.parse(row.rules_en),isVariant:Boolean(row.is_variant),baseRuleId:row.base_rule_id}));
  seedRuleRevision.run(row.id,'example',row.example_revision,JSON.stringify({exampleUrl:row.example_url,exampleAuthor:row.example_author??''}));
}

const puzzleCount = database.prepare('SELECT COUNT(*) AS count FROM puzzles').get().count;
if (puzzleCount === 0) {
  const insertPuzzle = database.prepare(`INSERT INTO puzzles
    (number, title, type, author, source, url, note, rules, input_mode, answer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const seedPuzzles = [
    [128, 'Thermometer', '逻辑题', 'Mina K.', 'puzz.link', 'https://puzz.link/', '一组温度计交错在网格中。填满它们时，注意每支温度计的方向。', '每支温度计必须从球形端开始连续填满，直到边界或另一支温度计。', 'external', ''],
    [127, 'Five Cells', '逻辑题', 'Yusuke', 'puzz.link', 'https://puzz.link/', '每一块区域都恰好包含五个格子。相邻区域的边界会告诉你下一步。', '将盘面分成每块五格的区域，线条不得形成面积不符的闭合区域。', 'external', ''],
    [126, 'Wordoku No. 03', '文字题', 'Katherine L.', 'penpa+', 'https://penpa-edit.com/', '字母替代数字的经典数独变体，词语会给出额外线索。', '每行、每列和每个宫内都不得重复字母。', 'external', ''],
    [125, 'The Wrong Puzzle', '逻辑题', 'Lumen', '填空题', '', '这是一个故意写错的谜题。先找到规则中的不一致，再开始解题。', '找出题面中的矛盾，并在答案框写下导致矛盾的规则。', 'blank', '规则 3'],
    [124, 'Arrow Maze', '逻辑题', 'Mori', 'puzz.link', 'https://puzz.link/', '沿箭头方向走过每个格子，每一步都会缩小下一步的选择。', '从起点出发，遵守箭头方向访问全部格子且不重复。', 'external', ''],
    [123, 'Regional Sudoku', '逻辑题', 'Aster', 'puzz.link', 'https://puzz.link/', '区域边界会在标准数独之外制造新的关系。', '每行、每列和每个不规则区域都填入 1 至 9。', 'external', ''],
    [122, 'Kakuro Evening', '逻辑题', 'Mina K.', 'puzz.link', 'https://puzz.link/', '适合周末晚上慢慢完成的一题。', '每段数字不得重复，并满足左上角的和。', 'external', ''],
    [121, 'Letter Loop', '文字题', 'Yusuke', '填空题', '', '将字母线索串成一个没有断点的循环。', '根据线索填入一个闭合的字母序列。', 'blank', 'ARCHIVE']
  ];
  database.exec('BEGIN');
  for (const puzzle of seedPuzzles) insertPuzzle.run(...puzzle);
  database.exec('COMMIT');

  const insertRating = database.prepare(`INSERT INTO puzzle_ratings
    (puzzle_id, user_id, logic, intuition, enjoyment) SELECT id, ?, ?, ?, ? FROM puzzles WHERE number = ?`);
  const seedRatings = [
    ['seed-thermometer', 3, 2, 5, 128], ['seed-five-cells', 4, 4, 5, 127],
    ['seed-wordoku', 2, 4, 4, 126], ['seed-wrong', 5, 4, 5, 125],
    ['seed-arrow', 3, 3, 4, 124], ['seed-sudoku', 4, 3, 5, 123],
    ['seed-kakuro', 3, 2, 4, 122], ['seed-letter', 4, 4, 4, 121]
  ];
  for (const rating of seedRatings) insertRating.run(...rating);
  database.prepare(`INSERT OR IGNORE INTO puzzle_completions (puzzle_id, user_id)
    SELECT id, ? FROM puzzles WHERE number IN (127, 125, 123)`).run('demo-user');
  const insertFolder = database.prepare('INSERT INTO folders (name, puzzle_count) VALUES (?, ?)');
  for (const folder of [['Logic Masters India', 38], ['日本パズル協会', 24], ['个人收藏', 17]]) insertFolder.run(...folder);

}

// This migration also runs for databases created by the earlier prototype.
const collectionCount = database.prepare('SELECT COUNT(*) AS count FROM collections').get().count;
if (collectionCount === 0) {
  const insertCollection = database.prepare(`INSERT INTO collections (name, description, source, year, ib, pb, sb) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insertCollection.run("New Year's Puzzle Exchange", '来自 6 位作者的交换题目，适合周末集中完成。', 'PuzArchive community', 2026, 'Original invitation booklet', 'Puzzle booklet 01', 'Solution booklet 01');
  insertCollection.run('Paper & Pencil / Vol. 01', '纸笔谜题的第一册精选。', '日本パズル協会', 2025, 'Invitation booklet', 'Paper booklet 01', 'Solutions 01');
  const collectionIds = database.prepare('SELECT id FROM collections ORDER BY id').all();
  const puzzleIds = database.prepare('SELECT id FROM puzzles ORDER BY number DESC').all();
  const linkCollectionPuzzle = database.prepare('INSERT OR IGNORE INTO collection_puzzles (collection_id, puzzle_id, position) VALUES (?, ?, ?)');
  for (const [index, puzzle] of puzzleIds.entries()) linkCollectionPuzzle.run(collectionIds[index % collectionIds.length].id, puzzle.id, index + 1);
}

const tagCount = database.prepare('SELECT COUNT(*) AS count FROM puzzle_tags').get().count;
if (tagCount === 0) {
  const seedTags = new Map([
    [128, ['Thermometer', 'Example Puzzle']], [127, ['Five Cells']], [126, ['Wordoku']],
    [125, ['Wrong Puzzle', 'Meta']], [124, ['Arrow Maze', 'Example Puzzle']], [123, ['Sudoku']],
    [122, ['Kakuro']], [121, ['Word', 'Example Puzzle']]
  ]);
  const insertTag = database.prepare('INSERT OR IGNORE INTO puzzle_tags (puzzle_id, tag) SELECT id, ? FROM puzzles WHERE number = ?');
  for (const [number, tags] of seedTags) for (const tag of tags) insertTag.run(tag, number);
}

export function getPuzzles(userId = 'demo-user') {
  const rows = database.prepare(`
    SELECT p.*,
      EXISTS (SELECT 1 FROM puzzle_completions c WHERE c.puzzle_id = p.id AND c.user_id = ?) AS completed,
      COALESCE(ROUND(AVG(r.logic), 1), 0) AS logic_rating,
      COALESCE(ROUND(AVG(r.intuition), 1), 0) AS intuition_rating,
      COALESCE(ROUND(AVG(r.enjoyment), 1), 0) AS enjoyment_rating,
      COUNT(r.id) AS votes,
      (SELECT json_object('logic', r2.logic, 'intuition', r2.intuition, 'enjoyment', r2.enjoyment)
       FROM puzzle_ratings r2 WHERE r2.puzzle_id = p.id AND r2.user_id = ?) AS user_rating,
      (SELECT json_group_array(pt.tag) FROM puzzle_tags pt WHERE pt.puzzle_id = p.id) AS tags
    FROM puzzles p LEFT JOIN puzzle_ratings r ON r.puzzle_id = p.id
    WHERE p.scope = 'public'
    GROUP BY p.id ORDER BY p.number DESC
  `).all(userId, userId);
  return rows.map((row) => ({
    number: row.number,
    title: row.title,
    type: row.type,
    author: row.author,
    source: row.source,
    url: row.url,
    note: row.note,
    rules: row.rules,
    inputMode: row.input_mode,
    answer: row.answer,
    completed: Boolean(row.completed),
    ratings: [Number(row.logic_rating), Number(row.intuition_rating), Number(row.enjoyment_rating)],
    votes: Number(row.votes),
    userRating: row.user_rating ? (() => { const value = JSON.parse(row.user_rating); return [value.logic, value.intuition, value.enjoyment]; })() : null,
    tags: JSON.parse(row.tags || JSON.stringify([row.input_mode === 'blank' ? '填空题' : row.type]))
  }));
}

export function addPuzzle(input) {
  const nextNumber = database.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS number FROM puzzles').get().number;
  const result = database.prepare(`INSERT INTO puzzles
    (number, title, type, author, source, url, note, rules, input_mode, answer, rule_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nextNumber, input.title, input.type, input.author, input.source, input.url || '', input.note || '等待作者补充说明。', input.rules || '等待作者补充规则。', input.inputMode, input.answer || '', input.ruleId);
  return Number(result.lastInsertRowid);
}

const ruleFromRow = (row) => row && ({
  id: row.id, titleZh: row.title_zh, titleEn: row.title_en,
  rulesZh: JSON.parse(row.rules_zh), rulesEn: JSON.parse(row.rules_en),
  category: row.category, isVariant: Boolean(row.is_variant), baseRuleId: row.base_rule_id,
  exampleUrl: row.example_url, exampleAuthor: row.example_author ?? '',
  editVersion: row.edit_version,
  revisions: {name:row.name_revision,description:row.description_revision,example:row.example_revision},
  ...(row.base_title_zh ? { baseRuleTitleZh: row.base_title_zh } : {}),
  ...(row.base_title_en ? { baseRuleTitleEn: row.base_title_en } : {})
});

function contentForRule(rule,item) {
  if (item==='name') return {titleZh:rule.titleZh,titleEn:rule.titleEn};
  if (item==='description') return {rulesZh:rule.rulesZh,rulesEn:rule.rulesEn,isVariant:rule.isVariant,baseRuleId:rule.baseRuleId};
  return {exampleUrl:rule.exampleUrl,exampleAuthor:rule.exampleAuthor??''};
}
function attachRuleQuality(rule,userId) {
  if (!rule) return null;
  const errors=getRuleFieldErrors(rule);
  const fieldNames={name:'名称',description:'说明',example:'例题'};
  const groups={};
  for (const item of RULE_AUDIT_ITEMS) {
    const revision=rule.revisions[item];
    const currentReviews=database.prepare(`SELECT v.user_id AS userId,u.name,u.username,v.decision,v.suggestion,v.updated_at AS updatedAt,
        (u.is_active=1 AND u.username IS NOT NULL AND u.password_hash IS NOT NULL) AS active
      FROM rule_item_votes v JOIN trusted_users u ON u.id=v.user_id
      WHERE v.rule_id=? AND v.item=? AND v.revision=? ORDER BY v.created_at,v.user_id`).all(rule.id,item,revision).map((review)=>({...review,active:Boolean(review.active)}));
    const history=database.prepare(`SELECT e.user_id AS userId,u.name,u.username,e.revision,e.decision,e.suggestion,e.created_at AS createdAt
      FROM rule_item_audit_events e JOIN trusted_users u ON u.id=e.user_id
      WHERE e.rule_id=? AND e.item=? ORDER BY e.id`).all(rule.id,item);
    const revisions=database.prepare(`SELECT r.revision,r.content_json AS content,r.changed_by_user_id AS changedByUserId,u.name AS changedByName,u.username AS changedByUsername,r.created_at AS createdAt
      FROM rule_item_revisions r LEFT JOIN trusted_users u ON u.id=r.changed_by_user_id
      WHERE r.rule_id=? AND r.item=? ORDER BY r.revision`).all(rule.id,item).map((row)=>({
      revision:row.revision,content:(()=>{const content=JSON.parse(row.content);if(item==='example'&&!Object.hasOwn(content,'exampleAuthor'))content.exampleAuthor='';return content;})(),
        changedBy:row.changedByUserId?{userId:row.changedByUserId,name:row.changedByName,username:row.changedByUsername}:null,
        createdAt:row.createdAt
      }));
    const rejected=currentReviews.some((review)=>review.decision==='reject');
    const complete=isRuleItemComplete(rule,item);
    const approvalCount=currentReviews.filter((review)=>review.decision==='approve'&&review.active).length;
    const status=rejected?'rejected':!complete?'incomplete':approvalCount>=RULE_REQUIRED_APPROVALS?'approved':'pending';
    const rejectionSuggestion=[...currentReviews].reverse().find((review)=>review.decision==='reject')?.suggestion||'';
    groups[item]={revision,status,approvalCount,requiredApprovals:RULE_REQUIRED_APPROVALS,rejected,
      reviewedByCurrentUser:Boolean(userId&&currentReviews.some((review)=>review.userId===userId)),
      currentReviews,history,revisions,rejectionSuggestion};
    if (rejected) errors.push({code:'auditRejected',item,message:`审计未通过：${fieldNames[item]}`});
  }
  const warnings=[];
  for (const item of RULE_AUDIT_ITEMS) {
    if (groups[item].status!=='approved') warnings.push({code:`${item}NotFullyAudited`,item,message:`${fieldNames[item]}尚未完成三人审计`});
  }
  return {...rule,quality:{errors,warnings,groups}};
}
function selectRule(id) {
  return ruleFromRow(database.prepare(`SELECT r.*, b.title_zh AS base_title_zh, b.title_en AS base_title_en
    FROM rules r LEFT JOIN rules b ON b.id = r.base_rule_id WHERE r.id = ?`).get(id));
}
export function getRules(userId=null) {
  return database.prepare('SELECT id FROM rules ORDER BY id').all().map(({id})=>attachRuleQuality(selectRule(id),userId));
}
export function getRule(id,userId=null) { return attachRuleQuality(selectRule(id),userId); }
export function ruleHasVariants(id) { return Boolean(database.prepare('SELECT 1 FROM rules WHERE base_rule_id=? LIMIT 1').get(id)); }

export function addRule(input,userId) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result=database.prepare(`INSERT INTO rules (title_zh,title_en,rules_zh,rules_en,category,is_variant,base_rule_id,example_url,example_author)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(input.titleZh,input.titleEn,JSON.stringify(input.rulesZh),JSON.stringify(input.rulesEn),input.category,input.isVariant?1:0,input.baseRuleId,input.exampleUrl,input.exampleAuthor??'');
    const id=Number(result.lastInsertRowid);
    const save=database.prepare(`INSERT INTO rule_item_revisions(rule_id,item,revision,content_json,changed_by_user_id)
      VALUES (?,?,1,?,?)`);
    for (const item of RULE_AUDIT_ITEMS) save.run(id,item,JSON.stringify(contentForRule(input,item)),userId);
    database.exec('COMMIT');
    return getRule(id,userId);
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}

export function updateRule(id,input,userId,expectedRevisions) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const current=ruleFromRow(database.prepare('SELECT * FROM rules WHERE id=?').get(id));
    if (!current) { database.exec('ROLLBACK'); return {error:'missing'}; }
    const next={...current,...input};
    const changedItems=RULE_AUDIT_ITEMS.filter((item)=>JSON.stringify(contentForRule(current,item))!==JSON.stringify(contentForRule(next,item)));
    if (expectedRevisions?.expectedEditVersion!==current.editVersion||RULE_AUDIT_ITEMS.some((item)=>expectedRevisions[item]!==current.revisions[item])) { database.exec('ROLLBACK'); return {error:'stale'}; }
    const nextRevisions={...current.revisions};
    for (const item of changedItems) nextRevisions[item]+=1;
    const changed=changedItems.length>0||current.category!==next.category;
    database.prepare(`UPDATE rules SET title_zh=?,title_en=?,rules_zh=?,rules_en=?,category=?,is_variant=?,base_rule_id=?,example_url=?,example_author=?,
      name_revision=?,description_revision=?,example_revision=?,edit_version=? WHERE id=?`)
      .run(next.titleZh,next.titleEn,JSON.stringify(next.rulesZh),JSON.stringify(next.rulesEn),next.category,next.isVariant?1:0,next.baseRuleId,next.exampleUrl,next.exampleAuthor??'',
        nextRevisions.name,nextRevisions.description,nextRevisions.example,current.editVersion+(changed?1:0),id);
    const save=database.prepare(`INSERT INTO rule_item_revisions(rule_id,item,revision,content_json,changed_by_user_id)
      VALUES (?,?,?,?,?)`);
    for (const item of changedItems) save.run(id,item,nextRevisions[item],JSON.stringify(contentForRule(next,item)),userId);
    database.exec('COMMIT');
    return {rule:getRule(id,userId),changedItems,changed};
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}

export function submitRuleAudit(id,item,decision,suggestion,revision,userId) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const row=database.prepare('SELECT * FROM rules WHERE id=?').get(id);
    if (!row) { database.exec('ROLLBACK'); return {error:'missing'}; }
    const current=ruleFromRow(row);
    if (!RULE_AUDIT_ITEMS.includes(item)||revision!==current.revisions[item]) { database.exec('ROLLBACK'); return {error:'stale'}; }
    if (decision!=='approve'&&decision!=='reject') { database.exec('ROLLBACK'); return {error:'invalid'}; }
    if (decision==='approve'&&!isRuleItemComplete(current,item)) { database.exec('ROLLBACK'); return {error:'incomplete'}; }
    const existing=database.prepare('SELECT decision,suggestion FROM rule_item_votes WHERE rule_id=? AND item=? AND revision=? AND user_id=?').get(id,item,revision,userId);
    const anyRejection=database.prepare("SELECT 1 FROM rule_item_votes WHERE rule_id=? AND item=? AND revision=? AND decision='reject' LIMIT 1").get(id,item,revision);
    if (existing?.decision==='reject'&&decision!=='reject') { database.exec('ROLLBACK'); return {error:'sticky'}; }
    if (anyRejection&&!existing&&decision==='approve') { database.exec('ROLLBACK'); return {error:'rejected'}; }
    if (existing&&existing.decision===decision&&existing.suggestion===suggestion) {
      database.exec('COMMIT');
      return {rule:getRule(id,userId),changed:false};
    }
    if (existing&&existing.decision==='approve'&&decision==='approve') {
      database.exec('COMMIT');
      return {rule:getRule(id,userId),changed:false};
    }
    const now=new Date().toISOString();
    if (existing) database.prepare(`UPDATE rule_item_votes SET decision=?,suggestion=?,updated_at=?
      WHERE rule_id=? AND item=? AND revision=? AND user_id=?`).run(decision,suggestion,now,id,item,revision,userId);
    else database.prepare(`INSERT INTO rule_item_votes(rule_id,item,revision,user_id,decision,suggestion,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(id,item,revision,userId,decision,suggestion,now);
    database.prepare(`INSERT INTO rule_item_audit_events(rule_id,item,revision,user_id,decision,suggestion,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(id,item,revision,userId,decision,suggestion,now);
    database.exec('COMMIT');
    return {rule:getRule(id,userId),changed:true};
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}

function puzzleByNumber(number, userId, scope) {
  const row = database.prepare(`SELECT p.*,
      EXISTS (SELECT 1 FROM puzzle_completions c WHERE c.puzzle_id = p.id AND c.user_id = ?) AS completed,
      COALESCE(ROUND(AVG(r.logic),1),0) AS logic_rating, COALESCE(ROUND(AVG(r.intuition),1),0) AS intuition_rating,
      COALESCE(ROUND(AVG(r.enjoyment),1),0) AS enjoyment_rating, COUNT(r.id) AS votes,
      (SELECT json_object('logic',r2.logic,'intuition',r2.intuition,'enjoyment',r2.enjoyment) FROM puzzle_ratings r2 WHERE r2.puzzle_id=p.id AND r2.user_id=?) AS user_rating,
      (SELECT json_group_array(pt.tag) FROM puzzle_tags pt WHERE pt.puzzle_id=p.id) AS tags,
      u.name AS submitter_name
    FROM puzzles p LEFT JOIN puzzle_ratings r ON r.puzzle_id=p.id
    LEFT JOIN trusted_users u ON u.id=p.submitted_by
    WHERE p.number=? AND p.scope=? GROUP BY p.id`).get(userId,userId,number,scope);
  if (!row) return null;
  const rule = row.rule_id ? getRule(row.rule_id) : null;
  const puzzle = {
    number: row.number, title: row.title, type: row.type, author: row.author, source: row.source,
    url: row.url, note: row.note, rules: row.rules, inputMode: row.input_mode, answer: row.answer,
    completed: Boolean(row.completed), ratings: [Number(row.logic_rating),Number(row.intuition_rating),Number(row.enjoyment_rating)],
    votes: Number(row.votes), userRating: row.user_rating ? (()=>{const v=JSON.parse(row.user_rating);return [v.logic,v.intuition,v.enjoyment]})() : null,
    tags: JSON.parse(row.tags || '[]')
  };
  if (scope === 'calendar') {
    puzzle.scope = 'calendar'; puzzle.ruleId = row.rule_id; puzzle.rule = rule;
    puzzle.suggestedDate = row.suggested_date; puzzle.submittedBy = { id: row.submitted_by, name: row.submitter_name || '' };
  }
  return puzzle;
}

export function getCalendarPuzzles(userId) {
  const rows = database.prepare("SELECT number FROM puzzles WHERE scope='calendar' ORDER BY COALESCE(suggested_date,'9999-12-31'), number DESC").all();
  return rows.map(({number}) => puzzleByNumber(number,userId,'calendar'));
}
export function getCalendarPuzzle(number,userId) { return puzzleByNumber(number,userId,'calendar'); }
export function addCalendarPuzzle(input,user) {
  const rule = getRule(input.ruleId);
  if (!rule) throw new Error('invalid rule');
  const next = database.prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM puzzles').get().n;
  const result = database.prepare(`INSERT INTO puzzles (number,title,type,author,source,url,note,rules,input_mode,answer,scope,rule_id,suggested_date,submitted_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,'calendar',?,?,?)`).run(next,input.title.trim(),rule.category,input.author.trim(),input.source.trim(),input.url || '',input.note || '',rule.rulesZh.join('\n'),'external'===input.inputMode?'external':'blank',input.inputMode==='blank'?(input.answer||''):'',input.ruleId,input.suggestedDate || null,user.id);
  return { id: Number(result.lastInsertRowid), puzzle: getCalendarPuzzle(next,user.id) };
}
export function updateCalendarSuggestedDate(number,userId,date) {
  const row = database.prepare("SELECT id,submitted_by FROM puzzles WHERE number=? AND scope='calendar'").get(number);
  if (!row) return {missing:true};
  if (row.submitted_by !== userId) return {forbidden:true};
  database.prepare('UPDATE puzzles SET suggested_date=? WHERE id=?').run(date || null,row.id);
  return {puzzle:getCalendarPuzzle(number,userId)};
}
export function calendarPuzzleExists(number) { return Boolean(database.prepare("SELECT 1 FROM puzzles WHERE number=? AND scope='calendar'").get(number)); }

export function completeAndRate(number, userId, ratings, scope = 'public') {
  const puzzle = database.prepare('SELECT id FROM puzzles WHERE number = ? AND scope = ?').get(number, scope);
  if (!puzzle) return false;
  database.prepare('INSERT OR REPLACE INTO puzzle_completions (puzzle_id, user_id) VALUES (?, ?)').run(puzzle.id, userId);
  database.prepare(`INSERT INTO puzzle_ratings (puzzle_id, user_id, logic, intuition, enjoyment)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(puzzle_id, user_id) DO UPDATE SET
    logic = excluded.logic, intuition = excluded.intuition, enjoyment = excluded.enjoyment, created_at = CURRENT_TIMESTAMP`)
    .run(puzzle.id, userId, ratings[0], ratings[1], ratings[2]);
}

export function getFolders() { return database.prepare('SELECT id, name, parent_id AS parent, puzzle_count AS count FROM folders ORDER BY name').all(); }
export function addFolder(name, parentId = null) { const result = database.prepare('INSERT INTO folders (name, parent_id) VALUES (?, ?)').run(name, parentId || null); return Number(result.lastInsertRowid); }
export function addPuzzleTag(number, tag, scope = 'public') { const result = database.prepare('INSERT OR IGNORE INTO puzzle_tags (puzzle_id, tag) SELECT id, ? FROM puzzles WHERE number = ? AND scope = ?').run(tag, number, scope); return result.changes > 0; }
export function getTags() { return database.prepare("SELECT pt.tag, COUNT(*) AS count FROM puzzle_tags pt JOIN puzzles p ON p.id=pt.puzzle_id WHERE p.scope='public' GROUP BY pt.tag ORDER BY count DESC, pt.tag").all(); }

export function getCollections() {
  return database.prepare(`SELECT c.id, c.name, c.description, c.source, c.year, c.ib, c.pb, c.sb,
    COUNT(cp.puzzle_id) AS puzzle_count
    FROM collections c LEFT JOIN collection_puzzles cp ON cp.collection_id = c.id
    GROUP BY c.id ORDER BY c.year DESC, c.id`).all();
}

export function getCollection(id, userId = 'demo-user') {
  const collection = database.prepare('SELECT id, name, description, source, year, ib, pb, sb FROM collections WHERE id = ?').get(id);
  if (!collection) return null;
  const puzzles = database.prepare(`SELECT p.number, p.title, p.type, p.author, p.source, p.url, p.input_mode AS inputMode,
    EXISTS (SELECT 1 FROM puzzle_completions c WHERE c.puzzle_id = p.id AND c.user_id = ?) AS completed,
    COALESCE(ROUND(AVG(r.logic), 1), 0) AS logic_rating,
    COALESCE(ROUND(AVG(r.intuition), 1), 0) AS intuition_rating,
    COALESCE(ROUND(AVG(r.enjoyment), 1), 0) AS enjoyment_rating,
    COUNT(r.id) AS votes, cp.position
    FROM collection_puzzles cp JOIN puzzles p ON p.id = cp.puzzle_id
    LEFT JOIN puzzle_ratings r ON r.puzzle_id = p.id
    WHERE cp.collection_id = ? GROUP BY p.id, cp.position ORDER BY cp.position`).all(userId, id);
  return { ...collection, puzzles: puzzles.map((puzzle) => ({ ...puzzle, completed: Boolean(puzzle.completed), ratings: [Number(puzzle.logic_rating), Number(puzzle.intuition_rating), Number(puzzle.enjoyment_rating)], votes: Number(puzzle.votes) })) };
}

export function upsertTrustedUser(id,name,accessCodeHash) {
  const existing=database.prepare('SELECT access_code_hash FROM trusted_users WHERE id=?').get(id);
  if (existing && existing.access_code_hash && existing.access_code_hash!==accessCodeHash) database.prepare('DELETE FROM member_sessions WHERE user_id=?').run(id);
  database.prepare('INSERT INTO trusted_users(id,name,access_code_hash) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,access_code_hash=excluded.access_code_hash').run(id,name,accessCodeHash);
}
export function retainTrustedUsers(ids) {
  const placeholders=ids.map(()=>'?').join(',');
  database.prepare(`DELETE FROM member_sessions WHERE user_id NOT IN (${placeholders})`).run(...ids);
  database.prepare(`DELETE FROM trusted_users WHERE id NOT IN (${placeholders})`).run(...ids);
}
export function authBootstrapComplete() {
  return Boolean(database.prepare('SELECT version FROM auth_schema_migrations WHERE version=1').get());
}
export function bootstrapLegacyAuth(members) {
  if (members.length!==1) throw new Error('Auth migration requires exactly one current legacy member as the shared registration-code source');
  database.exec('BEGIN IMMEDIATE');
  try {
    if (authBootstrapComplete()) {
      database.exec('COMMIT');
      return false;
    }
    const upsert = database.prepare(`INSERT INTO trusted_users(id,name,access_code_hash)
      VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,access_code_hash=excluded.access_code_hash`);
    for (const member of members) upsert.run(member.id,member.name,member.accessCodeHash);
    if (members.length) database.prepare(`INSERT OR IGNORE INTO registration_gate(id,token_hash,pending_legacy_user_id)
      VALUES (1,?,?)`).run(members[0].accessCodeHash,members[0].id);
    if (members.length) {
      const placeholders=members.map(()=>'?').join(',');
      database.prepare(`UPDATE trusted_users SET is_active=0 WHERE id NOT IN (${placeholders})`).run(...members.map((member)=>member.id));
    } else database.prepare('UPDATE trusted_users SET is_active=0').run();
    database.prepare('UPDATE trusted_users SET access_code_hash=\'\'').run();
    database.prepare('DELETE FROM member_sessions').run();
    database.prepare('INSERT INTO auth_schema_migrations(version) VALUES (1)').run();
    database.exec('COMMIT');
    return true;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
export function findUserByUsernameKey(usernameKey) {
  const user=database.prepare(`SELECT id,name,username,username_key,password_hash,is_active
    FROM trusted_users WHERE username_key=?`).get(usernameKey);
  return user?{id:user.id,name:user.name,username:user.username,usernameKey:user.username_key,passwordHash:user.password_hash,active:Boolean(user.is_active)}:null;
}
export function registerAccountWithGate(gateTokenHash,username,usernameKey,passwordHash,sessionTokenHash,expiresAt) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const gate=database.prepare('SELECT token_hash,pending_legacy_user_id FROM registration_gate WHERE id=1').get();
    let validGate=false;
    if (gate && /^[a-f0-9]{64}$/.test(gate.token_hash) && /^[a-f0-9]{64}$/.test(gateTokenHash)) {
      validGate=timingSafeEqual(Buffer.from(gate.token_hash,'hex'),Buffer.from(gateTokenHash,'hex'));
    }
    if (!validGate) { database.exec('ROLLBACK'); return {error:'gate'}; }
    if (database.prepare('SELECT 1 FROM trusted_users WHERE username_key=?').get(usernameKey)) {
      database.exec('ROLLBACK');
      return {error:'username'};
    }
    let userId=randomUUID(), userName=username;
    if (gate.pending_legacy_user_id) {
      userId=gate.pending_legacy_user_id;
      const legacyUser=database.prepare(`SELECT name FROM trusted_users WHERE id=? AND is_active=1
        AND username_key IS NULL AND password_hash IS NULL`).get(userId);
      if (!legacyUser) { database.exec('ROLLBACK'); return {error:'gate'}; }
      userName=legacyUser.name;
      const claim=database.prepare(`UPDATE trusted_users SET username=?,username_key=?,password_hash=?
        WHERE id=? AND username_key IS NULL AND password_hash IS NULL AND is_active=1`)
        .run(username,usernameKey,passwordHash,userId);
      if (claim.changes!==1) { database.exec('ROLLBACK'); return {error:'gate'}; }
      database.prepare('UPDATE registration_gate SET pending_legacy_user_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=1').run();
    } else {
      database.prepare(`INSERT INTO trusted_users(id,name,username,username_key,password_hash,is_active)
        VALUES (?,?,?,?,?,1)`).run(userId,userName,username,usernameKey,passwordHash);
    }
    database.prepare('INSERT INTO member_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(sessionTokenHash,userId,expiresAt);
    database.exec('COMMIT');
    return {user:{id:userId,name:userName,username}};
  } catch (error) {
    database.exec('ROLLBACK');
    if (String(error.code||'').startsWith('SQLITE_CONSTRAINT')) return {error:'username'};
    throw error;
  }
}
export function setRegistrationGate(tokenHash) {
  database.prepare(`INSERT INTO registration_gate(id,token_hash) VALUES (1,?)
    ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,updated_at=CURRENT_TIMESTAMP`).run(tokenHash);
}
export function disableRegistrationGate() {
  return database.prepare("UPDATE registration_gate SET token_hash='',updated_at=CURRENT_TIMESTAMP WHERE id=1").run().changes>0;
}
export function revokeAccount(usernameKey) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const user=database.prepare('SELECT id FROM trusted_users WHERE username_key=?').get(usernameKey);
    if (!user) { database.exec('ROLLBACK'); return false; }
    database.prepare('UPDATE trusted_users SET is_active=0 WHERE id=?').run(user.id);
    database.prepare('DELETE FROM member_sessions WHERE user_id=?').run(user.id);
    database.exec('COMMIT');
    return true;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
export function createSession(tokenHash,userId,expiresAt) { database.prepare('INSERT INTO member_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(tokenHash,userId,expiresAt); }
export function findSession(tokenHash,now=Date.now()) {
  const session=database.prepare(`SELECT u.id,u.name,u.username,s.expires_at,u.is_active,u.password_hash
    FROM member_sessions s JOIN trusted_users u ON u.id=s.user_id WHERE s.token_hash=?`).get(tokenHash);
  if (!session || session.expires_at <= now || !session.is_active || !session.username || !session.password_hash) { database.prepare('DELETE FROM member_sessions WHERE token_hash=?').run(tokenHash); return null; }
  return {id:session.id,name:session.name,username:session.username};
}
export function deleteSession(tokenHash) { database.prepare('DELETE FROM member_sessions WHERE token_hash=?').run(tokenHash); }
