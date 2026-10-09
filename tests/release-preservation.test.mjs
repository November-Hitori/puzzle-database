import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {migrateCalendarScores} from '../calendar-score-migration.mjs';

const checker = fileURLToPath(new URL('../deploy/preservation-check.mjs', import.meta.url));

function makeFixture(root) {
  const baseline = path.join(root, 'baseline'); fs.mkdirSync(baseline);
  const backupPath = path.join(baseline, 'puzarchive.sqlite');
  const db = new DatabaseSync(backupPath);
  db.exec(`CREATE TABLE trusted_users(id TEXT PRIMARY KEY,password_hash TEXT,is_active INTEGER NOT NULL);
    CREATE TABLE puzzles(id INTEGER PRIMARY KEY,number INTEGER UNIQUE,title TEXT,scope TEXT,submitted_by TEXT,review_round INTEGER,
      calendar_status TEXT,assigned_date TEXT,edit_version INTEGER,penpa_edit_url TEXT,penpa_solve_url TEXT);
    CREATE TABLE calendar_review_votes(puzzle_id INTEGER,review_round INTEGER,user_id TEXT,vote TEXT,updated_at TEXT,PRIMARY KEY(puzzle_id,review_round,user_id));
    CREATE TABLE calendar_review_vote_events(id INTEGER PRIMARY KEY,puzzle_id INTEGER,review_round INTEGER,user_id TEXT,vote TEXT,created_at TEXT);
    CREATE TABLE puzzle_completions(puzzle_id INTEGER,user_id TEXT,completed_at TEXT);
    CREATE TABLE calendar_evaluations(puzzle_id INTEGER,user_id TEXT,review_round INTEGER,difficulty INTEGER,updated_at TEXT);
    CREATE TABLE member_sessions(token_hash TEXT,user_id TEXT,expires_at INTEGER);
    CREATE TABLE user_notifications(id INTEGER PRIMARY KEY,recipient_user_id TEXT,kind TEXT,title TEXT,body TEXT,entity_type TEXT,entity_id INTEGER,dedupe_key TEXT UNIQUE,created_at TEXT,read_at TEXT);
    CREATE TABLE calendar_review_schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT);
    CREATE TABLE entity_id_sequences(name TEXT PRIMARY KEY,next_id INTEGER);
    INSERT INTO trusted_users VALUES('uploader','fixture-only-hash',1);
    INSERT INTO trusted_users VALUES('inactive-uploader','fixture-only-hash-2',0);
    INSERT INTO puzzles VALUES(10,910,'Will approve','calendar','uploader',1,'pending',NULL,4,'edit','solve');
    INSERT INTO puzzles VALUES(11,911,'Archived veto','calendar','uploader',2,'leftover','2028-01-11',7,'edit','solve');
    INSERT INTO puzzles VALUES(12,912,'Will return pending','calendar','uploader',1,'approved','2028-01-12',9,'edit','solve');
    INSERT INTO puzzles VALUES(13,913,'Still waiting','calendar','uploader',1,'pending',NULL,2,'edit','solve');
    INSERT INTO puzzles VALUES(14,914,'Public puzzle','public',NULL,1,'pending',NULL,1,'','');
    INSERT INTO puzzles VALUES(15,915,'Inactive uploader still receives helper notification','calendar','inactive-uploader',1,'pending',NULL,3,'edit','solve');
    INSERT INTO puzzles VALUES(16,916,'Missing edit link','calendar','uploader',1,'pending',NULL,5,'','solve');
    INSERT INTO calendar_review_votes VALUES(10,1,'a','support','vote-time-a');
    INSERT INTO calendar_review_votes VALUES(10,1,'b','neutral','vote-time-b');
    INSERT INTO calendar_review_votes VALUES(10,1,'c','support','vote-time-c');
    INSERT INTO calendar_review_votes VALUES(11,2,'a','support','vote-time-d');
    INSERT INTO calendar_review_votes VALUES(11,2,'b','support','vote-time-e');
    INSERT INTO calendar_review_votes VALUES(11,2,'c','support','vote-time-f');
    INSERT INTO calendar_review_votes VALUES(12,1,'a','oppose','vote-time-g');
    INSERT INTO calendar_review_votes VALUES(12,1,'b','oppose','vote-time-h');
    INSERT INTO calendar_review_votes VALUES(12,1,'c','oppose','vote-time-i');
    INSERT INTO calendar_review_votes VALUES(13,1,'a','support','vote-time-j');
    INSERT INTO calendar_review_votes VALUES(13,1,'b','support','vote-time-k');
    INSERT INTO calendar_review_votes VALUES(11,2,'d','veto','vote-time-l');
    INSERT INTO calendar_review_votes VALUES(15,1,'a','support','vote-time-m');
    INSERT INTO calendar_review_votes VALUES(15,1,'b','support','vote-time-n');
    INSERT INTO calendar_review_votes VALUES(15,1,'c','support','vote-time-o');
    INSERT INTO calendar_review_votes VALUES(16,1,'a','support','vote-time-p');
    INSERT INTO calendar_review_votes VALUES(16,1,'b','support','vote-time-q');
    INSERT INTO calendar_review_votes VALUES(16,1,'c','support','vote-time-r');
    INSERT INTO calendar_review_vote_events VALUES(101,10,1,'a','support','event-time-a');
    INSERT INTO calendar_review_vote_events VALUES(102,10,1,'b','neutral','event-time-b');
    INSERT INTO calendar_review_vote_events VALUES(103,10,1,'c','support','event-time-c');
    INSERT INTO calendar_review_vote_events VALUES(104,11,2,'a','support','event-time-d');
    INSERT INTO calendar_review_vote_events VALUES(105,11,2,'b','support','event-time-e');
    INSERT INTO calendar_review_vote_events VALUES(106,11,2,'c','support','event-time-f');
    INSERT INTO calendar_review_vote_events VALUES(107,11,2,'d','veto','event-time-g');
    INSERT INTO calendar_review_vote_events VALUES(108,15,1,'a','support','event-time-h');
    INSERT INTO calendar_review_vote_events VALUES(109,15,1,'b','support','event-time-i');
    INSERT INTO calendar_review_vote_events VALUES(110,15,1,'c','support','event-time-j');
    INSERT INTO calendar_review_vote_events VALUES(111,16,1,'a','support','event-time-k');
    INSERT INTO calendar_review_vote_events VALUES(112,16,1,'b','support','event-time-l');
    INSERT INTO calendar_review_vote_events VALUES(113,16,1,'c','support','event-time-m');
    INSERT INTO user_notifications VALUES(1,'uploader','rule-approved','old title','old body','rule',17,'rule-approved:17','old-notification-time',NULL);
    INSERT INTO puzzle_completions VALUES(10,'uploader','completion-time');
    INSERT INTO calendar_evaluations VALUES(10,'a',1,5,'evaluation-time');
    INSERT INTO member_sessions VALUES('isolated-session-token-hash','uploader',9999999999999);
    INSERT INTO calendar_review_schema_migrations VALUES(1,'migration-one-time');
    INSERT INTO entity_id_sequences VALUES('puzzles',915);`);
  db.close();
  const memberPath = path.join(root, 'members.json');
  fs.writeFileSync(memberPath, '[{"id":"uploader","name":"Fixture","accessCode":"fixture-only"}]');
  fs.copyFileSync(memberPath, path.join(baseline, 'trusted-users.json'));
  return {baseline, backupPath, memberPath};
}

