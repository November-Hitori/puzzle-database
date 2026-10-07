import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importCommand = path.join(projectDir, 'scripts/import-rules.mjs');
const validRecord = (sourceRow, titleZh, author = '') => ({
  sourceRow, titleZh, titleEn: '', rulesZh: ['中文规则'], rulesEn: [], category: '路径',
  isVariant: false, baseRuleId: null, exampleUrl: 'https://penpa-edit.com/?m=edit&p=fixture', exampleAuthor: author
});
const oversizedButSupportedUrl = `https://swaroopg92.github.io/penpa-edit/#m=edit&p=${'x'.repeat(3300)}`;

test('import defaults to database-free dry-run and applies additively/idempotently', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-import-'));
  try {
    const payloadPath = path.join(tempDir, 'payload.json');
    const dbPath = path.join(tempDir, 'rules.sqlite');
    fs.writeFileSync(payloadPath, JSON.stringify({ format: 'puzarchive-rule-import-v1', records: [
      validRecord(3, '  既有规则  '), { ...validRecord(4, '新规则', '作者名'), exampleUrl: oversizedButSupportedUrl }, validRecord(5, '第二规则'),
      { ...validRecord(6, '', ''), titleEn: 'English same', rulesZh: [], exampleUrl: '' },
      { ...validRecord(7, '', ''), titleEn: 'Legacy english', rulesZh: [], exampleUrl: '' }
    ] }), { mode: 0o600 });
    const database = new DatabaseSync(dbPath);
    database.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE rules (id INTEGER PRIMARY KEY,title_zh TEXT NOT NULL,title_en TEXT NOT NULL,rules_zh TEXT NOT NULL,rules_en TEXT NOT NULL,category TEXT NOT NULL,is_variant INTEGER NOT NULL,base_rule_id INTEGER,example_url TEXT NOT NULL DEFAULT '',example_author TEXT NOT NULL DEFAULT '',name_revision INTEGER NOT NULL DEFAULT 1,description_revision INTEGER NOT NULL DEFAULT 1,example_revision INTEGER NOT NULL DEFAULT 1,edit_version INTEGER NOT NULL DEFAULT 1,delete_token TEXT NOT NULL DEFAULT '' UNIQUE);
      CREATE TABLE entity_id_sequences (name TEXT PRIMARY KEY,next_id INTEGER NOT NULL CHECK(next_id>0));
      INSERT INTO entity_id_sequences VALUES('rules',78);
      CREATE TABLE rule_item_revisions (rule_id INTEGER NOT NULL,item TEXT NOT NULL,revision INTEGER NOT NULL,content_json TEXT NOT NULL,changed_by_user_id TEXT,PRIMARY KEY(rule_id,item,revision));
      CREATE TABLE rule_item_votes (rule_id INTEGER NOT NULL,item TEXT NOT NULL,revision INTEGER NOT NULL,user_id TEXT NOT NULL,decision TEXT NOT NULL);
      CREATE TABLE rule_item_audit_events (id INTEGER PRIMARY KEY,rule_id INTEGER NOT NULL,item TEXT NOT NULL,revision INTEGER NOT NULL,user_id TEXT NOT NULL,decision TEXT NOT NULL);
      INSERT INTO rules(id,title_zh,title_en,rules_zh,rules_en,category,is_variant,example_url,example_author,delete_token) VALUES
        (76,'','Legacy english','[]','[]','其它',0,'','','legacy-token-76'),(77,'既有规则','English same','["old"]','[]','其它',0,'','','legacy-token-77');
      INSERT INTO rule_item_revisions(rule_id,item,revision,content_json) VALUES
        (76,'name',1,'{"titleZh":"","titleEn":"Legacy english"}'),(77,'name',1,'{"titleZh":"既有规则","titleEn":"English same"}');`);
    database.close();

    const dryRun = spawnSync(process.execPath, [importCommand, '--payload', payloadPath], { encoding: 'utf8' });
    assert.equal(dryRun.status, 0, `${dryRun.stderr}\n${dryRun.error || ''}\n${dryRun.stdout}`);
    assert.deepEqual(JSON.parse(dryRun.stdout), { mode: 'dry-run', sourceRows: 5, inserted: 0, existingSkipped: null, total: 5, databaseOpened: false });
    assert.equal(fs.existsSync(path.join(tempDir, 'should-not-exist.sqlite')), false);

    const apply = () => spawnSync(process.execPath, [importCommand, '--payload', payloadPath, '--apply', '--db', dbPath], { encoding: 'utf8' });
    const first = apply();
    assert.equal(first.status, 0, `${first.stderr}\n${first.error || ''}\n${first.stdout}`);
    assert.deepEqual(JSON.parse(first.stdout), { mode: 'apply', sourceRows: 5, inserted: 3, existingSkipped: 2, existingSkippedRows: [3, 7], total: 5 });
    const tokenSnapshot = new DatabaseSync(dbPath, { readOnly: true });
    const insertedTokens = tokenSnapshot.prepare('SELECT id,delete_token FROM rules WHERE id>77 ORDER BY id').all().map((row) => ({ ...row }));
    assert.equal(insertedTokens.length, 3);
    assert.ok(insertedTokens.every((row) => row.delete_token));
    assert.equal(new Set(insertedTokens.map((row) => row.delete_token)).size, 3);
    tokenSnapshot.close();
    const sequenceAfterFirst = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(sequenceAfterFirst.prepare("SELECT next_id FROM entity_id_sequences WHERE name='rules'").get().next_id,81);
    sequenceAfterFirst.close();
    const second = apply();
    assert.equal(second.status, 0, `${second.stderr}\n${second.error || ''}\n${second.stdout}`);
    assert.deepEqual(JSON.parse(second.stdout), { mode: 'apply', sourceRows: 5, inserted: 0, existingSkipped: 5, existingSkippedRows: [3, 4, 5, 6, 7], total: 5 });

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    assert.deepEqual(verify.prepare('SELECT id,title_zh,example_author FROM rules ORDER BY id').all().map((row) => ({ ...row })), [
      { id: 76, title_zh: '', example_author: '' },
      { id: 77, title_zh: '既有规则', example_author: '' },
      { id: 78, title_zh: '新规则', example_author: '作者名' },
      { id: 79, title_zh: '第二规则', example_author: '' },
      { id: 80, title_zh: '', example_author: '' }
    ]);
    assert.deepEqual(verify.prepare('SELECT id,delete_token FROM rules WHERE id>77 ORDER BY id').all().map((row) => ({ ...row })), insertedTokens);
    assert.equal(verify.prepare("SELECT next_id FROM entity_id_sequences WHERE name='rules'").get().next_id,81);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM rule_item_revisions').get().count, 11);
    assert.equal(verify.prepare('SELECT LENGTH(example_url) AS chars FROM rules WHERE title_zh=?').get('新规则').chars, oversizedButSupportedUrl.length);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM rule_item_votes').get().count, 0);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM rule_item_audit_events').get().count, 0);
    verify.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('import rejects invalid payload before touching a target database', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-import-invalid-'));
  try {
    const payloadPath = path.join(tempDir, 'invalid.json');
    fs.writeFileSync(payloadPath, JSON.stringify({ format: 'puzarchive-rule-import-v1', records: [validRecord(3, 'bad', 'x'.repeat(201))] }), { mode: 0o600 });
    const result = spawnSync(process.execPath, [importCommand, '--payload', payloadPath, '--apply', '--db', path.join(tempDir, 'missing.sqlite')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid example author/, `${result.error || ''} ${result.stdout}`);
    assert.equal(fs.existsSync(path.join(tempDir, 'missing.sqlite')), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('full private workbook payload imports atomically, idempotently, and without altering unrelated state', {
  skip: !process.env.PUZARCHIVE_PRIVATE_RULE_IMPORT_PAYLOAD
}, () => {
  const payloadPath = process.env.PUZARCHIVE_PRIVATE_RULE_IMPORT_PAYLOAD;
  const payloadStat = fs.lstatSync(payloadPath);
  assert.ok(payloadStat.isFile() && !payloadStat.isSymbolicLink() && !(payloadStat.mode & 0o077));
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  const records = payload.records;
  assert.equal(records.length, 306);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puzarchive-full-import-'));
  try {
    const dbPath = path.join(tempDir, 'isolated.sqlite');
    const database = new DatabaseSync(dbPath);
    database.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE rules (id INTEGER PRIMARY KEY,title_zh TEXT NOT NULL,title_en TEXT NOT NULL,rules_zh TEXT NOT NULL,rules_en TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('涂黑','填数','分区','置物','路径','其它')),is_variant INTEGER NOT NULL,base_rule_id INTEGER,example_url TEXT NOT NULL DEFAULT '',example_author TEXT NOT NULL DEFAULT '',name_revision INTEGER NOT NULL DEFAULT 1,description_revision INTEGER NOT NULL DEFAULT 1,example_revision INTEGER NOT NULL DEFAULT 1,edit_version INTEGER NOT NULL DEFAULT 1,delete_token TEXT NOT NULL DEFAULT '' UNIQUE);
      CREATE TABLE entity_id_sequences (name TEXT PRIMARY KEY,next_id INTEGER NOT NULL CHECK(next_id>0));
      INSERT INTO entity_id_sequences VALUES('rules',43);
      CREATE TABLE rule_item_revisions (rule_id INTEGER NOT NULL,item TEXT NOT NULL,revision INTEGER NOT NULL,content_json TEXT NOT NULL,changed_by_user_id TEXT,PRIMARY KEY(rule_id,item,revision));
      CREATE TABLE rule_item_votes (rule_id INTEGER NOT NULL,item TEXT NOT NULL,revision INTEGER NOT NULL,user_id TEXT NOT NULL,decision TEXT NOT NULL);
      CREATE TABLE rule_item_audit_events (id INTEGER PRIMARY KEY,rule_id INTEGER NOT NULL,item TEXT NOT NULL,revision INTEGER NOT NULL,user_id TEXT NOT NULL,decision TEXT NOT NULL);
      CREATE TABLE trusted_users (id TEXT PRIMARY KEY,name TEXT NOT NULL,password_hash TEXT,is_active INTEGER NOT NULL);
      CREATE TABLE member_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE registration_gate (id INTEGER PRIMARY KEY,token_hash TEXT NOT NULL,pending_legacy_user_id TEXT,updated_at TEXT NOT NULL);
      CREATE TABLE puzzles (id INTEGER PRIMARY KEY,title TEXT NOT NULL);
      CREATE TABLE puzzle_ratings (id INTEGER PRIMARY KEY,puzzle_id INTEGER NOT NULL,user_id TEXT NOT NULL,logic INTEGER NOT NULL);
      CREATE TABLE puzzle_completions (puzzle_id INTEGER NOT NULL,user_id TEXT NOT NULL,completed_at TEXT NOT NULL);
      CREATE TABLE folders (id INTEGER PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE collections (id INTEGER PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE collection_puzzles (collection_id INTEGER NOT NULL,puzzle_id INTEGER NOT NULL,position INTEGER NOT NULL);
      INSERT INTO trusted_users VALUES('fixture-user','Fixture member','private-test-hash',1);
      INSERT INTO member_sessions VALUES('private-test-session-hash','fixture-user',9999999999999);
      INSERT INTO registration_gate VALUES(1,'private-test-gate-hash','fixture-user','2026-01-01');
      INSERT INTO puzzles VALUES(501,'preserved puzzle');
      INSERT INTO puzzle_ratings VALUES(1,501,'fixture-user',4);
      INSERT INTO puzzle_completions VALUES(501,'fixture-user','2026-01-02');
      INSERT INTO folders VALUES(3,'preserved folder');
      INSERT INTO collections VALUES(8,'preserved collection');
      INSERT INTO collection_puzzles VALUES(8,501,1);`);

    const overlap = records[0];
    database.prepare(`INSERT INTO rules(id,title_zh,title_en,rules_zh,rules_en,category,is_variant,base_rule_id,example_url,example_author)
      VALUES(42,?,?,?,?,?,0,NULL,?,?)`).run(overlap.titleZh, 'Old English value', '["legacy rule"]', '[]', '其它', '', '');
    for (const item of ['name', 'description', 'example']) database.prepare(`INSERT INTO rule_item_revisions(rule_id,item,revision,content_json)
      VALUES(42,?,1,?)`).run(item, JSON.stringify(item === 'example' ? { exampleUrl: '' } : { preserved: true }));
    database.prepare('INSERT INTO rule_item_votes VALUES(42,\'name\',1,\'fixture-user\',\'approve\')').run();
    database.prepare('INSERT INTO rule_item_audit_events(rule_id,item,revision,user_id,decision) VALUES(42,\'name\',1,\'fixture-user\',\'approve\')').run();

    const preservedTables = ['trusted_users', 'member_sessions', 'registration_gate', 'puzzles', 'puzzle_ratings', 'puzzle_completions', 'folders', 'collections', 'collection_puzzles'];
    const snapshot = () => Object.fromEntries(preservedTables.map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row }))]));
    const before = snapshot();
    const existingRuleBefore = database.prepare('SELECT * FROM rules WHERE id=42').get();
    const existingRevisionsBefore = database.prepare('SELECT * FROM rule_item_revisions WHERE rule_id=42 ORDER BY item').all().map((row) => ({ ...row }));
    database.close();

    const apply = () => spawnSync(process.execPath, [importCommand, '--payload', payloadPath, '--apply', '--db', dbPath], { encoding: 'utf8' });
    const first = apply();
    assert.equal(first.status, 0, `${first.stderr}\n${first.error || ''}\n${first.stdout}`);
    const firstResult = JSON.parse(first.stdout);
    assert.equal(firstResult.inserted, records.length - 1);
    assert.equal(firstResult.existingSkipped, 1);
    const second = apply();
    assert.equal(second.status, 0, `${second.stderr}\n${second.error || ''}\n${second.stdout}`);
    const secondResult = JSON.parse(second.stdout);
    assert.equal(secondResult.inserted, 0);
    assert.equal(secondResult.existingSkipped, records.length);

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    const currentState = Object.fromEntries(preservedTables.map((table) => [table, verify.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row }))]));
    assert.deepEqual(currentState, before);
    assert.deepEqual({ ...verify.prepare('SELECT * FROM rules WHERE id=42').get() }, { ...existingRuleBefore });
    assert.deepEqual(verify.prepare('SELECT * FROM rule_item_revisions WHERE rule_id=42 ORDER BY item').all().map((row) => ({ ...row })), existingRevisionsBefore);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM rules').get().count, records.length);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM rule_item_revisions').get().count, 3 + (records.length - 1) * 3);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM rule_item_votes').get().count, 1);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM rule_item_audit_events').get().count, 1);

    let fieldsMatch = true, newRulesHaveNoReviews = true;
    for (const [index, record] of records.entries()) {
      const isOverlap = index === 0;
      const row = isOverlap
        ? verify.prepare('SELECT * FROM rules WHERE id=42').get()
        : record.titleZh.trim()
          ? verify.prepare('SELECT * FROM rules WHERE title_zh=?').get(record.titleZh)
          : verify.prepare('SELECT * FROM rules WHERE title_zh=\'\' AND title_en=?').get(record.titleEn);
      if (isOverlap) {
        fieldsMatch &&= row.title_zh === record.titleZh;
        continue;
      }
      fieldsMatch &&= row.title_zh === record.titleZh && row.title_en === record.titleEn && row.rules_zh === JSON.stringify(record.rulesZh) && row.rules_en === JSON.stringify(record.rulesEn) && row.category === record.category && row.example_url === record.exampleUrl && row.example_author === record.exampleAuthor;
      newRulesHaveNoReviews &&= verify.prepare('SELECT COUNT(*) AS count FROM rule_item_votes WHERE rule_id=?').get(row.id).count === 0;
      newRulesHaveNoReviews &&= verify.prepare('SELECT COUNT(*) AS count FROM rule_item_audit_events WHERE rule_id=?').get(row.id).count === 0;
    }
    assert.equal(fieldsMatch, true);
    assert.equal(newRulesHaveNoReviews, true);
    verify.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('workbook parser safety and normalization unit suite passes', () => {
  const python = spawnSync('python3', ['-B', path.join(projectDir, 'tests/test_prepare_rule_import.py')], { encoding: 'utf8' });
  assert.equal(python.status, 0, `${python.stdout}\n${python.stderr}`);
});
