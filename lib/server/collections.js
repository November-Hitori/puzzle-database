import { getDatabase } from './database.js';

export function getCollections() {
  const database = getDatabase();
  return database.prepare(`SELECT c.id, c.name, c.description, c.source, c.year, c.ib, c.pb, c.sb,
    COUNT(cp.puzzle_id) AS puzzle_count
    FROM collections c LEFT JOIN collection_puzzles cp ON cp.collection_id = c.id
    GROUP BY c.id ORDER BY c.year DESC, c.id`)
    .all()
    .map((collection) => ({ ...collection }));
}

export function getCollection(id, userId = 'demo-user') {
  const database = getDatabase();
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

  return {
    ...collection,
    puzzles: puzzles.map((puzzle) => ({
      ...puzzle,
      completed: Boolean(puzzle.completed),
      ratings: [Number(puzzle.logic_rating), Number(puzzle.intuition_rating), Number(puzzle.enjoyment_rating)],
      votes: Number(puzzle.votes)
    }))
  };
}
