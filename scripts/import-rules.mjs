#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isConcretePenpaPuzzleUrl } from '../puzzle-url.mjs';
import { RULE_EXAMPLE_URL_MAX_LENGTH } from '../rule-policy.mjs';

const CATEGORIES = new Set(['涂黑', '填数', '分区', '置物', '路径', '其它']);
const usage = 'Usage: node scripts/import-rules.mjs --payload PRIVATE.json [--apply --db EXISTING.sqlite]';

function argsFrom(argv) {
  const result = { apply: false, payload: '', db: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--apply') result.apply = true;
    else if (key === '--payload' || key === '--db') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
      result[key.slice(2)] = value;
    } else if (key === '--help') {
      console.log(usage);
      process.exit(0);
    } else throw new Error(`unknown option: ${key}\n${usage}`);
  }
  if (!result.payload) throw new Error(`--payload is required\n${usage}`);
  if (result.apply && !result.db) throw new Error(`--db is required with --apply\n${usage}`);
  if (!result.apply && result.db) throw new Error('--db is accepted only with --apply; dry-run never opens a database');
  return result;
}

function normalizedTitle(value) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function validatePayload(payload) {
  if (!payload || payload.format !== 'puzarchive-rule-import-v1' || !Array.isArray(payload.records) || payload.records.length > 382) {
    throw new Error('payload format or record count is invalid');
  }
  const sourceRows = new Set();
  const chineseNames = new Set();
  for (const [index, record] of payload.records.entries()) {
    if (!record || !Number.isInteger(record.sourceRow) || record.sourceRow < 3 || record.sourceRow > 384 || sourceRows.has(record.sourceRow)) throw new Error(`record ${index + 1} has an invalid source row`);
    sourceRows.add(record.sourceRow);
    if (typeof record.titleZh !== 'string' || record.titleZh.length > 160 || typeof record.titleEn !== 'string' || record.titleEn.length > 160 || (!record.titleZh.trim() && !record.titleEn.trim())) throw new Error(`record at row ${record.sourceRow} has invalid rule names`);
    const name = record.titleZh.trim() ? `zh:${normalizedTitle(record.titleZh)}` : `en:${normalizedTitle(record.titleEn)}`;
    if (chineseNames.has(name)) throw new Error(`payload still has duplicate Chinese title at row ${record.sourceRow}`);
    chineseNames.add(name);
    if (!Array.isArray(record.rulesZh) || record.rulesZh.length > 30 || record.rulesZh.some((clause) => typeof clause !== 'string' || clause.length > 1000)) throw new Error(`record at row ${record.sourceRow} has invalid Chinese rules`);
    if (!Array.isArray(record.rulesEn) || record.rulesEn.length !== 0) throw new Error(`record at row ${record.sourceRow} must not invent English rules`);
    if (!CATEGORIES.has(record.category)) throw new Error(`record at row ${record.sourceRow} has an invalid category`);
    if (record.isVariant !== false || record.baseRuleId !== null) throw new Error(`record at row ${record.sourceRow} has unsupported variant data`);
    if (typeof record.exampleUrl !== 'string' || record.exampleUrl.length > RULE_EXAMPLE_URL_MAX_LENGTH || (record.exampleUrl && !isConcretePenpaPuzzleUrl(record.exampleUrl))) throw new Error(`record at row ${record.sourceRow} has an invalid Penpa URL`);
    if (typeof record.exampleAuthor !== 'string' || record.exampleAuthor.length > 200) throw new Error(`record at row ${record.sourceRow} has an invalid example author`);
  }
  return { records: payload.records, sourceRows: sourceRows.size };
}

