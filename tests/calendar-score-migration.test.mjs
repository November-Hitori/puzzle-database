import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrateCalendarScores} from '../calendar-score-migration.mjs';

test('numeric liking migration preserves review history, identities, and account records across restart',()=>{
  const database=new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE calendar_review_schema_migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE puzzles(id INTEGER PRIMARY KEY,number INTEGER,title TEXT,submitted_by TEXT,scope TEXT,
      calendar_status TEXT,review_round INTEGER,assigned_date TEXT,edit_version INTEGER);
    CREATE TABLE calendar_review_votes(puzzle_id INTEGER,review_round INTEGER,user_id TEXT,vote TEXT,updated_at TEXT,
      PRIMARY KEY(puzzle_id,review_round,user_id));
    CREATE TABLE calendar_review_vote_events(id INTEGER PRIMARY KEY,puzzle_id INTEGER,review_round INTEGER,user_id TEXT,vote TEXT,created_at TEXT);
    CREATE TABLE puzzle_ratings(id INTEGER PRIMARY KEY,puzzle_id INTEGER,user_id TEXT,logic INTEGER,intuition INTEGER,enjoyment INTEGER);
    CREATE TABLE puzzle_completions(puzzle_id INTEGER,user_id TEXT,completed_at TEXT,PRIMARY KEY(puzzle_id,user_id));
    CREATE TABLE calendar_evaluations(id INTEGER PRIMARY KEY,puzzle_id INTEGER,user_id TEXT,review_round INTEGER,difficulty INTEGER,tags_json TEXT,updated_at TEXT,
      UNIQUE(puzzle_id,user_id,review_round));
    CREATE TABLE trusted_users(id TEXT PRIMARY KEY,name TEXT,username TEXT,password_hash TEXT,is_active INTEGER);
    CREATE TABLE member_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER);
    INSERT INTO calendar_review_schema_migrations VALUES(1),(3);
    INSERT INTO puzzles VALUES
      (100,800,'Will approve','owner','calendar','pending',1,NULL,12),
      (101,801,'Veto remains','owner','calendar','leftover',1,NULL,13),
      (102,802,'Will become pending','owner','calendar','approved',1,'2028-02-29',14);
    INSERT INTO calendar_review_votes VALUES
      (100,1,'a','support','2026-01-01'),(100,1,'b','support','2026-01-02'),(100,1,'c','neutral','2026-01-03'),
      (101,1,'a','support','2026-01-04'),(101,1,'b','veto','2026-01-05'),
      (102,1,'a','support','2026-01-06'),(102,1,'b','oppose','2026-01-07'),(102,1,'c','neutral','2026-01-08'),
      (100,1,'history-only','oppose','2025-12-31');
    INSERT INTO calendar_review_vote_events VALUES
      (71,100,1,'a','support','2026-01-01'),(72,100,1,'a','oppose','2026-01-02'),
      (90,100,1,'history-only','oppose','2025-12-31'),(91,101,1,'b','veto','2026-01-05');
    INSERT INTO puzzle_ratings VALUES(44,100,'a',5,4,3);
    INSERT INTO puzzle_completions VALUES(100,'a','2026-01-09');
    INSERT INTO calendar_evaluations VALUES(55,100,'a',1,5,'["美观"]','2026-01-10');
    INSERT INTO trusted_users VALUES('owner','Owner','Owner','private-hash',1);
    INSERT INTO member_sessions VALUES('private-token-hash','owner',1900000000000);
  `);
  const approvals=[];
  const rows=sql=>database.prepare(sql).all().map(row=>({...row}));
  assert.equal(migrateCalendarScores(database,puzzle=>approvals.push(puzzle.number)),true);
  assert.deepEqual(approvals,[800]);
  const columns=table=>database.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name);
  assert.ok(columns('calendar_review_votes').includes('score'));
  assert.ok(columns('calendar_review_vote_events').includes('score'));
  assert.deepEqual(rows('SELECT id,score FROM calendar_review_vote_events ORDER BY id'),[
    {id:71,score:2},{id:72,score:-2},{id:90,score:-2},{id:91,score:null}
  ]);
  assert.deepEqual(rows('SELECT user_id,score FROM calendar_review_votes WHERE puzzle_id=100 ORDER BY user_id'),[
    {user_id:'a',score:2},{user_id:'b',score:2},{user_id:'c',score:0},{user_id:'history-only',score:-2}
  ]);
  assert.equal(database.prepare('SELECT calendar_status FROM puzzles WHERE id=100').get().calendar_status,'approved');
  assert.equal(database.prepare('SELECT calendar_status FROM puzzles WHERE id=101').get().calendar_status,'leftover');
  assert.equal(database.prepare('SELECT calendar_status,assigned_date FROM puzzles WHERE id=102').get().calendar_status,'pending');
  assert.equal(database.prepare('SELECT assigned_date FROM puzzles WHERE id=102').get().assigned_date,null);
  assert.deepEqual({...database.prepare('SELECT id,logic,intuition,enjoyment FROM puzzle_ratings').get()},{id:44,logic:5,intuition:4,enjoyment:3});
  assert.deepEqual({...database.prepare('SELECT puzzle_id,user_id,completed_at FROM puzzle_completions').get()},{puzzle_id:100,user_id:'a',completed_at:'2026-01-09'});
  assert.deepEqual({...database.prepare('SELECT puzzle_id,user_id,review_round,difficulty,tags_json FROM calendar_evaluations').get()},{puzzle_id:100,user_id:'a',review_round:1,difficulty:5,tags_json:'["美观"]'});
  assert.deepEqual({...database.prepare('SELECT id,username,password_hash,is_active FROM trusted_users').get()},{id:'owner',username:'Owner',password_hash:'private-hash',is_active:1});
  assert.deepEqual({...database.prepare('SELECT token_hash,user_id,expires_at FROM member_sessions').get()},{token_hash:'private-token-hash',user_id:'owner',expires_at:1900000000000});
  assert.equal(database.prepare('SELECT version FROM calendar_review_schema_migrations WHERE version=4').get().version,4);
  const votesBefore=rows('SELECT puzzle_id,review_round,user_id,vote,score,updated_at FROM calendar_review_votes ORDER BY puzzle_id,user_id');
  const eventsBefore=rows('SELECT id,puzzle_id,review_round,user_id,vote,score,created_at FROM calendar_review_vote_events ORDER BY id');
  assert.equal(migrateCalendarScores(database,()=>assert.fail('restart repeated approval notification')),false);
  assert.deepEqual(rows('SELECT puzzle_id,review_round,user_id,vote,score,updated_at FROM calendar_review_votes ORDER BY puzzle_id,user_id'),votesBefore);
  assert.deepEqual(rows('SELECT id,puzzle_id,review_round,user_id,vote,score,created_at FROM calendar_review_vote_events ORDER BY id'),eventsBefore);
  database.close();
});