function applyMigration(livePath) {
  const db = new DatabaseSync(livePath);
  migrateCalendarScores(db, (puzzle) => {
    const key = `liking-migration:${puzzle.number}:${puzzle.review_round}`;
    db.prepare(`INSERT INTO user_notifications
      (recipient_user_id,kind,title,body,entity_type,entity_id,dedupe_key,created_at)
      VALUES (?,'calendar-approved',?,'至少三人已提交喜爱程度评分，平均分严格大于 0，已进入待分配区。','calendar-puzzle',?,?,CURRENT_TIMESTAMP)`)
      .run(puzzle.submitted_by,`日历谜题“${puzzle.title}”已通过审核`,puzzle.number,`calendar-approved:${key}`);
    const links = db.prepare('SELECT penpa_edit_url,penpa_solve_url FROM puzzles WHERE id=?').get(puzzle.id);
    const missing = [!links.penpa_edit_url?'Penpa 编辑链接':null,!links.penpa_solve_url?'Penpa 解题链接':null].filter(Boolean);
    if (missing.length) {
      db.prepare(`INSERT INTO user_notifications
        (recipient_user_id,kind,title,body,entity_type,entity_id,dedupe_key,created_at)
        VALUES (?,'calendar-links-required',?,?,'calendar-puzzle',?,?,CURRENT_TIMESTAMP)`)
        .run(puzzle.submitted_by,`请补齐谜题“${puzzle.title}”的 Penpa 链接`,
          `投稿已满足喜爱程度评分要求，进入待分配区。请补齐${missing.join('和')}，并对照 Penpa 制图规范准备审核；puzz.link 链接可选。`,
          puzzle.number,`calendar-links-required:${key}`);
    }
  });
  db.close();
}

function run(baseline, livePath, memberPath) {
  return spawnSync(process.execPath, [checker, baseline, livePath, memberPath], {encoding: 'utf8'});
}

