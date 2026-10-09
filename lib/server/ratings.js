import { getDatabase } from './database.js';

export function completeAndRate(number, userId, ratings) {
  const database = getDatabase();
  const puzzle = database.prepare('SELECT id FROM puzzles WHERE number = ?').get(number);
  if (!puzzle) return false;

  database.prepare('INSERT OR REPLACE INTO puzzle_completions (puzzle_id, user_id) VALUES (?, ?)').run(puzzle.id, userId);
  database.prepare(`INSERT INTO puzzle_ratings (puzzle_id, user_id, logic, intuition, enjoyment)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(puzzle_id, user_id) DO UPDATE SET
    logic = excluded.logic,
    intuition = excluded.intuition,
    enjoyment = excluded.enjoyment,
    created_at = CURRENT_TIMESTAMP`)
    .run(puzzle.id, userId, ratings[0], ratings[1], ratings[2]);
  return true;
}
