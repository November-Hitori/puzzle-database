import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {getPuzzleSource,isConcretePuzzlinkPuzzleUrl} from './puzzle-url.mjs';
import { DatabaseSync } from 'node:sqlite';
import { getPenpaGuidelines } from './penpa-guidelines.mjs';
import { annotateQualityErrors, getCalendarArea, normalizeCalendarLinks } from './calendar-workflow-policy.mjs';
import { removeNeutralCalendarReviews } from './calendar-review-migration.mjs';
import {migrateCalendarScores} from './calendar-score-migration.mjs';
import {CALENDAR_LIKING_SCORES,normalizeCalendarVote,calendarVoteValue,storedCalendarVote,summarizeCalendarVotes,getCalendarReviewStatus} from './calendar-review-policy.mjs';
import { getRuleFieldErrors, isRuleItemComplete, RULE_AUDIT_ITEMS, RULE_REQUIRED_APPROVALS } from './rule-policy.mjs';
import { INBOX_TAG_IDS, normalizeInboxTagInput } from './inbox-policy.mjs';

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
    calendar_year INTEGER NOT NULL DEFAULT 2028,
    calendar_status TEXT NOT NULL DEFAULT 'pending',
    review_round INTEGER NOT NULL DEFAULT 1,
    submitted_by TEXT,
    delete_token TEXT NOT NULL DEFAULT '',
    edit_version INTEGER NOT NULL DEFAULT 1
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
    edit_version INTEGER NOT NULL DEFAULT 1,
    delete_token TEXT NOT NULL DEFAULT '',
    creator_user_id TEXT
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
  CREATE TABLE IF NOT EXISTS entity_id_sequences (
    name TEXT PRIMARY KEY,
    next_id INTEGER NOT NULL CHECK(next_id>0)
  );
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

  CREATE TABLE IF NOT EXISTS calendar_review_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS rule_creator_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS calendar_evaluations (
    puzzle_id INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    review_round INTEGER NOT NULL DEFAULT 1 CHECK(review_round>0),
    difficulty INTEGER NOT NULL CHECK(difficulty BETWEEN 1 AND 6),
    tags_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(puzzle_id,user_id,review_round)
  );
  CREATE TABLE IF NOT EXISTS calendar_review_votes (
    puzzle_id INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    review_round INTEGER NOT NULL CHECK(review_round>0),
    user_id TEXT NOT NULL,
    vote TEXT NOT NULL CHECK(vote IN ('support','neutral','oppose','veto')),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(puzzle_id,review_round,user_id)
  );
  CREATE TABLE IF NOT EXISTS calendar_review_vote_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    puzzle_id INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    review_round INTEGER NOT NULL CHECK(review_round>0),
    user_id TEXT NOT NULL,
    vote TEXT NOT NULL CHECK(vote IN ('support','neutral','oppose','veto')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS calendar_review_vote_events_lookup ON calendar_review_vote_events(puzzle_id,review_round,id);
  CREATE TABLE IF NOT EXISTS quality_error_ignores (
    entity_type TEXT NOT NULL CHECK(entity_type IN ('rule','puzzle')),
    entity_id INTEGER NOT NULL,
    error_key TEXT NOT NULL,
    revision INTEGER NOT NULL,
    ignored_by TEXT NOT NULL REFERENCES trusted_users(id),
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(entity_type,entity_id,error_key)
  );
  CREATE TABLE IF NOT EXISTS quality_error_ignore_events (
    id INTEGER PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    error_key TEXT NOT NULL,
    revision INTEGER NOT NULL,
    ignored INTEGER NOT NULL,
    user_id TEXT NOT NULL REFERENCES trusted_users(id),
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS calendar_penpa_votes (
    puzzle_id INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    guidelines_revision TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES trusted_users(id),
    decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
    suggestion TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(puzzle_id,revision,guidelines_revision,user_id)
  );
  CREATE TABLE IF NOT EXISTS calendar_penpa_audit_events (
    id INTEGER PRIMARY KEY,
    puzzle_id INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    guidelines_revision TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES trusted_users(id),
    decision TEXT NOT NULL,
    suggestion TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS calendar_penpa_history_lookup ON calendar_penpa_audit_events(puzzle_id,id);
  CREATE TABLE IF NOT EXISTS calendar_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    puzzle_id INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES trusted_users(id),
    body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS calendar_comments_lookup ON calendar_comments(puzzle_id,id);
  CREATE INDEX IF NOT EXISTS rule_audit_events_lookup ON rule_item_audit_events(rule_id,item,id);
  CREATE TABLE IF NOT EXISTS user_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    read_at TEXT
  );
  CREATE INDEX IF NOT EXISTS user_notifications_inbox ON user_notifications(recipient_user_id,read_at,id DESC);
  CREATE TABLE IF NOT EXISTS user_notification_tags (
    notification_id INTEGER NOT NULL REFERENCES user_notifications(id) ON DELETE CASCADE,
    tag TEXT NOT NULL CHECK(tag IN (${INBOX_TAG_IDS.map((tag)=>`'${tag}'`).join(',')})),
    PRIMARY KEY (notification_id,tag)
  );
`);

const evaluationColumns=new Set(database.prepare('PRAGMA table_info(calendar_evaluations)').all().map((column)=>column.name));
if (!evaluationColumns.has('review_round')) {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`ALTER TABLE calendar_evaluations RENAME TO calendar_evaluations_legacy_round;
      CREATE TABLE calendar_evaluations (
        puzzle_id INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        review_round INTEGER NOT NULL DEFAULT 1 CHECK(review_round>0),
        difficulty INTEGER NOT NULL CHECK(difficulty BETWEEN 1 AND 6),
        tags_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(puzzle_id,user_id,review_round)
      );
      INSERT INTO calendar_evaluations(puzzle_id,user_id,review_round,difficulty,tags_json,updated_at)
        SELECT puzzle_id,user_id,1,difficulty,tags_json,updated_at FROM calendar_evaluations_legacy_round;
      DROP TABLE calendar_evaluations_legacy_round;`);
    database.exec('COMMIT');
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}

// Additive migration for databases created by the original prototype.
const puzzleColumns = new Set(database.prepare('PRAGMA table_info(puzzles)').all().map((column) => column.name));
for (const [name, definition] of [['scope', "TEXT NOT NULL DEFAULT 'public'"], ['rule_id', 'INTEGER'], ['suggested_date', 'TEXT'], ['calendar_year','INTEGER NOT NULL DEFAULT 2028'], ['calendar_status',"TEXT NOT NULL DEFAULT 'pending'"], ['review_round','INTEGER NOT NULL DEFAULT 1'], ['submitted_by', 'TEXT'], ['edit_version','INTEGER NOT NULL DEFAULT 1'], ['penpa_edit_url',"TEXT NOT NULL DEFAULT ''"], ['penpa_solve_url',"TEXT NOT NULL DEFAULT ''"], ['puzzlink_url',"TEXT NOT NULL DEFAULT ''"], ['penpa_revision','INTEGER NOT NULL DEFAULT 1'], ['assigned_date','TEXT'], ['delete_token', "TEXT NOT NULL DEFAULT ''"]]) {
  if (!puzzleColumns.has(name)) database.exec(`ALTER TABLE puzzles ADD COLUMN ${name} ${definition}`);
}
database.exec("UPDATE puzzles SET delete_token=lower(hex(randomblob(16))) WHERE delete_token IS NULL OR delete_token=''");
database.exec('CREATE UNIQUE INDEX IF NOT EXISTS puzzles_delete_token ON puzzles(delete_token)');
const trustedUserColumns = new Set(database.prepare('PRAGMA table_info(trusted_users)').all().map((column)=>column.name));
if (!trustedUserColumns.has('access_code_hash')) database.exec("ALTER TABLE trusted_users ADD COLUMN access_code_hash TEXT NOT NULL DEFAULT ''");
for (const [name, definition] of [['username', 'TEXT'], ['username_key', 'TEXT'], ['password_hash', 'TEXT'], ['is_active', 'INTEGER NOT NULL DEFAULT 1']]) {
  if (!trustedUserColumns.has(name)) database.exec(`ALTER TABLE trusted_users ADD COLUMN ${name} ${definition}`);
}
database.exec("CREATE UNIQUE INDEX IF NOT EXISTS trusted_users_username_key ON trusted_users(username_key) WHERE username_key IS NOT NULL");
const ruleColumns=new Set(database.prepare('PRAGMA table_info(rules)').all().map((column)=>column.name));
for (const [name,definition] of [['example_url',"TEXT NOT NULL DEFAULT ''"],['example_author',"TEXT NOT NULL DEFAULT ''"],['name_revision','INTEGER NOT NULL DEFAULT 1'],['description_revision','INTEGER NOT NULL DEFAULT 1'],['example_revision','INTEGER NOT NULL DEFAULT 1'],['edit_version','INTEGER NOT NULL DEFAULT 1'],['delete_token',"TEXT NOT NULL DEFAULT ''"],['creator_user_id','TEXT']]) {
  if (!ruleColumns.has(name)) database.exec(`ALTER TABLE rules ADD COLUMN ${name} ${definition}`);
}
database.exec("UPDATE rules SET delete_token=lower(hex(randomblob(16))) WHERE delete_token IS NULL OR delete_token=''");
database.exec('CREATE UNIQUE INDEX IF NOT EXISTS rules_delete_token ON rules(delete_token)');

if (!database.prepare('SELECT 1 FROM calendar_review_schema_migrations WHERE version=1').get()) {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`UPDATE puzzles SET calendar_year=CASE
      WHEN suggested_date IS NOT NULL AND length(suggested_date)=10 AND substr(suggested_date,5,1)='-' THEN CAST(substr(suggested_date,1,4) AS INTEGER)
      ELSE 2028 END WHERE scope='calendar'`);
    database.exec(`INSERT OR IGNORE INTO calendar_evaluations(puzzle_id,user_id,review_round,difficulty,tags_json,updated_at)
      SELECT p.id,r.user_id,1,r.logic,'[]',COALESCE(r.created_at,CURRENT_TIMESTAMP)
      FROM puzzle_ratings r JOIN puzzles p ON p.id=r.puzzle_id
      WHERE p.scope='calendar'`);
    database.prepare('INSERT INTO calendar_review_schema_migrations(version) VALUES (1)').run();
    database.exec('COMMIT');
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}
removeNeutralCalendarReviews(database);
if (!database.prepare('SELECT 1 FROM calendar_review_schema_migrations WHERE version=3').get()) {
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const row of database.prepare("SELECT id,url,input_mode FROM puzzles WHERE scope='calendar'").all()) {
      const links = normalizeCalendarLinks({url:row.url,inputMode:row.input_mode});
      if (links.value) database.prepare('UPDATE puzzles SET penpa_edit_url=?,penpa_solve_url=?,puzzlink_url=? WHERE id=?')
        .run(links.value.penpaEditUrl,links.value.penpaSolveUrl,links.value.puzzlinkUrl,row.id);
    }
    // Suggested dates remain suggestions; old data is never silently assigned.
    database.prepare('INSERT INTO calendar_review_schema_migrations(version) VALUES(3)').run();
    database.exec('COMMIT');
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}
database.exec("CREATE UNIQUE INDEX IF NOT EXISTS calendar_assigned_date ON puzzles(assigned_date) WHERE scope='calendar' AND assigned_date IS NOT NULL");
migrateCalendarScores(database,puzzle=>notifyCalendarApproval(puzzle,`liking-migration:${puzzle.number}:${puzzle.review_round}`));
const seedRuleRevision=database.prepare(`INSERT OR IGNORE INTO rule_item_revisions(rule_id,item,revision,content_json)
  VALUES (?,?,?,?)`);
for (const row of database.prepare('SELECT * FROM rules').all()) {
  seedRuleRevision.run(row.id,'name',row.name_revision,JSON.stringify({titleZh:row.title_zh,titleEn:row.title_en}));
  seedRuleRevision.run(row.id,'description',row.description_revision,JSON.stringify({rulesZh:JSON.parse(row.rules_zh),rulesEn:JSON.parse(row.rules_en),isVariant:Boolean(row.is_variant),baseRuleId:row.base_rule_id}));
  seedRuleRevision.run(row.id,'example',row.example_revision,JSON.stringify({exampleUrl:row.example_url,exampleAuthor:row.example_author??''}));
}
if (!database.prepare('SELECT 1 FROM rule_creator_schema_migrations WHERE version=1').get()) {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`UPDATE rules SET creator_user_id=(
      SELECT changed_by_user_id FROM rule_item_revisions
      WHERE rule_id=rules.id AND item='name' AND revision=1)
      WHERE creator_user_id IS NULL AND EXISTS (
        SELECT 1 FROM rule_item_revisions
        WHERE rule_id=rules.id AND item='name' AND revision=1 AND changed_by_user_id IS NOT NULL)`);
    database.prepare('INSERT INTO rule_creator_schema_migrations(version) VALUES (1)').run();
    database.exec('COMMIT');
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}

const puzzleCount = database.prepare('SELECT COUNT(*) AS count FROM puzzles').get().count;
const puzzleSequenceExists=Boolean(database.prepare("SELECT 1 FROM entity_id_sequences WHERE name IN ('puzzles','puzzle-numbers') LIMIT 1").get());
if (puzzleCount === 0&&!puzzleSequenceExists) {
  const insertPuzzle = database.prepare(`INSERT INTO puzzles
    (number, title, type, author, source, url, note, rules, input_mode, answer, delete_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
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
  for (const puzzle of seedPuzzles) insertPuzzle.run(...puzzle,randomUUID());
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

for (const [name,table,column] of [['rules','rules','id'],['puzzles','puzzles','id'],['puzzle-numbers','puzzles','number']]) {
  const minimum=database.prepare(`SELECT COALESCE(MAX(${column}),0)+1 AS next_id FROM ${table}`).get().next_id;
  database.prepare(`INSERT INTO entity_id_sequences(name,next_id) VALUES(?,?)
    ON CONFLICT(name) DO UPDATE SET next_id=MAX(next_id,excluded.next_id)`).run(name,minimum);
}

function allocateEntityId(name) {
  const sequence=database.prepare('SELECT next_id FROM entity_id_sequences WHERE name=?').get(name);
  if (!sequence) throw new Error(`missing ${name} id sequence`);
  const next=sequence.next_id;
  const changed=database.prepare('UPDATE entity_id_sequences SET next_id=? WHERE name=? AND next_id=?').run(next+1,name,next);
  if (changed.changes!==1) throw new Error(`could not allocate ${name} id`);
  return next;
}

function participantIdentity(row) {
  return {name:row.name||'未知用户',username:row.username||null};
}

function emptyReviewParticipants() {
  return {support:[],oppose:[],veto:[]};
}
function emptyScoreParticipants() {
  return Object.fromEntries([...CALENDAR_LIKING_SCORES,'veto'].map(value=>[value,[]]));
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
  const ratingParticipants=new Map();
  for(const participant of database.prepare(`SELECT r.puzzle_id,u.name,u.username
    FROM puzzle_ratings r JOIN puzzles p ON p.id=r.puzzle_id
    LEFT JOIN trusted_users u ON u.id=r.user_id
    WHERE p.scope='public'
    ORDER BY r.puzzle_id,COALESCE(u.name,'未知用户') COLLATE NOCASE,COALESCE(u.username,'') COLLATE NOCASE,r.user_id`).all()) {
    if(!ratingParticipants.has(participant.puzzle_id)) ratingParticipants.set(participant.puzzle_id,[]);
    ratingParticipants.get(participant.puzzle_id).push(participantIdentity(participant));
  }
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
    ratingParticipants: ratingParticipants.get(row.id)||[],
    userRating: row.user_rating ? (() => { const value = JSON.parse(row.user_rating); return [value.logic, value.intuition, value.enjoyment]; })() : null,
    tags: JSON.parse(row.tags || JSON.stringify([row.input_mode === 'blank' ? '填空题' : row.type]))
  }));
}

