import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const [directory, livePath, usersPath] = process.argv.slice(2);
const quote = (s) => `"${s.replaceAll('"', '""')}"`;
const serialize = (v) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? String(x) : x instanceof Uint8Array ? Array.from(x) : x);
let before, after;
try {
  before = new DatabaseSync(path.join(directory, 'puzarchive.sqlite'), {readOnly: true});
  after = new DatabaseSync(livePath, {readOnly: true});
  before.exec('PRAGMA query_only=ON; BEGIN'); after.exec('PRAGMA query_only=ON; BEGIN');
  let equal = true, tables = 0, count = 0;
  for (const {name} of before.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    tables++;
    const fields = before.prepare(`PRAGMA table_info(${quote(name)})`).all().map(r => r.name);
    const select = `SELECT ${fields.map(quote).join(',')} FROM ${quote(name)} ORDER BY ${fields.map(quote).join(',')}`;
    const original = before.prepare(select).all(); count += original.length;
    let current = after.prepare(select).all();
    if (name.endsWith('_schema_migrations')) {
      const versions = new Set(original.map(r => r.version));
      current = current.filter(r => versions.has(r.version));
    }
    if (name === 'entity_id_sequences') {
      equal &&= original.length === current.length && original.every(r => current.some(n => n.name === r.name && n.next_id >= r.next_id));
    } else equal &&= serialize(original) === serialize(current);
  }
  const integrity = [before, after].every(db => db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok');
  const foreignKeys = [before, after].reduce((n, db) => n + db.prepare('PRAGMA foreign_key_check').all().length, 0);
  const configEqual = fs.readFileSync(path.join(directory, 'trusted-users.json')).equals(fs.readFileSync(usersPath));
  console.log(`baseline_tables=${tables}\nbaseline_rows=${count}\nall_old_fields_equal=${equal}\nbackup_and_live_integrity_ok=${integrity}\nforeign_key_violations=${foreignKeys}\nmember_configuration_unchanged=${configEqual}`);
  if (!equal || !integrity || foreignKeys || !configEqual) process.exitCode = 1;
} catch { console.log('preservation_check_failed=true'); process.exitCode = 2; }
finally { try { before?.close(); } catch {} try { after?.close(); } catch {} }
