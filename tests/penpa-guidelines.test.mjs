import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

test('guideline line breaks preserve bundled audits without changing custom revision semantics',async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'puzarchive-guidelines-'));
  const root=path.join(directory,'app');
  const docs=path.join(root,'docs');
  const overrideBefore=process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH;
  t.after(()=>{
    if (overrideBefore===undefined) delete process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH;
    else process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH=overrideBefore;
    fs.rmSync(directory,{recursive:true,force:true});
  });
  delete process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH;
  fs.mkdirSync(docs,{recursive:true});
  fs.copyFileSync(new URL('../penpa-guidelines.mjs',import.meta.url),path.join(root,'penpa-guidelines.mjs'));
  const bundledText=fs.readFileSync(new URL('../docs/penpa.md',import.meta.url),'utf8').trim();
  const bundledPath=path.join(docs,'penpa.md');
  fs.writeFileSync(bundledPath,bundledText);
  const {getPenpaGuidelines}=await import(pathToFileURL(path.join(root,'penpa-guidelines.mjs')).href);
  const hash=(text)=>createHash('sha256').update(text).digest('hex');
  const legacyRevision='0cf20a8109af013b5570786483d0571355adebac585c9b4a79144f6a6ccb1a5d';

  await t.test('bundled text has real section breaks and retains the previous one-line audit version',()=>{
    const guidelines=getPenpaGuidelines();
    assert.equal(guidelines.available,true);
    assert.equal(guidelines.text,bundledText);
    for (const heading of ['文件格式：','小技巧：','网格：','图形：','箭头：']) {
      assert.ok(guidelines.text.includes(`\n\n${heading}\n`),heading);
    }
    assert.equal(guidelines.revision,legacyRevision);
    assert.notEqual(hash(bundledText),legacyRevision);
  });

  await t.test('a substantive bundled change still changes the version',()=>{
    const changed=bundledText.replace('涂黑使用GR','涂黑使用BK');
    assert.notEqual(changed,bundledText);
    fs.writeFileSync(bundledPath,changed);
    assert.equal(getPenpaGuidelines().revision,hash(changed));
    assert.notEqual(getPenpaGuidelines().revision,legacyRevision);
    fs.writeFileSync(bundledPath,bundledText);
  });

  await t.test('an explicit multiline override retains its exact content hash',()=>{
    const customPath=path.join(directory,'custom-penpa.md');
    fs.writeFileSync(customPath,bundledText);
    process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH=customPath;
    assert.equal(getPenpaGuidelines().text,bundledText);
    assert.equal(getPenpaGuidelines().revision,hash(bundledText));
    delete process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH;
  });

  await t.test('a workspace specification keeps precedence and its exact multiline version',()=>{
    const workspaceDocs=path.join(directory,'docs');
    fs.mkdirSync(workspaceDocs);
    fs.writeFileSync(path.join(workspaceDocs,'penpa.md'),bundledText);
    const guidelines=getPenpaGuidelines();
    assert.equal(guidelines.text,bundledText);
    assert.equal(guidelines.revision,hash(bundledText));
  });
});