test('release preservation accepts expected numeric score migration and rejects legacy data changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-release-preservation-'));
  try {
    const {baseline, backupPath, memberPath} = makeFixture(root);
    const livePath = path.join(root, 'live.sqlite'); fs.copyFileSync(backupPath, livePath); applyMigration(livePath);
    let result = run(baseline, livePath, memberPath);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /all_old_fields_equal=true/);
    assert.ok(!result.stdout.includes('fixture-only'));

    const tamper = (sql) => {
      const db = new DatabaseSync(livePath); db.exec(sql); db.close();
      const failed = run(baseline, livePath, memberPath); assert.equal(failed.status, 1, failed.stdout);
      fs.copyFileSync(backupPath, livePath); applyMigration(livePath);
    };
    tamper("UPDATE trusted_users SET password_hash='changed' WHERE id='uploader'");
    tamper("UPDATE calendar_review_votes SET score=1 WHERE puzzle_id=10 AND user_id='a'");
    tamper("UPDATE calendar_review_votes SET vote='oppose',score=-2 WHERE puzzle_id=10 AND user_id='a'");
    tamper("UPDATE calendar_review_vote_events SET created_at='changed' WHERE id=101");
    tamper('DELETE FROM calendar_review_vote_events WHERE id=101');
    tamper("UPDATE puzzle_completions SET completed_at='changed'");
    tamper("UPDATE puzzles SET edit_version=99 WHERE id=10");
    tamper("UPDATE puzzles SET assigned_date='2028-12-31' WHERE id=12");
    tamper("UPDATE user_notifications SET recipient_user_id='inactive-uploader' WHERE id=1");
    tamper("UPDATE user_notifications SET body='changed' WHERE id=(SELECT id FROM user_notifications WHERE kind='calendar-approved' LIMIT 1)");
    tamper("UPDATE user_notifications SET read_at='2026-10-09 12:00:00' WHERE id=(SELECT id FROM user_notifications WHERE kind='calendar-approved' LIMIT 1)");
    tamper("UPDATE user_notifications SET entity_id=999 WHERE id=(SELECT id FROM user_notifications WHERE kind='calendar-approved' LIMIT 1)");
    tamper("INSERT INTO user_notifications(recipient_user_id,kind,title,body,entity_type,entity_id,dedupe_key,created_at) VALUES('uploader','other','extra','extra','calendar-puzzle',910,'unexpected-notification','2026-10-09 12:00:00')");

    fs.appendFileSync(memberPath, ' ');
    result = run(baseline, livePath, memberPath); assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /member_configuration_unchanged=false/);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('release preservation accepts an idempotent baseline already at migration four', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-release-idempotent-'));
  try {
    const {baseline, backupPath, memberPath} = makeFixture(root);
    const livePath = path.join(root, 'live.sqlite'); fs.copyFileSync(backupPath, livePath); applyMigration(livePath);
    fs.copyFileSync(livePath, path.join(baseline, 'puzarchive.sqlite'));
    const result = run(baseline, livePath, memberPath);
    assert.equal(result.status, 0, result.stdout);
    const changed = new DatabaseSync(livePath); changed.exec("UPDATE puzzles SET title='tampered' WHERE id=11"); changed.close();
    assert.equal(run(baseline, livePath, memberPath).status, 1);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('release preservation retains the original additive-schema and account checks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-release-additive-'));
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
      INSERT INTO trusted_users VALUES('fixture-user','fixture-hash');
      INSERT INTO member_sessions VALUES('isolated-session-hash','fixture-user',9999999999999);
      INSERT INTO puzzle_completions VALUES(321,'fixture-user','completion-time');
      INSERT INTO calendar_evaluations VALUES(321,'fixture-user',2,4);
      INSERT INTO example_schema_migrations VALUES(1);
      INSERT INTO entity_id_sequences VALUES('puzzles',400);`);
    old.close();
    const livePath = path.join(root, 'live.sqlite'); fs.copyFileSync(backupPath, livePath);
    const memberPath = path.join(root, 'members.json');
    fs.writeFileSync(memberPath, '[{"id":"fixture-user","name":"Fixture","accessCode":"fixture-only"}]');
    fs.copyFileSync(memberPath, path.join(baseline, 'trusted-users.json'));
    const live = new DatabaseSync(livePath);
    live.exec('ALTER TABLE trusted_users ADD COLUMN extra TEXT; INSERT INTO example_schema_migrations VALUES(2); UPDATE entity_id_sequences SET next_id=450;');
    let result = run(baseline, livePath, memberPath);
    assert.equal(result.status, 0, result.stdout);
    assert.ok(!result.stdout.includes('fixture-only'));
    live.exec("UPDATE trusted_users SET password_hash='changed'");
    assert.equal(run(baseline, livePath, memberPath).status, 1);
    live.exec("UPDATE trusted_users SET password_hash='fixture-hash'; UPDATE calendar_evaluations SET difficulty=5");
    assert.equal(run(baseline, livePath, memberPath).status, 1);
    live.close();
    fs.appendFileSync(memberPath, ' ');
    result = run(baseline, livePath, memberPath);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /member_configuration_unchanged=false/);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});
