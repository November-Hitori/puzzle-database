import { getDatabase } from './database.js';

export function addPuzzleTag(number, tag) {
  const database = getDatabase();
  const result = database.prepare('INSERT OR IGNORE INTO puzzle_tags (puzzle_id, tag) SELECT id, ? FROM puzzles WHERE number = ?').run(tag, number);
  return result.changes > 0;
}

export function getTags() {
  const database = getDatabase();
  return database.prepare('SELECT tag, COUNT(*) AS count FROM puzzle_tags GROUP BY tag ORDER BY count DESC, tag')
    .all()
    .map((tag) => ({ ...tag }));
}
