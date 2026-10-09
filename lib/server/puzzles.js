import { getDatabase } from './database.js';

function mapPuzzle(row) {
  const userRating = row.user_rating
    ? (() => {
        const value = JSON.parse(row.user_rating);
        return [value.logic, value.intuition, value.enjoyment];
      })()
    : null;

  return {
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
    userRating,
    tags: JSON.parse(row.tags || JSON.stringify([row.input_mode === 'blank' ? '填空题' : row.type]))
  };
}

export function getPuzzles(userId = 'demo-user') {
  const database = getDatabase();
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
  return rows.map(mapPuzzle);
}

export function getPuzzle(number, userId = 'demo-user') {
  return getPuzzles(userId).find((puzzle) => puzzle.number === Number(number)) || null;
}

export function addPuzzle(input) {
  const database = getDatabase();
  const nextNumber = database.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS number FROM puzzles').get().number;
  const result = database.prepare(`INSERT INTO puzzles
    (number, title, type, author, source, url, note, rules, input_mode, answer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nextNumber, input.title, input.type, input.author, input.source, input.url || '', input.note || '等待作者补充说明。', input.rules || '等待作者补充规则。', input.inputMode, input.answer || '');
  return Number(result.lastInsertRowid);
}