function applyRecords(dbPath, records) {
  const absolutePath = path.resolve(dbPath);
  const info = fs.lstatSync(absolutePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('--db must name an existing regular file, not a symlink');
  const header = Buffer.alloc(16);
  const headerFd = fs.openSync(absolutePath, 'r');
  try {
    if (fs.readSync(headerFd, header, 0, header.length, 0) !== header.length || header.toString('binary') !== 'SQLite format 3\u0000') throw new Error('--db is not an existing SQLite database; this command never creates one');
  } finally {
    fs.closeSync(headerFd);
  }
  const db = new DatabaseSync(absolutePath, { enableForeignKeyConstraints: true, timeout: 5000 });
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const columns = new Set(db.prepare('PRAGMA table_info(rules)').all().map((column) => column.name));
    if (!['title_zh', 'title_en', 'rules_zh', 'rules_en', 'category', 'is_variant', 'base_rule_id', 'example_url', 'example_author', 'name_revision', 'description_revision', 'example_revision', 'edit_version', 'delete_token'].every((column) => columns.has(column))) {
      throw new Error('target database does not have the expected rule schema; it was not migrated by this command');
    }
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    if (!tables.has('rule_item_revisions')) throw new Error('target database is missing rule audit tables');
    if (!tables.has('entity_id_sequences') || !db.prepare("SELECT 1 FROM entity_id_sequences WHERE name='rules'").get()) throw new Error('target database is missing the persistent rule ID sequence; start the application once before importing');

    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT title_zh,title_en FROM rules').all();
      const titles = new Set(existing.map((row) => row.title_zh.trim() ? `zh:${normalizedTitle(row.title_zh)}` : `en:${normalizedTitle(row.title_en)}`));
      const add = db.prepare(`INSERT INTO rules
        (id,title_zh,title_en,rules_zh,rules_en,category,is_variant,base_rule_id,example_url,example_author,delete_token)
        VALUES (?,?,?,?,?, ?,0,NULL,?,?,?)`);
      const snapshot = db.prepare(`INSERT INTO rule_item_revisions
        (rule_id,item,revision,content_json,changed_by_user_id) VALUES (?,?,1,?,NULL)`);
      const readSequence = db.prepare("SELECT next_id FROM entity_id_sequences WHERE name='rules'");
      const advanceSequence = db.prepare("UPDATE entity_id_sequences SET next_id=? WHERE name='rules' AND next_id=?");
      let inserted = 0, existingSkipped = 0;
      const existingSkippedRows = [];
      for (const rule of records) {
        const normalized = rule.titleZh.trim() ? `zh:${normalizedTitle(rule.titleZh)}` : `en:${normalizedTitle(rule.titleEn)}`;
        if (titles.has(normalized)) {
          existingSkipped += 1;
          existingSkippedRows.push(rule.sourceRow);
          continue;
        }
        const nextId = readSequence.get().next_id;
        if (advanceSequence.run(nextId + 1, nextId).changes !== 1) throw new Error('could not allocate a rule ID');
        const id = nextId;
        add.run(id, rule.titleZh.trim(), rule.titleEn.trim(), JSON.stringify(rule.rulesZh), JSON.stringify(rule.rulesEn), rule.category, rule.exampleUrl, rule.exampleAuthor.trim(), randomUUID());
        snapshot.run(id, 'name', JSON.stringify({ titleZh: rule.titleZh.trim(), titleEn: rule.titleEn.trim() }));
        snapshot.run(id, 'description', JSON.stringify({ rulesZh: rule.rulesZh, rulesEn: rule.rulesEn, isVariant: false, baseRuleId: null }));
        snapshot.run(id, 'example', JSON.stringify({ exampleUrl: rule.exampleUrl, exampleAuthor: rule.exampleAuthor.trim() }));
        titles.add(normalized);
        inserted += 1;
      }
      db.exec('COMMIT');
      return { inserted, existingSkipped, existingSkippedRows, total: records.length };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

try {
  const options = argsFrom(process.argv.slice(2));
  const payloadStat = fs.lstatSync(options.payload);
  if (!payloadStat.isFile() || payloadStat.isSymbolicLink() || payloadStat.mode & 0o077 || payloadStat.size > 16 * 1024 * 1024) throw new Error('payload must be a private regular file (mode 0600) smaller than 16 MiB');
  const parsed = validatePayload(JSON.parse(fs.readFileSync(options.payload, 'utf8')));
  const result = options.apply ? applyRecords(options.db, parsed.records) : { inserted: 0, existingSkipped: null, total: parsed.records.length, databaseOpened: false };
  console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', sourceRows: parsed.sourceRows, ...result }));
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
