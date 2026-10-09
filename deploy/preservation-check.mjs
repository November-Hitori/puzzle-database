import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [directory, livePath, usersPath] = process.argv.slice(2);
const quote = (s) => `"${s.replaceAll('"', '""')}"`;
const serialize = (v) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? String(x) : x instanceof Uint8Array ? Array.from(x) : x);
const legacyScore = (vote) => ({support: 2, oppose: -2, neutral: 0})[vote] ?? null;
const migrationStatus = ({scoredCount, totalScore, veto}) => veto > 0 ? 'leftover' : scoredCount >= 3 && totalScore > 0 ? 'approved' : 'pending';
let before, after;

try {
  before = new DatabaseSync(path.join(directory, 'puzarchive.sqlite'), {readOnly: true});
  after = new DatabaseSync(livePath, {readOnly: true});
  before.exec('PRAGMA query_only=ON; BEGIN');
  after.exec('PRAGMA query_only=ON; BEGIN');

  let equal = true, tables = 0, count = 0;
  const mismatches = [];
  const requireMatch = (condition, label) => { if (!condition) { equal = false; mismatches.push(label); } };
  const baselineTables = new Set(before.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({name}) => name));
  const liveTables = new Set(after.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({name}) => name));
  for (const name of baselineTables) requireMatch(liveTables.has(name), name);

  const hasMigration4 = Boolean(before.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='calendar_review_schema_migrations'").get()
    && before.prepare('SELECT 1 FROM calendar_review_schema_migrations WHERE version=4').get());
  const puzzleRows = baselineTables.has('puzzles') ? before.prepare('SELECT * FROM puzzles').all() : [];
  const voteRows = baselineTables.has('calendar_review_votes') ? before.prepare('SELECT * FROM calendar_review_votes').all() : [];
  const currentScores = new Map();
  for (const row of voteRows) {
    const score = Object.hasOwn(row, 'score') ? row.score : legacyScore(row.vote);
    const key = `${row.puzzle_id}:${row.review_round}`;
    const total = currentScores.get(key) ?? {scoredCount: 0, totalScore: 0, veto: 0};
    if (row.vote === 'veto') total.veto++;
    else if (score !== null && score !== undefined) { total.scoredCount++; total.totalScore += Number(score); }
    currentScores.set(key, total);
  }

  for (const name of baselineTables) {
    tables++;
    const fields = before.prepare(`PRAGMA table_info(${quote(name)})`).all().map((r) => r.name);
    const select = `SELECT ${fields.map(quote).join(',')} FROM ${quote(name)} ORDER BY ${fields.map(quote).join(',')}`;
    const original = before.prepare(select).all();
    count += original.length;
    let current;
    try { current = after.prepare(select).all(); } catch { equal = false; continue; }

    if (name === 'entity_id_sequences') {
      requireMatch(original.length === current.length && original.every((r) => current.some((n) => n.name === r.name && n.next_id >= r.next_id)), name);
      continue;
    }
    if (name === 'user_notifications') continue;
    if (name.endsWith('_schema_migrations')) {
      const migration4Applicable = name === 'calendar_review_schema_migrations' && !hasMigration4;
      const expectedVersions = new Set(original.map((r) => r.version));
      const allowedCurrent = current.filter((r) => expectedVersions.has(r.version) || (migration4Applicable && r.version === 4));
      requireMatch(original.every((r) => allowedCurrent.some((n) => serialize(n) === serialize(r))), name);
      if (name === 'calendar_review_schema_migrations') requireMatch(current.length === allowedCurrent.length, name);
      if (migration4Applicable) requireMatch(allowedCurrent.filter((r) => r.version === 4).length === 1, name);
      continue;
    }
    if (name === 'calendar_review_votes' || name === 'calendar_review_vote_events') {
      const migrated = !hasMigration4;
      if (migrated && !after.prepare(`PRAGMA table_info(${quote(name)})`).all().some((c) => c.name === 'score')) requireMatch(false, name);
      const expected = original.map((row) => migrated && !Object.hasOwn(row, 'score') ? {...row, score: legacyScore(row.vote)} : row);
      const liveFields = after.prepare(`PRAGMA table_info(${quote(name)})`).all().map((r) => r.name);
      if (migrated && !fields.includes('score')) {
        const scored = after.prepare(`SELECT score FROM ${quote(name)} ORDER BY ${fields.map(quote).join(',')}`).all();
        requireMatch(expected.length === scored.length && expected.every((r, i) => r.score === scored[i].score), name);
      }
      const comparable = expected.map((r) => Object.fromEntries(Object.entries(r).filter(([key]) => fields.includes(key))));
      const actual = current.map((r) => Object.fromEntries(Object.entries(r).filter(([key]) => fields.includes(key))));
      requireMatch(serialize(comparable) === serialize(actual) && current.length === original.length, name);
      if (liveFields.includes('score') && fields.includes('score')) requireMatch(serialize(expected) === serialize(current), name);
      continue;
    }
    if (name === 'puzzles' && !hasMigration4 && ['calendar_status', 'assigned_date', 'edit_version'].every((field) => fields.includes(field))) {
      const expected = original.map((row) => {
        if (row.scope !== 'calendar') return row;
        const status = row.calendar_status === 'leftover' ? 'leftover' : migrationStatus(currentScores.get(`${row.id}:${row.review_round}`) ?? {});
        if (status === row.calendar_status) return row;
        return {...row, calendar_status: status, assigned_date: status === 'approved' ? row.assigned_date : null, edit_version: row.edit_version + 1};
      });
      const currentById = new Map(current.map((row) => [row.id, row]));
      requireMatch(current.length === expected.length && expected.every((row) => serialize(currentById.get(row.id)) === serialize(row)), name);
      continue;
    }
    requireMatch(serialize(original) === serialize(current), name);
  }

  // The migration may add one approval notification (and a missing-link companion) only
  // when a legacy calendar puzzle changes into approved. All earlier notifications stay exact.
  if (baselineTables.has('user_notifications')) {
    const oldNotifications = before.prepare('SELECT * FROM user_notifications ORDER BY id').all();
    const liveNotifications = after.prepare('SELECT * FROM user_notifications ORDER BY id').all();
    const oldIds = new Set(oldNotifications.map((row) => row.id));
    const maxOldId = oldNotifications.reduce((max, row) => Math.max(max, row.id), 0);
    const added = liveNotifications.filter((row) => !oldIds.has(row.id));
    const expectedNotifications = [];
    if (!hasMigration4) {
      for (const puzzle of puzzleRows) {
        if (puzzle.scope !== 'calendar' || puzzle.calendar_status === 'leftover') continue;
        const status = migrationStatus(currentScores.get(`${puzzle.id}:${puzzle.review_round}`) ?? {});
        if (puzzle.calendar_status === 'approved' || status !== 'approved' || !puzzle.submitted_by) continue;
        const key = `liking-migration:${puzzle.number}:${puzzle.review_round}`;
        expectedNotifications.push({recipient_user_id:puzzle.submitted_by,kind:'calendar-approved',
          title:`日历谜题“${puzzle.title}”已通过审核`,
          body:'至少三人已提交喜爱程度评分，平均分严格大于 0，已进入待分配区。',
          entity_type:'calendar-puzzle',entity_id:puzzle.number,dedupe_key:`calendar-approved:${key}`});
        const links = after.prepare('SELECT penpa_edit_url,penpa_solve_url FROM puzzles WHERE id=?').get(puzzle.id);
        if (links && (!links.penpa_edit_url || !links.penpa_solve_url)) {
          const missing = [!links.penpa_edit_url?'Penpa 编辑链接':null,!links.penpa_solve_url?'Penpa 解题链接':null].filter(Boolean);
          expectedNotifications.push({recipient_user_id:puzzle.submitted_by,kind:'calendar-links-required',
            title:`请补齐谜题“${puzzle.title}”的 Penpa 链接`,
            body:`投稿已满足喜爱程度评分要求，进入待分配区。请补齐${missing.join('和')}，并对照 Penpa 制图规范准备审核；puzz.link 链接可选。`,
            entity_type:'calendar-puzzle',entity_id:puzzle.number,dedupe_key:`calendar-links-required:${key}`});
        }
      }
    }
    requireMatch(oldNotifications.every((row) => liveNotifications.some((current) => serialize(current) === serialize(row))), 'user_notifications');
    const notificationFields = ['recipient_user_id','kind','title','body','entity_type','entity_id','dedupe_key','read_at'];
    requireMatch(added.length === expectedNotifications.length && expectedNotifications.every((expected) =>
      added.some((row) => Number.isSafeInteger(row.id) && row.id > maxOldId
        && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.created_at)
        && after.prepare("SELECT strftime('%Y-%m-%d %H:%M:%S', ?) AS value").get(row.created_at).value === row.created_at
        && serialize(Object.fromEntries(notificationFields.map((field) => [field,row[field]]))) === serialize({...expected,read_at:null}))), 'new_notifications');
  }

  const integrity = [before, after].every((db) => db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok');
  const foreignKeys = [before, after].reduce((n, db) => n + db.prepare('PRAGMA foreign_key_check').all().length, 0);
  const configEqual = fs.readFileSync(path.join(directory, 'trusted-users.json')).equals(fs.readFileSync(usersPath));
  console.log(`baseline_tables=${tables}\nbaseline_rows=${count}\nall_old_fields_equal=${equal}\npreservation_mismatch_count=${new Set(mismatches).size}\nbackup_and_live_integrity_ok=${integrity}\nforeign_key_violations=${foreignKeys}\nmember_configuration_unchanged=${configEqual}`);
  if (!equal || !integrity || foreignKeys || !configEqual) process.exitCode = 1;
} catch { console.log('preservation_check_failed=true'); process.exitCode = 2; }
finally { try { before?.close(); } catch {} try { after?.close(); } catch {} }
