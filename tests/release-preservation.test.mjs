import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('release preservation accepts additive schema and rejects account, review and member-config changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-release-preservation-'));
  try {
    const baseline = path.join(root, 'baseline'); fs.mkdirSync(baseline);
    const backupPath = path.join(baseline, 'puzarchive.sqlite');
    const old = new DatabaseSync(backupPath);
    old.exec(`CREATE TABLE trusted_users(id TEXT PRIMARY KEY,password_hash TEXT);
      CREATE TABLE puzzle_completions(puzzle_id INTEGER,user_id TEXT,completed_at TEXT);
      CREATE TABLE calendar_evaluations(puzzle_id INTEGER,user_id TEXT,review_round INTEGER,difficulty INTEGER);
      CREATE TABLE member_sessions(token_hash TEXT,user_id TEXT,expires_at INTEGER);
      CREATE TABLE example_schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE entity_id_sequences(name TEXT PRIMARY KEY,next_id INTEGER);
      INSERT INTO trusted_users VALUES('fixture-user','fake-private-password-hash');
      INSERT INTO member_sessions VALUES('fake-private-session','fixture-user',9999999999999);
      INSERT INTO puzzle_completions VALUES(321,'fixture-user','2026-01-01');
      INSERT INTO calendar_evaluations VALUES(321,'fixture-user',2,4);
      INSERT INTO example_schema_migrations VALUES(1);
      INSERT INTO entity_id_sequences VALUES('puzzles',400);`);
    old.close();
    const livePath = path.join(root, 'live.sqlite');fs.copyFileSync(backupPath, livePath);
    const memberPath = path.join(root, 'members.json');
    fs.writeFileSync(memberPath, '[{"id":"fixture-user","name":"Fixture","accessCode":"fake-isolated-invite"}]');
    fs.copyFileSync(memberPath, path.join(baseline, 'trusted-users.json'));
    const live = new DatabaseSync(livePath);
    live.exec('ALTER TABLE trusted_users ADD COLUMN extra TEXT; INSERT INTO example_schema_migrations VALUES(2); UPDATE entity_id_sequences SET next_id=450;');
    const checker = fileURLToPath(new URL('../deploy/preservation-check.mjs', import.meta.url));
    const run = () => spawnSync(process.execPath, [checker, baseline, livePath, memberPath], {encoding: 'utf8'});
    let result = run();assert.equal(result.status, 0, result.stdout);
    assert.ok(!result.stdout.includes('fixture-user'));assert.ok(!result.stdout.includes('fake-private'));
    live.exec("UPDATE trusted_users SET password_hash='changed'");assert.equal(run().status, 1);
    live.exec("UPDATE trusted_users SET password_hash='fake-private-password-hash'; UPDATE calendar_evaluations SET difficulty=5");assert.equal(run().status, 1);
    live.exec('UPDATE calendar_evaluations SET difficulty=4; DELETE FROM puzzle_completions');assert.equal(run().status, 1);
    live.close();fs.copyFileSync(backupPath, livePath);
    fs.appendFileSync(memberPath, ' ');result = run();assert.equal(result.status, 1);assert.match(result.stdout, /member_configuration_unchanged=false/);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});
