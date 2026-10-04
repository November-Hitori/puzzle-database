import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(rootDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const database = new DatabaseSync(path.join(dataDir, 'puzarchive.sqlite'));

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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
`);

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
    (number, title, type, author, source, url, note, rules, input_mode, answer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nextNumber, input.title, input.type, input.author, input.source, input.url || '', input.note || '等待作者补充说明。', input.rules || '等待作者补充规则。', input.inputMode, input.answer || '');
  return Number(result.lastInsertRowid);
}

export function completeAndRate(number, userId, ratings) {
  const puzzle = database.prepare('SELECT id FROM puzzles WHERE number = ?').get(number);
  if (!puzzle) return false;
  database.prepare('INSERT OR REPLACE INTO puzzle_completions (puzzle_id, user_id) VALUES (?, ?)').run(puzzle.id, userId);
  database.prepare(`INSERT INTO puzzle_ratings (puzzle_id, user_id, logic, intuition, enjoyment)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(puzzle_id, user_id) DO UPDATE SET
    logic = excluded.logic, intuition = excluded.intuition, enjoyment = excluded.enjoyment, created_at = CURRENT_TIMESTAMP`)
    .run(puzzle.id, userId, ratings[0], ratings[1], ratings[2]);
}

export function getFolders() { return database.prepare('SELECT id, name, parent_id AS parent, puzzle_count AS count FROM folders ORDER BY name').all(); }
export function addFolder(name, parentId = null) { const result = database.prepare('INSERT INTO folders (name, parent_id) VALUES (?, ?)').run(name, parentId || null); return Number(result.lastInsertRowid); }
export function addPuzzleTag(number, tag) { const result = database.prepare('INSERT OR IGNORE INTO puzzle_tags (puzzle_id, tag) SELECT id, ? FROM puzzles WHERE number = ?').run(tag, number); return result.changes > 0; }
export function getTags() { return database.prepare('SELECT tag, COUNT(*) AS count FROM puzzle_tags GROUP BY tag ORDER BY count DESC, tag').all(); }

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
