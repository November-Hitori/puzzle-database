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
  const tableExists=(name)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const storedIds=tableExists('trusted_users')?new Set(db.prepare('SELECT id FROM trusted_users').all().map((row)=>row.id)):new Set();
  if (members.some((member) => !storedIds.has(member.id))) throw new Error('A configured legacy member is missing from the SQLite identity registry');
  const counts = {};
  for (const table of ['puzzles', 'puzzle_ratings', 'puzzle_completions', 'folders', 'collections', 'rules', 'trusted_users', 'registration_gate', 'rule_item_revisions', 'rule_item_votes', 'rule_item_audit_events']) {
    try {
      counts[table] = db.prepare(`SELECT count(*) AS count FROM "${table}"`).get().count;
    } catch (error) {
      if (!String(error.message).includes('no such table')) throw error;
      counts[table] = 0;
    }
  }
  if (counts.registration_gate > 1) throw new Error('Registration gate state is invalid');
  try {
    counts.calendar_puzzles=db.prepare("SELECT count(*) AS count FROM puzzles WHERE scope='calendar'").get().count;
  } catch (error) {
    if (!String(error.message).includes('no such column')) throw error;
    counts.calendar_puzzles=0;
  }
  try {
    counts.registered_users=db.prepare('SELECT count(*) AS count FROM trusted_users WHERE password_hash IS NOT NULL AND is_active=1').get().count;
  } catch (error) {
    if (!String(error.message).includes('no such column')) throw error;
    counts.registered_users=0;
  }
  console.log(JSON.stringify({ integrity: 'ok', members: members.length, counts }));
} finally {
  db.close();
}
