import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const directory = path.resolve(process.argv[2] || '');
const dbPath = path.join(directory, 'puzarchive.sqlite');
const usersPath = path.join(directory, 'trusted-users.json');
if (!process.argv[2] || !fs.existsSync(dbPath) || !fs.existsSync(usersPath)) {
  throw new Error('Usage: node restore-check.mjs BACKUP_DIRECTORY');
}

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const integrity = db.prepare('PRAGMA integrity_check').get();
  if (integrity.integrity_check !== 'ok') throw new Error('SQLite integrity check failed');
  const members = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  if (!Array.isArray(members) || members.length === 0) throw new Error('Trusted member backup is invalid');
  const storedIds = new Set(db.prepare('SELECT id FROM trusted_users').all().map((row) => row.id));
  if (members.some((member) => !storedIds.has(member.id)) || members.length !== storedIds.size) {
    throw new Error('Trusted member IDs do not match the SQLite member registry');
  }
  const counts = {};
  for (const table of ['puzzles', 'puzzle_ratings', 'puzzle_completions', 'folders', 'collections', 'rules', 'calendar_puzzles', 'trusted_users']) {
    try {
      counts[table] = db.prepare(`SELECT count(*) AS count FROM "${table}"`).get().count;
    } catch (error) {
      if (!String(error.message).includes('no such table')) throw error;
      counts[table] = 0;
    }
  }
  console.log(JSON.stringify({ integrity: 'ok', members: members.length, counts }));
} finally {
  db.close();
}
