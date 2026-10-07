import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dbModule=new URL('../db.mjs',import.meta.url).href;
const runNode=(source,dbPath)=>spawnSync(process.execPath,['--input-type=module','-e',source],{
  encoding:'utf8',env:{...process.env,PUZARCHIVE_DB_PATH:dbPath}
});

test('deleted entity IDs and puzzle numbers stay retired across restart without reseeding',()=>{
  const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'puzarchive-id-sequences-'));
  const dbPath=path.join(tempDir,'sequences.sqlite');
  try {
    const first=runNode(`
      import {database,addRule,deleteRule,addCalendarPuzzle,deleteCalendarPuzzle} from ${JSON.stringify(dbModule)};
      const ruleInput=(title)=>({titleZh:title,titleEn:'',rulesZh:['有效规则'],rulesEn:[],category:'其它',isVariant:false,baseRuleId:null,exampleUrl:'',exampleAuthor:''});
      const discarded=addRule(ruleInput('将删除的规则'),null);
      const firstDelete=deleteRule(discarded.id,discarded.deleteToken,discarded.editVersion);
      const rule=addRule(ruleInput('保留规则'),null);
      const puzzleInput={title:'将删除的日历题',author:'Owner',source:'Fixture',inputMode:'blank',answer:'',ruleId:rule.id,suggestedDate:null};
      const oldPuzzle=addCalendarPuzzle(puzzleInput,{id:'fixture-owner'}).puzzle;
      const puzzleDelete=deleteCalendarPuzzle(oldPuzzle.number,'fixture-owner',oldPuzzle.deleteToken);
      const replacement=addCalendarPuzzle({...puzzleInput,title:'替代日历题'},{id:'fixture-owner'}).puzzle;
      const replacementId=database.prepare('SELECT id FROM puzzles WHERE number=?').get(replacement.number).id;
      database.exec('DELETE FROM puzzles');
      const beforeRestart={firstDelete:firstDelete.deleted,keptRuleId:rule.id,oldPuzzleNumber:oldPuzzle.number,replacementNumber:replacement.number,replacementId,deletedPuzzles:database.prepare('SELECT COUNT(*) AS count FROM puzzles').get().count,puzzleDelete:puzzleDelete.deleted};
      console.log(JSON.stringify(beforeRestart)); database.close();
    `,dbPath);
    assert.equal(first.status,0,`${first.stderr}\n${first.stdout}`);
    const firstState=JSON.parse(first.stdout.trim().split('\n').at(-1));
    assert.equal(firstState.firstDelete,true);
    assert.equal(firstState.puzzleDelete,true);
    assert.equal(firstState.deletedPuzzles,0);
    assert.ok(firstState.oldPuzzleNumber<firstState.replacementNumber);

    const second=runNode(`
      import {database,addRule,addCalendarPuzzle} from ${JSON.stringify(dbModule)};
      const countOnRestart=database.prepare('SELECT COUNT(*) AS count FROM puzzles').get().count;
      const input={titleZh:'重启后规则',titleEn:'',rulesZh:['说明'],rulesEn:[],category:'其它',isVariant:false,baseRuleId:null,exampleUrl:'',exampleAuthor:''};
      const rule=addRule(input,null);
      const puzzle=addCalendarPuzzle({title:'重启后日历题',author:'Owner',source:'Fixture',inputMode:'blank',ruleId:rule.id,suggestedDate:null},{id:'fixture-owner'}).puzzle;
      const current={countOnRestart,ruleId:rule.id,puzzleNumber:puzzle.number,puzzleId:database.prepare('SELECT id FROM puzzles WHERE number=?').get(puzzle.number).id};
      console.log(JSON.stringify(current)); database.close();
    `,dbPath);
    assert.equal(second.status,0,`${second.stderr}\n${second.stdout}`);
    const afterRestart=JSON.parse(second.stdout.trim().split('\n').at(-1));
    assert.equal(afterRestart.countOnRestart,0,'prototype puzzle seed must not resurrect deleted data');
    assert.ok(afterRestart.ruleId>firstState.keptRuleId);
    assert.ok(afterRestart.puzzleNumber>firstState.replacementNumber);
    assert.ok(afterRestart.puzzleId>firstState.replacementId);
  } finally { fs.rmSync(tempDir,{recursive:true,force:true}); }
});
