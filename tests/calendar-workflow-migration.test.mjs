import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';

test('workflow migration retains legacy URLs, records and IDs without inventing dates or audits',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'puzarchive-workflow-migration-'));
  const dbPath=path.join(directory,'old.sqlite');
  const old=new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE puzzles(id INTEGER PRIMARY KEY,number INTEGER NOT NULL UNIQUE,title TEXT NOT NULL,type TEXT NOT NULL,author TEXT NOT NULL,source TEXT NOT NULL,url TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',rules TEXT NOT NULL DEFAULT '',input_mode TEXT NOT NULL DEFAULT 'external',answer TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,scope TEXT NOT NULL DEFAULT 'public',rule_id INTEGER,suggested_date TEXT,calendar_year INTEGER NOT NULL DEFAULT 2028,calendar_status TEXT NOT NULL DEFAULT 'pending',review_round INTEGER NOT NULL DEFAULT 1,submitted_by TEXT,delete_token TEXT NOT NULL DEFAULT '');
    CREATE TABLE puzzle_ratings(id INTEGER PRIMARY KEY,puzzle_id INTEGER,user_id TEXT,logic INTEGER,intuition INTEGER,enjoyment INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(puzzle_id,user_id));
    CREATE TABLE puzzle_completions(puzzle_id INTEGER,user_id TEXT,completed_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(puzzle_id,user_id));
    CREATE TABLE calendar_evaluations(puzzle_id INTEGER,user_id TEXT,review_round INTEGER,difficulty INTEGER,tags_json TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(puzzle_id,user_id,review_round));
    CREATE TABLE calendar_review_schema_migrations(version INTEGER PRIMARY KEY);
    INSERT INTO calendar_review_schema_migrations VALUES(1),(2);
    INSERT INTO puzzles(id,number,title,type,author,source,url,scope,suggested_date,calendar_status,submitted_by,delete_token) VALUES
      (100,800,'Edit only','logic','Old','penpa+','https://penpa-edit.com/?m=edit&p=original','calendar','2028-02-29','approved','old-user','old-edit-token'),
      (101,801,'Solve only','logic','Old','penpa+','https://swaroopg92.github.io/penpa-edit/#m=solve&p=original','calendar',NULL,'pending','old-user','old-solve-token'),
      (102,802,'Puzzlink only','logic','Old','puzz.link','https://puzz.link/p?slither/3/3/000','calendar',NULL,'leftover','old-user','old-puzz-token');
    INSERT INTO puzzle_ratings VALUES(9,100,'old-user',5,4,3,'2026-01-01');
    INSERT INTO puzzle_completions VALUES(100,'old-user','2026-01-02');
    INSERT INTO calendar_evaluations VALUES(100,'old-user',1,5,'["美观"]','2026-01-03');`);
  old.close();
  const moduleUrl=new URL('../db.mjs',import.meta.url).href;
  const source=`import {database,getCalendarPuzzle} from ${JSON.stringify(moduleUrl)};
    const result={puzzles:[800,801,802].map(number=>getCalendarPuzzle(number,'old-user')),
      ratings:database.prepare('SELECT * FROM puzzle_ratings').all(),completions:database.prepare('SELECT * FROM puzzle_completions').all(),
      evaluations:database.prepare('SELECT * FROM calendar_evaluations').all(),audits:database.prepare('SELECT COUNT(*) AS count FROM calendar_penpa_votes').get().count,
      notifications:database.prepare('SELECT COUNT(*) AS count FROM user_notifications').get().count};
    console.log(JSON.stringify(result));database.close();`;
  const run=()=>{
    const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',env:{...process.env,PUZARCHIVE_DB_PATH:dbPath}});
    assert.equal(child.error,undefined,child.error?.message);
    assert.equal(child.status,0,child.stderr);
    return JSON.parse(child.stdout.trim());
  };
  try {
    const result=run();
    const [edit,solve,puzz]=result.puzzles;
    assert.equal(edit.penpaEditUrl,edit.url);assert.equal(edit.penpaSolveUrl,'');assert.equal(edit.puzzlinkUrl,'');
    assert.equal(solve.penpaSolveUrl,solve.url);assert.equal(puzz.puzzlinkUrl,puzz.url);
    assert.equal(edit.deleteToken,'old-edit-token');assert.equal(edit.completed,true);
    assert.equal(edit.evaluation.difficulty,5);assert.deepEqual(edit.evaluation.tags,['美观']);
    assert.equal(edit.suggestedDate,'2028-02-29');assert.equal(edit.assignedDate,null);
    assert.equal(edit.calendarArea,'allocation');assert.equal(puzz.calendarArea,'leftover');
    assert.equal(result.ratings[0].id,9);assert.equal(result.ratings[0].puzzle_id,100);assert.equal(result.ratings[0].logic,5);
    assert.equal(result.completions[0].completed_at,'2026-01-02');assert.equal(result.evaluations[0].updated_at,'2026-01-03');
    assert.equal(result.audits,0);assert.equal(result.notifications,0);
    assert.deepEqual(run(),result);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
