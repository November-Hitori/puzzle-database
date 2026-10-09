import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATABASE_KEY = Symbol.for('puzarchive.next.database');

function resolveDatabasePath() {
  const configured = process.env.PUZARCHIVE_DB_PATH;
  if (configured) return path.resolve(/* turbopackIgnore: true */ process.cwd(), configured);
  return path.join(process.cwd(), 'data', 'next', 'puzarchive.sqlite');
}

function createSchema(database) {
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
}

function seedPuzzles(database) {
  const puzzleCount = database.prepare('SELECT COUNT(*) AS count FROM puzzles').get().count;
  if (puzzleCount !== 0) return;

  const insertPuzzle = database.prepare(`INSERT INTO puzzles
    (number, title, type, author, source, url, note, rules, input_mode, answer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const puzzles = [
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
  try {
    for (const puzzle of puzzles) insertPuzzle.run(...puzzle);

    const insertRating = database.prepare(`INSERT INTO puzzle_ratings
      (puzzle_id, user_id, logic, intuition, enjoyment) SELECT id, ?, ?, ?, ? FROM puzzles WHERE number = ?`);
    const ratings = [
      ['seed-thermometer', 3, 2, 5, 128], ['seed-five-cells', 4, 4, 5, 127],
      ['seed-wordoku', 2, 4, 4, 126], ['seed-wrong', 5, 4, 5, 125],
      ['seed-arrow', 3, 3, 4, 124], ['seed-sudoku', 4, 3, 5, 123],
      ['seed-kakuro', 3, 2, 4, 122], ['seed-letter', 4, 4, 4, 121]
    ];
    for (const rating of ratings) insertRating.run(...rating);

    database.prepare(`INSERT OR IGNORE INTO puzzle_completions (puzzle_id, user_id)
      SELECT id, ? FROM puzzles WHERE number IN (127, 125, 123)`).run('demo-user');

    const insertFolder = database.prepare('INSERT INTO folders (name, puzzle_count) VALUES (?, ?)');
    for (const folder of [['Logic Masters India', 38], ['日本パズル協会', 24], ['个人收藏', 17]]) insertFolder.run(...folder);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function seedCollections(database) {
  const collectionCount = database.prepare('SELECT COUNT(*) AS count FROM collections').get().count;
  if (collectionCount !== 0) return;

  const insertCollection = database.prepare(`INSERT INTO collections
    (name, description, source, year, ib, pb, sb) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insertCollection.run("New Year's Puzzle Exchange", '来自 6 位作者的交换题目，适合周末集中完成。', 'PuzArchive community', 2026, 'Original invitation booklet', 'Puzzle booklet 01', 'Solution booklet 01');
  insertCollection.run('Paper & Pencil / Vol. 01', '纸笔谜题的第一册精选。', '日本パズル協会', 2025, 'Invitation booklet', 'Paper booklet 01', 'Solutions 01');

  const collectionIds = database.prepare('SELECT id FROM collections ORDER BY id').all();
  const puzzleIds = database.prepare('SELECT id FROM puzzles ORDER BY number DESC').all();
  const link = database.prepare('INSERT OR IGNORE INTO collection_puzzles (collection_id, puzzle_id, position) VALUES (?, ?, ?)');
  for (const [index, puzzle] of puzzleIds.entries()) link.run(collectionIds[index % collectionIds.length].id, puzzle.id, index + 1);
}

function seedTags(database) {
  const tagCount = database.prepare('SELECT COUNT(*) AS count FROM puzzle_tags').get().count;
  if (tagCount !== 0) return;

  const seedTags = new Map([
    [128, ['Thermometer', 'Example Puzzle']], [127, ['Five Cells']], [126, ['Wordoku']],
    [125, ['Wrong Puzzle', 'Meta']], [124, ['Arrow Maze', 'Example Puzzle']], [123, ['Sudoku']],
    [122, ['Kakuro']], [121, ['Word', 'Example Puzzle']]
  ]);
  const insertTag = database.prepare('INSERT OR IGNORE INTO puzzle_tags (puzzle_id, tag) SELECT id, ? FROM puzzles WHERE number = ?');
  for (const [number, tags] of seedTags) for (const tag of tags) insertTag.run(tag, number);
}

export function getDatabase() {
  if (globalThis[DATABASE_KEY]) return globalThis[DATABASE_KEY];

  const databasePath = resolveDatabasePath();
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  createSchema(database);
  seedPuzzles(database);
  seedCollections(database);
  seedTags(database);
  globalThis[DATABASE_KEY] = database;
  return database;
}

export function resetDatabaseSingleton() {
  delete globalThis[DATABASE_KEY];
}