export function addPuzzle(input) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const rule=database.prepare('SELECT id FROM rules WHERE id=?').get(input.ruleId);
    if (!rule) { database.exec('ROLLBACK'); return {error:'missing-rule'}; }
    const nextNumber=allocateEntityId('puzzle-numbers'), puzzleId=allocateEntityId('puzzles');
    const result = database.prepare(`INSERT INTO puzzles
      (id, number, title, type, author, source, url, note, rules, input_mode, answer, rule_id, delete_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(puzzleId,nextNumber, input.title, input.type, input.author, input.source, input.url || '', input.note || '等待作者补充说明。', input.rules || '等待作者补充规则。', input.inputMode, input.answer || '', input.ruleId, randomUUID());
    database.exec('COMMIT');
    return Number(result.lastInsertRowid);
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}

const ruleFromRow = (row) => row && ({
  id: row.id, titleZh: row.title_zh, titleEn: row.title_en,
  rulesZh: JSON.parse(row.rules_zh), rulesEn: JSON.parse(row.rules_en),
  category: row.category, isVariant: Boolean(row.is_variant), baseRuleId: row.base_rule_id,
  exampleUrl: row.example_url, exampleAuthor: row.example_author ?? '',
  deleteToken: row.delete_token,
  creator: row.creator_user_id ? {id:row.creator_user_id,name:row.creator_name||'',username:row.creator_username||null} : null,
  ...(row.base_rule_valid === undefined ? {} : {baseRuleValid:Boolean(row.base_rule_valid)}),
  editVersion: row.edit_version,
  revisions: {name:row.name_revision,description:row.description_revision,example:row.example_revision},
  ...(row.base_title_zh ? { baseRuleTitleZh: row.base_title_zh } : {}),
  ...(row.base_title_en ? { baseRuleTitleEn: row.base_title_en } : {})
});

function getErrorIgnores(entityType,entityId) {
  return database.prepare(`SELECT i.error_key AS key,i.revision,i.reason,i.created_at AS createdAt,
    i.entity_type AS entityType,u.id AS userId,u.name,u.username
    FROM quality_error_ignores i JOIN trusted_users u ON u.id=i.ignored_by
    WHERE i.entity_type=? AND i.entity_id=?`).all(entityType,entityId);
}
function getCalendarQuality(row,rule,guidelines=getPenpaGuidelines(),qualityData=null) {
  const errors=[];
  if (!row.penpa_edit_url) errors.push({code:'missingPenpaEdit',item:'links',revision:row.penpa_revision,message:'缺少 Penpa 编辑链接'});
  if (!row.penpa_solve_url) errors.push({code:'missingPenpaSolve',item:'links',revision:row.penpa_revision,message:'缺少 Penpa 解题链接'});
  if (!rule) errors.push({code:'missingRule',revision:1,message:'所属规则不存在'});
  else for (const error of rule.quality.errors) errors.push({...error,key:`rule:${rule.id}:${error.key}`,inheritedIgnore:error.ignored,message:`所属规则：${error.message}`});
  const annotated=annotateQualityErrors(errors,qualityData?qualityData.errorIgnores.get(row.id)||[]:getErrorIgnores('puzzle',row.id));
  const currentReviews=(qualityData?qualityData.currentReviews.get(row.id)||[]:database.prepare(`SELECT v.user_id AS userId,u.name,u.username,v.decision,v.suggestion,v.updated_at AS updatedAt,
      (u.is_active=1 AND u.username IS NOT NULL AND u.password_hash IS NOT NULL) AS active
    FROM calendar_penpa_votes v JOIN trusted_users u ON u.id=v.user_id
    WHERE v.puzzle_id=? AND v.revision=? AND v.guidelines_revision=? ORDER BY v.updated_at,v.user_id`)
    .all(row.id,row.penpa_revision,guidelines.revision)).map((review)=>({...review,active:Boolean(review.active)}));
  const history=qualityData?[]:database.prepare(`SELECT e.revision,e.guidelines_revision AS guidelinesRevision,e.decision,e.suggestion,e.created_at AS createdAt,u.name,u.username
    FROM calendar_penpa_audit_events e JOIN trusted_users u ON u.id=e.user_id WHERE e.puzzle_id=? ORDER BY e.id`).all(row.id);
  const approvalCount=currentReviews.filter((review)=>review.active&&review.decision==='approve').length;
  const rejected=currentReviews.some((review)=>review.decision==='reject');
  const status=!guidelines.available?'incomplete':rejected?'rejected':approvalCount>=3?'approved':'pending';
  const warnings=[];
  if (!row.assigned_date) warnings.push({code:'unassignedDate',message:'尚未分配日期'});
  if (status!=='approved') warnings.push({code:'penpaNotAudited',message:!guidelines.available?'Penpa 制图规范正文尚未提供，暂不能完成制图审计':rejected?'Penpa 制图审计被打回，修改链接后重新审核':`Penpa 制图规范尚未完成三人审计（${approvalCount}/3）`});
  if (rule?.quality.warnings.length) warnings.push({code:'ruleNotAudited',message:'所属规则尚未完成审计'});
  return {errors:annotated,warnings,penpa:{revision:row.penpa_revision,guidelinesRevision:guidelines.revision,guidelinesAvailable:guidelines.available,status,approvalCount,requiredApprovals:3,currentReviews,history}};
}
export function setQualityErrorIgnored(entityType,entityNumber,userId,{key,revision,ignored,reason=''}) {
  database.exec('BEGIN IMMEDIATE');
  try {
    let entityId=entityNumber,errors;
    if (entityType==='rule') {
      const rule=getRule(entityId,userId);
      if (!rule) { database.exec('ROLLBACK'); return {error:'missing'}; }
      errors=rule.quality.errors;
    } else {
      const row=database.prepare("SELECT * FROM puzzles WHERE number=? AND scope='calendar'").get(entityNumber);
      if (!row) { database.exec('ROLLBACK'); return {error:'missing'}; }
      entityId=row.id;errors=getCalendarQuality(row,row.rule_id?getRule(row.rule_id,userId):null).errors;
    }
    const error=errors.find((entry)=>entry.key===key&&entry.revision===revision);
    if (!error) { database.exec('ROLLBACK'); return {error:'stale'}; }
    if (ignored) database.prepare(`INSERT INTO quality_error_ignores(entity_type,entity_id,error_key,revision,ignored_by,reason)
      VALUES(?,?,?,?,?,?) ON CONFLICT(entity_type,entity_id,error_key) DO UPDATE SET revision=excluded.revision,ignored_by=excluded.ignored_by,reason=excluded.reason,created_at=CURRENT_TIMESTAMP`)
      .run(entityType,entityId,key,revision,userId,reason);
    else database.prepare('DELETE FROM quality_error_ignores WHERE entity_type=? AND entity_id=? AND error_key=? AND revision=?').run(entityType,entityId,key,revision);
    database.prepare(`INSERT INTO quality_error_ignore_events(entity_type,entity_id,error_key,revision,ignored,user_id,reason) VALUES(?,?,?,?,?,?,?)`)
      .run(entityType,entityId,key,revision,ignored?1:0,userId,reason);
    database.prepare(`UPDATE ${entityType==='rule'?'rules':'puzzles'} SET edit_version=edit_version+1 WHERE id=?`).run(entityId);
    database.exec('COMMIT');
    return entityType==='rule'?{rule:getRule(entityId,userId)}:{puzzle:getCalendarPuzzle(entityNumber,userId)};
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}
export function assignCalendarDate(number,userId,{assignedDate,expectedEditVersion,expectedReviewRound}) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const row=database.prepare("SELECT * FROM puzzles WHERE number=? AND scope='calendar'").get(number);
    if (!row) { database.exec('ROLLBACK'); return {error:'missing'}; }
    if (row.edit_version!==expectedEditVersion||row.review_round!==expectedReviewRound) { database.exec('ROLLBACK'); return {error:'stale'}; }
    if (row.calendar_status!=='approved') { database.exec('ROLLBACK'); return {error:'not-approved'}; }
    if (assignedDate && Number(assignedDate.slice(0,4))!==row.calendar_year) { database.exec('ROLLBACK'); return {error:'wrong-year'}; }
    if (assignedDate && database.prepare("SELECT 1 FROM puzzles WHERE scope='calendar' AND assigned_date=? AND id<>?").get(assignedDate,row.id)) { database.exec('ROLLBACK'); return {error:'occupied'}; }
    database.prepare('UPDATE puzzles SET assigned_date=?,edit_version=edit_version+1 WHERE id=?').run(assignedDate||null,row.id);
    database.exec('COMMIT');
    return {puzzle:getCalendarPuzzle(number,userId)};
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}
export function submitCalendarPenpaAudit(number,userId,{decision,suggestion='',revision,guidelinesRevision}) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const row=database.prepare("SELECT * FROM puzzles WHERE number=? AND scope='calendar'").get(number);
    if (!row) { database.exec('ROLLBACK'); return {error:'missing'}; }
    const guidelines=getPenpaGuidelines();
    if (!guidelines.available) { database.exec('ROLLBACK'); return {error:'guidelines-missing'}; }
    if (revision!==row.penpa_revision||guidelinesRevision!==guidelines.revision) { database.exec('ROLLBACK'); return {error:'stale'}; }
    if (row.calendar_status!=='approved') { database.exec('ROLLBACK'); return {error:'not-approved'}; }
    const quality=getCalendarQuality(row,row.rule_id?getRule(row.rule_id,userId):null);
    if (decision==='approve'&&quality.errors.some((error)=>error.item==='links'&&!error.ignored)) { database.exec('ROLLBACK'); return {error:'incomplete'}; }
    const existing=database.prepare('SELECT decision,suggestion FROM calendar_penpa_votes WHERE puzzle_id=? AND revision=? AND guidelines_revision=? AND user_id=?').get(row.id,revision,guidelinesRevision,userId);
    if (decision==='approve'&&quality.penpa.status==='rejected') { database.exec('ROLLBACK'); return {error:'rejected'}; }
    if (existing?.decision===decision&&existing.suggestion===suggestion) { database.exec('COMMIT'); return {puzzle:getCalendarPuzzle(number,userId)}; }
    database.prepare(`INSERT INTO calendar_penpa_votes(puzzle_id,revision,guidelines_revision,user_id,decision,suggestion)
      VALUES(?,?,?,?,?,?) ON CONFLICT(puzzle_id,revision,guidelines_revision,user_id) DO UPDATE SET decision=excluded.decision,suggestion=excluded.suggestion,updated_at=CURRENT_TIMESTAMP`)
      .run(row.id,revision,guidelinesRevision,userId,decision,suggestion);
    database.prepare('INSERT INTO calendar_penpa_audit_events(puzzle_id,revision,guidelines_revision,user_id,decision,suggestion) VALUES(?,?,?,?,?,?)').run(row.id,revision,guidelinesRevision,userId,decision,suggestion);
    if (decision==='reject') insertUserNotification(row.submitted_by,'calendar-penpa-rejected',`谜题“${row.title}”的 Penpa 制图审计被打回`,suggestion||'请对照制图规范调整并更新链接。','calendar-puzzle',number,`calendar-penpa-rejected:${number}:${revision}:${guidelinesRevision}:${userId}`);
    database.exec('COMMIT');
    return {puzzle:getCalendarPuzzle(number,userId)};
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}

function contentForRule(rule,item) {
  if (item==='name') return {titleZh:rule.titleZh,titleEn:rule.titleEn};
  if (item==='description') return {rulesZh:rule.rulesZh,rulesEn:rule.rulesEn,isVariant:rule.isVariant,baseRuleId:rule.baseRuleId};
  return {exampleUrl:rule.exampleUrl,exampleAuthor:rule.exampleAuthor??''};
}
function attachRuleQuality(rule,userId,qualityData=null) {
  if (!rule) return null;
  rule.errorIgnores=qualityData?qualityData.errorIgnores.get(rule.id)||[]:getErrorIgnores('rule',rule.id);
  const errors=getRuleFieldErrors(rule);
  const {baseRuleValid: _baseRuleValid,...publicRule}=rule;
  const fieldNames={name:'名称',description:'说明',example:'例题'};
  const groups={};
  for (const item of RULE_AUDIT_ITEMS) {
    const revision=rule.revisions[item];
    const key=`${rule.id}:${item}`;
    const currentReviews=(qualityData?qualityData.currentReviews.get(key)||[]:database.prepare(`SELECT v.user_id AS userId,u.name,u.username,v.decision,v.suggestion,v.updated_at AS updatedAt,
        (u.is_active=1 AND u.username IS NOT NULL AND u.password_hash IS NOT NULL) AS active
      FROM rule_item_votes v JOIN trusted_users u ON u.id=v.user_id
      WHERE v.rule_id=? AND v.item=? AND v.revision=? ORDER BY v.created_at,v.user_id`).all(rule.id,item,revision)).map((review)=>({...review,active:Boolean(review.active)}));
    const history=qualityData?qualityData.history.get(key)||[]:database.prepare(`SELECT e.user_id AS userId,u.name,u.username,e.revision,e.decision,e.suggestion,e.created_at AS createdAt
      FROM rule_item_audit_events e JOIN trusted_users u ON u.id=e.user_id
      WHERE e.rule_id=? AND e.item=? ORDER BY e.id`).all(rule.id,item);
    const revisions=(qualityData?qualityData.revisions.get(key)||[]:database.prepare(`SELECT r.revision,r.content_json AS content,r.changed_by_user_id AS changedByUserId,u.name AS changedByName,u.username AS changedByUsername,r.created_at AS createdAt
      FROM rule_item_revisions r LEFT JOIN trusted_users u ON u.id=r.changed_by_user_id
      WHERE r.rule_id=? AND r.item=? ORDER BY r.revision`).all(rule.id,item)).map((row)=>({
      revision:row.revision,content:(()=>{const content=JSON.parse(row.content);if(item==='example'&&!Object.hasOwn(content,'exampleAuthor'))content.exampleAuthor='';return content;})(),
        changedBy:row.changedByUserId?{userId:row.changedByUserId,name:row.changedByName,username:row.changedByUsername}:null,
        createdAt:row.createdAt
      }));
    const rejectionIgnored=rule.errorIgnores.some((entry)=>entry.key===`auditRejected:${item}`&&entry.revision===revision);
    const hasRejection=currentReviews.some((review)=>review.decision==='reject');
    const rejected=hasRejection&&!rejectionIgnored;
    const complete=isRuleItemComplete(rule,item);
    const approvalCount=currentReviews.filter((review)=>review.decision==='approve'&&review.active).length;
    const status=rejected?'rejected':!complete?'incomplete':approvalCount>=RULE_REQUIRED_APPROVALS?'approved':'pending';
    const rejectionSuggestion=[...currentReviews].reverse().find((review)=>review.decision==='reject')?.suggestion||'';
    groups[item]={revision,status,approvalCount,requiredApprovals:RULE_REQUIRED_APPROVALS,rejected,
      reviewedByCurrentUser:Boolean(userId&&currentReviews.some((review)=>review.userId===userId)),
      currentReviews,history,revisions,rejectionSuggestion};
    if (hasRejection) errors.push({code:'auditRejected',item,revision,message:`审计未通过：${fieldNames[item]}`});
  }
  const warnings=[];
  for (const item of RULE_AUDIT_ITEMS) {
    if (groups[item].status!=='approved') warnings.push({code:`${item}NotFullyAudited`,item,message:`${fieldNames[item]}尚未完成三人审计`});
  }
  return {...publicRule,quality:{errors:annotateQualityErrors(errors,rule.errorIgnores),warnings,groups}};
}
const ruleSelectSql=`SELECT r.*, b.title_zh AS base_title_zh, b.title_en AS base_title_en,
      CASE WHEN r.is_variant=0 THEN 1 WHEN b.id IS NOT NULL AND b.is_variant=0 AND b.id<>r.id THEN 1 ELSE 0 END AS base_rule_valid,
      creator.name AS creator_name,creator.username AS creator_username
    FROM rules r LEFT JOIN rules b ON b.id = r.base_rule_id
    LEFT JOIN trusted_users creator ON creator.id=r.creator_user_id`;
function selectRule(id) {
  return ruleFromRow(database.prepare(`${ruleSelectSql} WHERE r.id = ?`).get(id));
}
function groupRuleQualityRows(rows) {
  const groups=new Map();
  for(const {ruleId,item,...row} of rows) {
    const key=`${ruleId}:${item}`;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(row);
  }
  return groups;
}
export function getRules(userId=null) {
  const rules=database.prepare(`${ruleSelectSql} ORDER BY r.id`).all().map(ruleFromRow);
  if(!rules.length) return [];
  const errorIgnores=new Map(rules.map((rule)=>[rule.id,[]]));
  for(const {ruleId,...ignore} of database.prepare(`SELECT i.entity_id AS ruleId,i.error_key AS key,i.revision,i.reason,i.created_at AS createdAt,
      i.entity_type AS entityType,u.id AS userId,u.name,u.username
    FROM quality_error_ignores i JOIN trusted_users u ON u.id=i.ignored_by
    WHERE i.entity_type='rule' ORDER BY i.entity_id,i.error_key`).all()) {
    errorIgnores.get(ruleId)?.push(ignore);
  }
  const qualityData={
    errorIgnores,
    currentReviews:groupRuleQualityRows(database.prepare(`SELECT v.rule_id AS ruleId,v.item,v.user_id AS userId,u.name,u.username,v.decision,v.suggestion,v.updated_at AS updatedAt,
        (u.is_active=1 AND u.username IS NOT NULL AND u.password_hash IS NOT NULL) AS active
      FROM rule_item_votes v JOIN trusted_users u ON u.id=v.user_id JOIN rules r ON r.id=v.rule_id
      WHERE v.revision=CASE v.item WHEN 'name' THEN r.name_revision WHEN 'description' THEN r.description_revision WHEN 'example' THEN r.example_revision END
      ORDER BY v.rule_id,v.item,v.created_at,v.user_id`).all()),
    history:groupRuleQualityRows(database.prepare(`SELECT e.rule_id AS ruleId,e.item,e.user_id AS userId,u.name,u.username,e.revision,e.decision,e.suggestion,e.created_at AS createdAt
      FROM rule_item_audit_events e JOIN trusted_users u ON u.id=e.user_id
      ORDER BY e.rule_id,e.item,e.id`).all()),
    revisions:groupRuleQualityRows(database.prepare(`SELECT r.rule_id AS ruleId,r.item,r.revision,r.content_json AS content,r.changed_by_user_id AS changedByUserId,u.name AS changedByName,u.username AS changedByUsername,r.created_at AS createdAt
      FROM rule_item_revisions r LEFT JOIN trusted_users u ON u.id=r.changed_by_user_id
      ORDER BY r.rule_id,r.item,r.revision`).all())
  };
  return rules.map((rule)=>attachRuleQuality(rule,userId,qualityData));
}
export function getRule(id,userId=null) { return attachRuleQuality(selectRule(id),userId); }
export function ruleHasVariants(id) { return Boolean(database.prepare('SELECT 1 FROM rules WHERE base_rule_id=? LIMIT 1').get(id)); }

function insertUserNotification(recipientUserId,kind,title,body,entityType,entityId,dedupeKey) {
  if (!recipientUserId) return false;
  return database.prepare(`INSERT INTO user_notifications
    (recipient_user_id,kind,title,body,entity_type,entity_id,dedupe_key)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`)
    .run(recipientUserId,kind,title,body,entityType,entityId,dedupeKey).changes>0;
}

export function getInbox(userId,{limit=30,before=null,read='all',tag='all'}={}) {
  const unreadCount=Number(database.prepare('SELECT COUNT(*) AS count FROM user_notifications WHERE recipient_user_id=? AND read_at IS NULL').get(userId).count);
  const conditions=['n.recipient_user_id=?'],parameters=[userId];
  if (before!==null) { conditions.push('n.id<?');parameters.push(before); }
  if (read==='read') conditions.push('n.read_at IS NOT NULL');
  if (read==='unread') conditions.push('n.read_at IS NULL');
  if (tag==='tagged') conditions.push('EXISTS (SELECT 1 FROM user_notification_tags t WHERE t.notification_id=n.id)');
  if (tag==='untagged') conditions.push('NOT EXISTS (SELECT 1 FROM user_notification_tags t WHERE t.notification_id=n.id)');
  const rows=database.prepare(`SELECT n.id,n.kind,n.title,n.body,n.entity_type,n.entity_id,n.created_at,n.read_at
    FROM user_notifications n WHERE ${conditions.join(' AND ')} ORDER BY n.id DESC LIMIT ?`).all(...parameters,limit+1);
  const hasMore=rows.length>limit,selected=hasMore?rows.slice(0,limit):rows;
  const tagsById=new Map(selected.map((row)=>[row.id,new Set()]));
  if (selected.length) {
    const tags=database.prepare(`SELECT notification_id,tag FROM user_notification_tags
      WHERE notification_id IN (${selected.map(()=>'?').join(',')})`).all(...selected.map((row)=>row.id));
    for (const row of tags) tagsById.get(row.notification_id).add(row.tag);
  }
  const notifications=selected.map((row)=>({id:row.id,type:row.kind,title:row.title,body:row.body,createdAt:row.created_at,readAt:row.read_at,
    tags:INBOX_TAG_IDS.filter((tag)=>tagsById.get(row.id).has(tag)),
    entity:row.entity_type&&row.entity_id!==null?{type:row.entity_type,id:row.entity_id}:null}));
  const nextBefore=hasMore?selected.at(-1).id:null;
  return {notifications,unreadCount,nextBefore};
}

export function setInboxNotificationTags(userId,id,tags) {
  const normalized=normalizeInboxTagInput({tags});
  if (normalized.error) throw new TypeError(normalized.error);
  database.exec('BEGIN IMMEDIATE');
  try {
    if (!database.prepare('SELECT 1 FROM user_notifications WHERE id=? AND recipient_user_id=?').get(id,userId)) {
      database.exec('ROLLBACK');return null;
    }
    database.prepare('DELETE FROM user_notification_tags WHERE notification_id=?').run(id);
    const insert=database.prepare('INSERT INTO user_notification_tags(notification_id,tag) VALUES (?,?)');
    for (const tag of normalized.value.tags) insert.run(id,tag);
    database.exec('COMMIT');
    return {id,tags:normalized.value.tags};
  } catch (error) {
    database.exec('ROLLBACK');throw error;
  }
}

export function markInboxNotificationRead(userId,id) {
  const result=database.prepare(`UPDATE user_notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP)
    WHERE id=? AND recipient_user_id=?`).run(id,userId);
  return result.changes>0;
}
export function markAllInboxNotificationsRead(userId) {
  return database.prepare(`UPDATE user_notifications SET read_at=CURRENT_TIMESTAMP
    WHERE recipient_user_id=? AND read_at IS NULL`).run(userId).changes;
}

export function deleteRule(id,deleteToken,expectedEditVersion) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const row=database.prepare('SELECT delete_token,edit_version FROM rules WHERE id=?').get(id);
    if (!row) { database.exec('ROLLBACK'); return {error:'missing'}; }
    if (typeof deleteToken!=='string'||!deleteToken||row.delete_token!==deleteToken||row.edit_version!==expectedEditVersion) {
      database.exec('ROLLBACK'); return {error:'stale'};
    }
    const references={
      publicPuzzles:database.prepare("SELECT COUNT(*) AS count FROM puzzles WHERE rule_id=? AND scope='public'").get(id).count,
      calendarPuzzles:database.prepare("SELECT COUNT(*) AS count FROM puzzles WHERE rule_id=? AND scope='calendar'").get(id).count,
      otherPuzzles:database.prepare("SELECT COUNT(*) AS count FROM puzzles WHERE rule_id=? AND scope NOT IN ('public','calendar')").get(id).count,
      totalPuzzles:database.prepare('SELECT COUNT(*) AS count FROM puzzles WHERE rule_id=?').get(id).count,
      variants:database.prepare('SELECT COUNT(*) AS count FROM rules WHERE base_rule_id=?').get(id).count
    };
    if (Object.values(references).some((count)=>count>0)) {
      database.exec('ROLLBACK'); return {error:'referenced',references};
    }
    database.prepare("DELETE FROM quality_error_ignores WHERE entity_type='rule' AND entity_id=?").run(id);
    database.prepare('DELETE FROM rule_item_votes WHERE rule_id=?').run(id);
    database.prepare('DELETE FROM rule_item_audit_events WHERE rule_id=?').run(id);
    database.prepare('DELETE FROM rule_item_revisions WHERE rule_id=?').run(id);
    const deleted=database.prepare('DELETE FROM rules WHERE id=? AND delete_token=? AND edit_version=?').run(id,deleteToken,expectedEditVersion);
    if (!deleted.changes) { database.exec('ROLLBACK'); return {error:'stale'}; }
    database.exec('COMMIT');
    return {deleted:true};
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}

export function addRule(input,userId) {
  database.exec('BEGIN IMMEDIATE');
  try {
    if (input.isVariant&&input.baseRuleId!==undefined&&input.baseRuleId!==null&&input.baseRuleId!=='') {
      const base=database.prepare('SELECT is_variant FROM rules WHERE id=?').get(input.baseRuleId);
      if (!base||base.is_variant) { database.exec('ROLLBACK'); return {error:'invalid-base'}; }
    }
    const id=allocateEntityId('rules');
    database.prepare(`INSERT INTO rules (id,title_zh,title_en,rules_zh,rules_en,category,is_variant,base_rule_id,example_url,example_author,delete_token,creator_user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.titleZh,input.titleEn,JSON.stringify(input.rulesZh),JSON.stringify(input.rulesEn),input.category,input.isVariant?1:0,input.baseRuleId,input.exampleUrl,input.exampleAuthor??'',randomUUID(),userId||null);
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
    if (!current.isVariant&&next.isVariant&&database.prepare('SELECT 1 FROM rules WHERE base_rule_id=? LIMIT 1').get(id)) {
      database.exec('ROLLBACK'); return {error:'has-variants'};
    }
    if (next.isVariant&&next.baseRuleId!==undefined&&next.baseRuleId!==null&&next.baseRuleId!=='') {
      const base=database.prepare('SELECT is_variant FROM rules WHERE id=?').get(next.baseRuleId);
      if (!base||base.is_variant||next.baseRuleId===id) { database.exec('ROLLBACK'); return {error:'invalid-base'}; }
    }
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
    current.errorIgnores=getErrorIgnores('rule',id);
    const rejectionIgnored=current.errorIgnores.some((entry)=>entry.key===`auditRejected:${item}`&&entry.revision===revision);
    if (!RULE_AUDIT_ITEMS.includes(item)||revision!==current.revisions[item]) { database.exec('ROLLBACK'); return {error:'stale'}; }
    if (decision!=='approve'&&decision!=='reject') { database.exec('ROLLBACK'); return {error:'invalid'}; }
    if (decision==='approve'&&!isRuleItemComplete(current,item)) { database.exec('ROLLBACK'); return {error:'incomplete'}; }
    const beforeRule=getRule(id,userId);
    const wasFullyApproved=RULE_AUDIT_ITEMS.every((auditItem)=>beforeRule.quality.groups[auditItem].status==='approved');
    const existing=database.prepare('SELECT decision,suggestion FROM rule_item_votes WHERE rule_id=? AND item=? AND revision=? AND user_id=?').get(id,item,revision,userId);
    const anyRejection=database.prepare("SELECT 1 FROM rule_item_votes WHERE rule_id=? AND item=? AND revision=? AND decision='reject' LIMIT 1").get(id,item,revision);
    if (!rejectionIgnored&&existing?.decision==='reject'&&decision!=='reject') { database.exec('ROLLBACK'); return {error:'sticky'}; }
    if (!rejectionIgnored&&anyRejection&&!existing&&decision==='approve') { database.exec('ROLLBACK'); return {error:'rejected'}; }
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
    const auditEvent=database.prepare(`INSERT INTO rule_item_audit_events(rule_id,item,revision,user_id,decision,suggestion,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(id,item,revision,userId,decision,suggestion,now);
    if (decision==='reject') database.prepare("DELETE FROM quality_error_ignores WHERE entity_type='rule' AND entity_id=? AND error_key=?").run(id,`auditRejected:${item}`);
    const afterRule=getRule(id,userId);
    const title=current.titleZh||current.titleEn||'规则';
    if (decision==='reject') {
      const itemTitle={name:'名称',description:'说明',example:'例题'}[item];
      const details=suggestion?`建议：${suggestion}`:'请查看被拒绝的内容并修改。';
      insertUserNotification(row.creator_user_id,'rule-rejected',`规则“${title}”的${itemTitle}审计未通过`,details,'rule',id,`rule-rejected:${id}:${item}:${revision}:${auditEvent.lastInsertRowid}`);
    }
    const isFullyApproved=RULE_AUDIT_ITEMS.every((auditItem)=>afterRule.quality.groups[auditItem].status==='approved');
    if (!wasFullyApproved&&isFullyApproved) {
      const revisionKey=`${afterRule.revisions.name}-${afterRule.revisions.description}-${afterRule.revisions.example}`;
      insertUserNotification(row.creator_user_id,'rule-approved',`规则“${title}”已完成三组审计`,'名称、说明和例题均已通过三人审计。','rule',id,`rule-approved:${id}:${revisionKey}`);
    }
    database.exec('COMMIT');
    return {rule:afterRule,changed:true};
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}

function puzzleByNumber(number, userId, scope, context=null) {
  const row = database.prepare(`SELECT p.*,
      EXISTS (SELECT 1 FROM puzzle_completions c WHERE c.puzzle_id = p.id AND c.user_id = ?) AS completed,
      COALESCE(ROUND(AVG(r.logic),1),0) AS logic_rating, COALESCE(ROUND(AVG(r.intuition),1),0) AS intuition_rating,
      COALESCE(ROUND(AVG(r.enjoyment),1),0) AS enjoyment_rating, COUNT(r.id) AS votes,
      (SELECT json_object('logic',r2.logic,'intuition',r2.intuition,'enjoyment',r2.enjoyment) FROM puzzle_ratings r2 WHERE r2.puzzle_id=p.id AND r2.user_id=?) AS user_rating,
      (SELECT json_group_array(pt.tag) FROM puzzle_tags pt WHERE pt.puzzle_id=p.id) AS tags,
      u.name AS submitter_name,u.username AS submitter_username
    FROM puzzles p LEFT JOIN puzzle_ratings r ON r.puzzle_id=p.id AND p.scope='public'
    LEFT JOIN trusted_users u ON u.id=p.submitted_by
    WHERE p.number=? AND p.scope=? GROUP BY p.id`).get(userId,userId,number,scope);
  if (!row) return null;
  let rule = null;
  if (row.rule_id) {
    if (context?.rules.has(row.rule_id)) rule=context.rules.get(row.rule_id);
    else { rule=getRule(row.rule_id); context?.rules.set(row.rule_id,rule); }
  }
  const puzzle = {
    number: row.number, title: row.title, type: row.type, author: row.author, source: row.source,
    url: row.url, note: row.note, rules: row.rules, inputMode: row.input_mode, answer: row.answer,
    completed: Boolean(row.completed), ratings: [Number(row.logic_rating),Number(row.intuition_rating),Number(row.enjoyment_rating)],
    votes: Number(row.votes), userRating: row.user_rating ? (()=>{const v=JSON.parse(row.user_rating);return [v.logic,v.intuition,v.enjoyment]})() : null,
    tags: JSON.parse(row.tags || '[]')
  };
  if (scope === 'calendar') {
    puzzle.scope = 'calendar'; puzzle.ruleId = row.rule_id; puzzle.rule = rule;
    puzzle.deleteToken = row.delete_token;
    puzzle.editVersion = Number(row.edit_version);
    puzzle.penpaEditUrl=row.penpa_edit_url;
    puzzle.penpaSolveUrl=row.penpa_solve_url;
    puzzle.puzzlinkUrl=row.puzzlink_url||(isConcretePuzzlinkPuzzleUrl(row.url)?row.url:'');
    puzzle.penpaRevision=Number(row.penpa_revision);
    puzzle.assignedDate=row.assigned_date;
    const evaluations=database.prepare(`SELECT e.difficulty,e.tags_json,e.review_round,u.name,u.username FROM calendar_evaluations e
      JOIN (SELECT user_id,MAX(review_round) AS review_round FROM calendar_evaluations WHERE puzzle_id=? GROUP BY user_id) latest
        ON latest.user_id=e.user_id AND latest.review_round=e.review_round
      LEFT JOIN trusted_users u ON u.id=e.user_id
      WHERE e.puzzle_id=?
      ORDER BY COALESCE(u.name,'未知用户') COLLATE NOCASE,COALESCE(u.username,'') COLLATE NOCASE,e.user_id`).all(row.id,row.id);
    const ownEvaluation=database.prepare('SELECT difficulty,tags_json FROM calendar_evaluations WHERE puzzle_id=? AND user_id=? ORDER BY review_round DESC LIMIT 1').get(row.id,userId);
    const tagCounts=new Map();
    for(const evaluation of evaluations) for(const tag of JSON.parse(evaluation.tags_json)) tagCounts.set(tag,(tagCounts.get(tag)||0)+1);
    const ownVoteRow=database.prepare('SELECT vote,score FROM calendar_review_votes WHERE puzzle_id=? AND review_round=? AND user_id=?').get(row.id,row.review_round,userId);
    const ownVote=ownVoteRow?calendarVoteValue(ownVoteRow):null;
    const voteHistory=new Map();
    const participantHistory=new Map();
    const scoreParticipantHistory=new Map();
    for(const item of database.prepare(`SELECT v.review_round,v.vote,v.score,u.name,u.username
      FROM calendar_review_votes v LEFT JOIN trusted_users u ON u.id=v.user_id
      WHERE v.puzzle_id=?
      ORDER BY v.review_round,COALESCE(u.name,'未知用户') COLLATE NOCASE,COALESCE(u.username,'') COLLATE NOCASE,v.user_id`).all(row.id)) {
      if(!voteHistory.has(item.review_round)) {
        voteHistory.set(item.review_round,[]);
        participantHistory.set(item.review_round,emptyReviewParticipants());
        scoreParticipantHistory.set(item.review_round,emptyScoreParticipants());
      }
      const value=calendarVoteValue(item);
      voteHistory.get(item.review_round).push(value);
      if (value!==null) scoreParticipantHistory.get(item.review_round)[value].push(participantIdentity(item));
      const legacyGroup=value==='veto'?'veto':value>0?'support':value<0?'oppose':null;
      if (legacyGroup) participantHistory.get(item.review_round)[legacyGroup].push(participantIdentity(item));
    }
    const review=summarizeCalendarVotes(voteHistory.get(row.review_round));
    const evaluationHistory=new Map();
    for(const item of database.prepare('SELECT review_round,COUNT(*) AS count,AVG(difficulty) AS average FROM calendar_evaluations WHERE puzzle_id=? GROUP BY review_round').all(row.id)) {
      evaluationHistory.set(item.review_round,{count:Number(item.count),average:Number(Number(item.average).toFixed(1))});
    }
    const reviewHistory=Array.from({length:Number(row.review_round)},(_,index)=>{
      const round=index+1,totals=summarizeCalendarVotes(voteHistory.get(round)),evaluationsForRound=evaluationHistory.get(round)||{count:0,average:null};
      return {reviewRound:round,status:getCalendarReviewStatus(totals),...totals,netSupport:totals.support-totals.oppose,
        participants:participantHistory.get(round)||emptyReviewParticipants(),
        scoreParticipants:scoreParticipantHistory.get(round)||emptyScoreParticipants(),
        evaluationCount:evaluationsForRound.count,averageDifficulty:evaluationsForRound.average};
    });
    puzzle.ratings=[0,0,0];puzzle.votes=database.prepare('SELECT COUNT(DISTINCT user_id) AS count FROM calendar_evaluations WHERE puzzle_id=?').get(row.id).count;puzzle.userRating=null;
    puzzle.ratingParticipants=evaluations.map(participantIdentity);
    puzzle.calendarYear=Number(row.calendar_year);
    puzzle.suggestedDate=row.suggested_date;
    puzzle.suggestedMonthDay=row.suggested_date?row.suggested_date.slice(5):'';
    puzzle.calendarStatus=row.calendar_status;
    puzzle.reviewRound=Number(row.review_round);
    puzzle.evaluation=ownEvaluation?{difficulty:Number(ownEvaluation.difficulty),tags:JSON.parse(ownEvaluation.tags_json)}:null;
    puzzle.evaluationSummary={averageDifficulty:evaluations.length?Number((evaluations.reduce((sum,e)=>sum+Number(e.difficulty),0)/evaluations.length).toFixed(1)):null,
      tags:[...tagCounts].map(([tag,count])=>({tag,count})).sort((a,b)=>b.count-a.count||a.tag.localeCompare(b.tag))};
    puzzle.review={...review,participants:participantHistory.get(row.review_round)||emptyReviewParticipants(),scoreParticipants:scoreParticipantHistory.get(row.review_round)||emptyScoreParticipants()};
    puzzle.reviewHistory=reviewHistory;
    puzzle.userVote=ownVote;
    puzzle.quality=getCalendarQuality(row,rule,context?.guidelines);
    puzzle.calendarArea=getCalendarArea(row.calendar_status,puzzle.quality.errors,puzzle.quality.warnings);
    puzzle.submittedBy={id:row.submitted_by,name:row.submitter_name||'',username:row.submitter_username||null};
  }
  return puzzle;
}

export function getCalendarPuzzles(userId) {
  const rows = database.prepare("SELECT number FROM puzzles WHERE scope='calendar' AND calendar_status IN ('pending','approved') ORDER BY calendar_year,COALESCE(suggested_date,'9999-12-31'),number DESC").all();
  const context={guidelines:getPenpaGuidelines(),rules:new Map()};
  return rows.map(({number}) => puzzleByNumber(number,userId,'calendar',context));
}
function groupCalendarQualityRows(rows,idKey) {
  const groups=new Map();
  for(const source of rows) {
    const id=source[idKey],row={...source};
    delete row[idKey];
    if(!groups.has(id)) groups.set(id,[]);
    groups.get(id).push(row);
  }
  return groups;
}
function getCalendarPageQuality(guidelines) {
  // Classifying the archive needs only current quality state. Histories, solving
  // participants and detailed puzzle payloads are loaded for the requested page.
  const rules=database.prepare(`${ruleSelectSql} WHERE EXISTS (
    SELECT 1 FROM puzzles p WHERE p.scope='calendar' AND p.calendar_status='approved' AND p.rule_id=r.id
  )`).all().map(ruleFromRow);
  const ruleData={
    errorIgnores:groupCalendarQualityRows(database.prepare(`SELECT i.entity_id AS ruleId,i.error_key AS key,i.revision
      FROM quality_error_ignores i JOIN trusted_users u ON u.id=i.ignored_by
      WHERE i.entity_type='rule' AND EXISTS (SELECT 1 FROM puzzles p
        WHERE p.scope='calendar' AND p.calendar_status='approved' AND p.rule_id=i.entity_id)`).all(),'ruleId'),
    currentReviews:groupRuleQualityRows(database.prepare(`SELECT v.rule_id AS ruleId,v.item,v.decision,
        (u.is_active=1 AND u.username IS NOT NULL AND u.password_hash IS NOT NULL) AS active
      FROM rule_item_votes v JOIN trusted_users u ON u.id=v.user_id JOIN rules r ON r.id=v.rule_id
      WHERE v.revision=CASE v.item WHEN 'name' THEN r.name_revision WHEN 'description' THEN r.description_revision WHEN 'example' THEN r.example_revision END
        AND EXISTS (SELECT 1 FROM puzzles p WHERE p.scope='calendar' AND p.calendar_status='approved' AND p.rule_id=r.id)`).all()),
    history:new Map(),revisions:new Map()
  };
  return {
    rules:new Map(rules.map((rule)=>[rule.id,attachRuleQuality(rule,null,ruleData)])),
    errorIgnores:groupCalendarQualityRows(database.prepare(`SELECT i.entity_id AS puzzleId,i.error_key AS key,i.revision
      FROM quality_error_ignores i JOIN trusted_users u ON u.id=i.ignored_by
      JOIN puzzles p ON p.id=i.entity_id
      WHERE i.entity_type='puzzle' AND p.scope='calendar' AND p.calendar_status='approved'`).all(),'puzzleId'),
    currentReviews:groupCalendarQualityRows(database.prepare(`SELECT v.puzzle_id AS puzzleId,v.decision,
        (u.is_active=1 AND u.username IS NOT NULL AND u.password_hash IS NOT NULL) AS active
      FROM calendar_penpa_votes v JOIN trusted_users u ON u.id=v.user_id JOIN puzzles p ON p.id=v.puzzle_id
      WHERE p.scope='calendar' AND p.calendar_status='approved' AND v.revision=p.penpa_revision AND v.guidelines_revision=?`).all(guidelines.revision),'puzzleId')
  };
}
export function getCalendarPage(userId,{limit=10,offset=0,view='calendar',sort='date',year=2028,month=1}={}) {
  const guidelines=getPenpaGuidelines();
  const rows=database.prepare(`SELECT p.id,p.number,p.title,p.rule_id,p.calendar_status,p.calendar_year,
      p.suggested_date,p.assigned_date,(p.penpa_edit_url<>'') AS penpa_edit_url,
      (p.penpa_solve_url<>'') AS penpa_solve_url,p.penpa_revision,
      r.title_zh AS rule_title_zh,r.title_en AS rule_title_en,
      EXISTS (SELECT 1 FROM puzzle_completions c WHERE c.puzzle_id=p.id AND c.user_id=?) AS completed
    FROM puzzles p LEFT JOIN rules r ON r.id=p.rule_id
    WHERE p.scope='calendar' AND p.calendar_status IN ('pending','approved','leftover')`).all(userId);
  const qualityData=rows.some((row)=>row.calendar_status==='approved')?getCalendarPageQuality(guidelines):null;
  const counts={review:0,leftover:0,allocation:0,finished:0};
  for(const row of rows) {
    if(row.calendar_status==='approved') {
      const quality=getCalendarQuality(row,qualityData.rules.get(row.rule_id)||null,guidelines,qualityData);
      row.area=getCalendarArea(row.calendar_status,quality.errors,quality.warnings);
    } else row.area=getCalendarArea(row.calendar_status);
    counts[row.area]++;
  }
  const monthKey=`${year}-${String(month).padStart(2,'0')}`;
  const area=({calendar:'review',leftovers:'leftover',allocation:'allocation',finished:'finished'})[view];
  const selected=rows.filter((row)=>view==='pending'?!row.completed&&row.area!=='leftover':
    row.area===area&&(view!=='finished'||row.assigned_date?.startsWith(monthKey)));
  const dateKey=(row)=>row.assigned_date||row.suggested_date||`${Number(row.calendar_year)||2028}-99-99`;
  selected.sort((a,b)=>sort==='newest'?b.number-a.number:dateKey(a).localeCompare(dateKey(b))||b.number-a.number);
  const pageRows=selected.slice(offset,offset+limit);
  const context={guidelines,rules:new Map()};
  return {
    puzzles:pageRows.map(({number})=>puzzleByNumber(number,userId,'calendar',context)),
    nextOffset:offset+pageRows.length<selected.length?offset+pageRows.length:null,
    total:selected.length,counts,
    ...(view==='finished'?{monthEntries:selected.map((row)=>({number:row.number,title:row.title,assignedDate:row.assigned_date,
      ...(row.rule_title_zh!==null?{rule:{titleZh:row.rule_title_zh,titleEn:row.rule_title_en}}:{})}))}:{})
  };
}
export function getCalendarPuzzle(number,userId) { return puzzleByNumber(number,userId,'calendar'); }
export function getCalendarLeftovers(userId) {
  const rows=database.prepare("SELECT number FROM puzzles WHERE scope='calendar' AND calendar_status='leftover' ORDER BY calendar_year,COALESCE(suggested_date,'9999-12-31'),number DESC").all();
  const context={guidelines:getPenpaGuidelines(),rules:new Map()};
  return rows.map(({number})=>puzzleByNumber(number,userId,'calendar',context));
}
export function addCalendarPuzzle(input,user) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const rule = selectRule(input.ruleId);
    if (!rule) { database.exec('ROLLBACK'); return {error:'missing-rule'}; }
    const links=normalizeCalendarLinks(input);
    if (links.error) { database.exec('ROLLBACK'); return {error:'invalid-links'}; }
    const next=allocateEntityId('puzzle-numbers'), puzzleId=allocateEntityId('puzzles');
    const result = database.prepare(`INSERT INTO puzzles (id,number,title,type,author,source,url,note,rules,input_mode,answer,scope,rule_id,suggested_date,calendar_year,calendar_status,review_round,submitted_by,delete_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'calendar',?,?,?,'pending',1,?,?)`).run(puzzleId,next,input.title.trim(),rule.category,input.author.trim(),input.source.trim(),input.url || '',input.note || '',rule.rulesZh.join('\n'),'external'===input.inputMode?'external':'blank',input.inputMode==='blank'?(input.answer||''):'',input.ruleId,input.suggestedDate || null,input.calendarYear??2028,user.id,randomUUID());
    database.prepare('UPDATE puzzles SET url=?,penpa_edit_url=?,penpa_solve_url=?,puzzlink_url=? WHERE id=?')
      .run(links.value.url,links.value.penpaEditUrl,links.value.penpaSolveUrl,links.value.puzzlinkUrl,puzzleId);
    database.exec('COMMIT');
    return { id: Number(result.lastInsertRowid), puzzle: getCalendarPuzzle(next,user.id) };
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}

export function deleteCalendarPuzzle(number,userId,deleteToken) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const puzzle=database.prepare("SELECT id,submitted_by,delete_token FROM puzzles WHERE number=? AND scope='calendar'").get(number);
    if (!puzzle) { database.exec('ROLLBACK'); return {error:'missing'}; }
    if (typeof deleteToken!=='string'||!deleteToken||puzzle.delete_token!==deleteToken) { database.exec('ROLLBACK'); return {error:'stale'}; }
    if (puzzle.submitted_by!==userId) { database.exec('ROLLBACK'); return {error:'forbidden'}; }
    database.prepare("DELETE FROM quality_error_ignores WHERE entity_type='puzzle' AND entity_id=?").run(puzzle.id);
    database.prepare('DELETE FROM puzzle_ratings WHERE puzzle_id=?').run(puzzle.id);
    database.prepare('DELETE FROM calendar_evaluations WHERE puzzle_id=?').run(puzzle.id);
    database.prepare('DELETE FROM calendar_review_votes WHERE puzzle_id=?').run(puzzle.id);
    database.prepare('DELETE FROM calendar_review_vote_events WHERE puzzle_id=?').run(puzzle.id);
    database.prepare('DELETE FROM puzzle_completions WHERE puzzle_id=?').run(puzzle.id);
    database.prepare('DELETE FROM puzzle_tags WHERE puzzle_id=?').run(puzzle.id);
    database.prepare('DELETE FROM collection_puzzles WHERE puzzle_id=?').run(puzzle.id);
    database.prepare('DELETE FROM puzzles WHERE id=? AND delete_token=?').run(puzzle.id,deleteToken);
    database.exec('COMMIT');
    return {deleted:true,number};
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}
export function updateCalendarSuggestedDate(number,userId,calendarYear,date) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = database.prepare("SELECT id,submitted_by FROM puzzles WHERE number=? AND scope='calendar'").get(number);
    if (!row) { database.exec('ROLLBACK'); return {missing:true}; }
    if (row.submitted_by !== userId) { database.exec('ROLLBACK'); return {forbidden:true}; }
    database.prepare('UPDATE puzzles SET suggested_date=?,calendar_year=?,assigned_date=CASE WHEN calendar_year<>? THEN NULL ELSE assigned_date END,edit_version=edit_version+1 WHERE id=?').run(date||null,calendarYear,calendarYear,row.id);
    database.exec('COMMIT');
    return {puzzle:getCalendarPuzzle(number,userId)};
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}
export function updateCalendarPuzzle(number,userId,input) {
  return editCalendarPuzzle(number,userId,input,false);
}
export function updateCalendarPenpaLinks(number,userId,input) {
  const permitted=Object.fromEntries(['penpaEditUrl','penpaSolveUrl','expectedEditVersion','expectedReviewRound'].filter(key=>Object.hasOwn(input,key)).map(key=>[key,input[key]]));
  return editCalendarPuzzle(number,userId,permitted,true);
}
function editCalendarPuzzle(number,userId,input,penpaOnly) {
  const {title,source,clearReviews=false,expectedEditVersion,expectedReviewRound}=input;
  database.exec('BEGIN IMMEDIATE');
  try {
    const row=database.prepare("SELECT * FROM puzzles WHERE number=? AND scope='calendar'").get(number);
    if (!row) { database.exec('ROLLBACK'); return {error:'missing'}; }
    if (penpaOnly) {
      const active=database.prepare('SELECT 1 FROM trusted_users WHERE id=? AND is_active=1 AND username IS NOT NULL AND password_hash IS NOT NULL').get(userId);
      if (!active) { database.exec('ROLLBACK'); return {error:'forbidden'}; }
      if (getCalendarPuzzle(number,userId).calendarArea!=='allocation') { database.exec('ROLLBACK'); return {error:'not-allocation'}; }
    } else if (row.submitted_by!==userId) { database.exec('ROLLBACK'); return {error:'forbidden'}; }
    if (row.edit_version!==expectedEditVersion || row.review_round!==expectedReviewRound) { database.exec('ROLLBACK'); return {error:'stale'}; }
    const links=normalizeCalendarLinks(input,{url:row.url,inputMode:row.input_mode,penpaEditUrl:row.penpa_edit_url,penpaSolveUrl:row.penpa_solve_url,puzzlinkUrl:row.puzzlink_url});
    if (links.error) { database.exec('ROLLBACK'); return {error:'invalid-links'}; }
    const penpaChanged=row.penpa_edit_url!==links.value.penpaEditUrl||row.penpa_solve_url!==links.value.penpaSolveUrl;
    if (clearReviews) {
      for (const table of ['puzzle_ratings','calendar_evaluations','calendar_review_votes','calendar_review_vote_events']) {
        database.prepare(`DELETE FROM ${table} WHERE puzzle_id=?`).run(row.id);
      }
    }
    database.prepare(`UPDATE puzzles SET title=?,url=?,source=?,edit_version=edit_version+1,
      calendar_status=?,review_round=?,penpa_edit_url=?,penpa_solve_url=?,puzzlink_url=?,penpa_revision=penpa_revision+?,assigned_date=? WHERE id=?`)
      .run(penpaOnly?row.title:title.trim(),links.value.url,penpaOnly?(row.input_mode==='blank'?row.source:getPuzzleSource(links.value.url)):source,clearReviews?'pending':row.calendar_status,row.review_round+(clearReviews?1:0),
        links.value.penpaEditUrl,links.value.penpaSolveUrl,links.value.puzzlinkUrl,penpaChanged?1:0,clearReviews?null:row.assigned_date,row.id);
    database.exec('COMMIT');
    return {puzzle:getCalendarPuzzle(number,userId)};
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}

export function getCalendarComments(number,userId,reveal=false) {
  const row=database.prepare(`SELECT p.id,EXISTS(SELECT 1 FROM puzzle_completions c
    WHERE c.puzzle_id=p.id AND c.user_id=?) AS completed FROM puzzles p
    WHERE p.number=? AND p.scope='calendar'`).get(userId,number);
  if (!row) return {error:'missing'};
  if (!row.completed&&!reveal) return {hidden:true,comments:[]};
  const comments=database.prepare(`SELECT c.id,c.body,c.created_at AS createdAt,u.name,u.username
    FROM calendar_comments c JOIN trusted_users u ON u.id=c.user_id WHERE c.puzzle_id=? ORDER BY c.id`).all(row.id);
  return {hidden:false,comments};
}

export function addCalendarComment(number,userId,body) {
  const row=database.prepare("SELECT id FROM puzzles WHERE number=? AND scope='calendar'").get(number);
  if (!row) return {error:'missing'};
  const result=database.prepare('INSERT INTO calendar_comments(puzzle_id,user_id,body) VALUES (?,?,?)').run(row.id,userId,body);
  return {id:Number(result.lastInsertRowid)};
}

export function calendarPuzzleExists(number) { return Boolean(database.prepare("SELECT 1 FROM puzzles WHERE number=? AND scope='calendar'").get(number)); }

export function completeCalendarReview(number,userId,{difficulty,tags,vote,expectedReviewRound}) {
  vote=normalizeCalendarVote(vote);
  if (vote===null) return {error:'invalid-vote'};
  const storedVote=storedCalendarVote(vote),score=vote==='veto'?null:vote;
  database.exec('BEGIN IMMEDIATE');
  try {
    const puzzle=database.prepare("SELECT id,title,submitted_by,calendar_status,review_round FROM puzzles WHERE number=? AND scope='calendar'").get(number);
    if (!puzzle) { database.exec('ROLLBACK'); return {error:'missing'}; }
    if (puzzle.review_round!==expectedReviewRound) { database.exec('ROLLBACK'); return {error:'stale-round'}; }
    if (puzzle.calendar_status==='leftover') { database.exec('ROLLBACK'); return {error:'reentry-required'}; }
    const active=database.prepare(`SELECT 1 FROM trusted_users WHERE id=? AND is_active=1 AND username IS NOT NULL AND password_hash IS NOT NULL`).get(userId);
    if (!active) { database.exec('ROLLBACK'); return {error:'inactive'}; }
    const existing=database.prepare('SELECT vote,score FROM calendar_review_votes WHERE puzzle_id=? AND review_round=? AND user_id=?').get(puzzle.id,puzzle.review_round,userId);
    const changed=!existing||calendarVoteValue(existing)!==vote;
    if (existing?.vote==='veto'&&vote!=='veto') { database.exec('ROLLBACK'); return {error:'veto-locked'}; }
    database.prepare(`INSERT INTO calendar_evaluations(puzzle_id,user_id,review_round,difficulty,tags_json,updated_at)
      VALUES (?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(puzzle_id,user_id,review_round) DO UPDATE SET
      difficulty=excluded.difficulty,tags_json=excluded.tags_json,updated_at=CURRENT_TIMESTAMP`)
      .run(puzzle.id,userId,puzzle.review_round,difficulty,JSON.stringify(tags));
    database.prepare('INSERT OR IGNORE INTO puzzle_completions(puzzle_id,user_id) VALUES (?,?)').run(puzzle.id,userId);
    if (!existing) {
      database.prepare(`INSERT INTO calendar_review_votes(puzzle_id,review_round,user_id,vote,score,updated_at)
        VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)`).run(puzzle.id,puzzle.review_round,userId,storedVote,score);
      database.prepare(`INSERT INTO calendar_review_vote_events(puzzle_id,review_round,user_id,vote,score)
        VALUES (?,?,?,?,?)`).run(puzzle.id,puzzle.review_round,userId,storedVote,score);
    } else if (changed) {
      database.prepare(`UPDATE calendar_review_votes SET vote=?,score=?,updated_at=CURRENT_TIMESTAMP
        WHERE puzzle_id=? AND review_round=? AND user_id=?`).run(storedVote,score,puzzle.id,puzzle.review_round,userId);
      database.prepare(`INSERT INTO calendar_review_vote_events(puzzle_id,review_round,user_id,vote,score)
        VALUES (?,?,?,?,?)`).run(puzzle.id,puzzle.review_round,userId,storedVote,score);
    }
    const totals=summarizeCalendarVotes(database.prepare('SELECT vote,score FROM calendar_review_votes WHERE puzzle_id=? AND review_round=?').all(puzzle.id,puzzle.review_round).map(calendarVoteValue));
    const status=getCalendarReviewStatus(totals);
    if (status!==puzzle.calendar_status) database.prepare(`UPDATE puzzles SET calendar_status=?,assigned_date=CASE WHEN ?<>'approved' THEN NULL ELSE assigned_date END WHERE id=? AND review_round=?`).run(status,status,puzzle.id,puzzle.review_round);
    if (status==='approved'&&puzzle.calendar_status!=='approved') {
      const eventId=database.prepare('SELECT MAX(id) AS id FROM calendar_review_vote_events WHERE puzzle_id=? AND review_round=?').get(puzzle.id,puzzle.review_round).id;
      notifyCalendarApproval({...puzzle,number},`${number}:${puzzle.review_round}:${eventId}`);
    } else if (status==='leftover'&&puzzle.calendar_status!=='leftover') {
      insertUserNotification(puzzle.submitted_by,'calendar-vetoed',`日历谜题“${puzzle.title}”进入待重新投稿`,'本轮收到否决票；内容和完成记录已保留。','calendar-puzzle',number,`calendar-vetoed:${number}:${puzzle.review_round}`);
    }
    database.exec('COMMIT');
    return {puzzle:getCalendarPuzzle(number,userId),changedVote:changed};
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}

function notifyCalendarApproval(puzzle,key) {
  insertUserNotification(puzzle.submitted_by,'calendar-approved',`日历谜题“${puzzle.title}”已通过审核`,
    '至少三人已提交喜爱程度评分，平均分严格大于 0，已进入待分配区。','calendar-puzzle',puzzle.number,`calendar-approved:${key}`);
  const links=database.prepare('SELECT penpa_edit_url,penpa_solve_url FROM puzzles WHERE id=?').get(puzzle.id);
  const missing=[!links.penpa_edit_url?'Penpa 编辑链接':null,!links.penpa_solve_url?'Penpa 解题链接':null].filter(Boolean);
  if (missing.length) insertUserNotification(puzzle.submitted_by,'calendar-links-required',`请补齐谜题“${puzzle.title}”的 Penpa 链接`,
    `投稿已满足喜爱程度评分要求，进入待分配区。请补齐${missing.join('和')}，并对照 Penpa 制图规范准备审核；puzz.link 链接可选。`,
    'calendar-puzzle',puzzle.number,`calendar-links-required:${key}`);
}

export function reenterCalendarPuzzle(number,userId,expectedReviewRound) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const puzzle=database.prepare("SELECT id,calendar_status,review_round FROM puzzles WHERE number=? AND scope='calendar'").get(number);
    if (!puzzle) { database.exec('ROLLBACK'); return {error:'missing'}; }
    if (puzzle.review_round!==expectedReviewRound) { database.exec('ROLLBACK'); return {error:'stale-round'}; }
    if (puzzle.calendar_status!=='leftover') { database.exec('ROLLBACK'); return {error:'not-leftover'}; }
    const result=database.prepare(`UPDATE puzzles SET calendar_status='pending',review_round=review_round+1
      WHERE id=? AND review_round=? AND calendar_status='leftover'`).run(puzzle.id,expectedReviewRound);
    if(result.changes!==1){database.exec('ROLLBACK');return {error:'stale-round'};}
    database.exec('COMMIT');
    return {puzzle:getCalendarPuzzle(number,userId)};
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}

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
export function renameAccount(userId,username,usernameKey,expectedUsername) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const user=database.prepare('SELECT username FROM trusted_users WHERE id=? AND is_active=1 AND password_hash IS NOT NULL').get(userId);
    if (!user?.username) { database.exec('ROLLBACK'); return {error:'inactive'}; }
    if (user.username!==expectedUsername) { database.exec('ROLLBACK'); return {error:'stale'}; }
    if (database.prepare('SELECT 1 FROM trusted_users WHERE username_key=? AND id<>?').get(usernameKey,userId)) { database.exec('ROLLBACK'); return {error:'duplicate'}; }
    database.prepare('UPDATE trusted_users SET username=?,username_key=?,name=? WHERE id=?').run(username,usernameKey,username,userId);
    database.exec('COMMIT');
    return {user:{id:userId,name:username,username}};
  } catch(error) { database.exec('ROLLBACK'); throw error; }
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
