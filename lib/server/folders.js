import { getDatabase } from './database.js';

export function getFolders() {
  const database = getDatabase();
  return database.prepare('SELECT id, name, parent_id AS parent, puzzle_count AS count FROM folders ORDER BY name')
    .all()
    .map((folder) => ({ ...folder }));
}

export function addFolder(name, parentId = null) {
  const database = getDatabase();
  const result = database.prepare('INSERT INTO folders (name, parent_id) VALUES (?, ?)').run(name, parentId || null);
  return Number(result.lastInsertRowid);
}
