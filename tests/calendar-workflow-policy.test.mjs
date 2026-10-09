import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCalendarLinks, penpaUrlMode, getCalendarArea, annotateQualityErrors } from '../calendar-workflow-policy.mjs';

test('link roles require the correct concrete tool URL and at least one solving link',()=>{
  const solve='https://penpa-edit.com/?m=solve&p=sample';
  const edit='https://penpa-edit.com/?m=edit&p=sample';
  const puzz='https://puzz.link/p?slither/3/3/000';
  assert.equal(normalizeCalendarLinks({penpaSolveUrl:solve}).value.url,solve);
  assert.equal(normalizeCalendarLinks({puzzlinkUrl:puzz}).value.url,puzz);
  assert.ok(normalizeCalendarLinks({penpaEditUrl:edit}).error);
  assert.ok(normalizeCalendarLinks({penpaSolveUrl:edit}).error);
  assert.ok(normalizeCalendarLinks({penpaEditUrl:solve,puzzlinkUrl:puzz}).error);
  assert.ok(normalizeCalendarLinks({puzzlinkUrl:'https://puzz.link/'}).error);
  assert.ok(normalizeCalendarLinks({puzzlinkUrl:'https://penpa-edit.com/?m=solve&p=1'}).error);
  assert.ok(normalizeCalendarLinks({penpaSolveUrl:'javascript:alert(1)'}).error);
  assert.ok(normalizeCalendarLinks({penpaSolveUrl:'https://penpa-edit.com/?m=solve'}).error);
  assert.ok(normalizeCalendarLinks({penpaEditUrl:'https://penpa-edit.com/?m=edit&p=',puzzlinkUrl:puzz}).error);
  assert.equal(penpaUrlMode('https://swaroopg92.github.io/penpa-edit/#m=solve&p=sample'),'solve');
  assert.equal(penpaUrlMode('https://penpa-edit.com/?m=edit&p=sample#m=solve&p=sample'),null);
  assert.equal(normalizeCalendarLinks({url:puzz}).value.puzzlinkUrl,puzz);
  for (const fork of ['https://pzplus.tck.mn/p.html?slither/3/3/000','https://pzprxs.vercel.app/p?slither/3/3/000','https://pzv.jp/p.html?slither/3/3/000','http://pzv.jp/p.html?slither/3/3/000']) {
    assert.equal(normalizeCalendarLinks({puzzlinkUrl:fork}).value.puzzlinkUrl,fork);
    assert.equal(normalizeCalendarLinks({url:fork}).value.puzzlinkUrl,fork);
    assert.equal(normalizeCalendarLinks({penpaEditUrl:edit,penpaSolveUrl:solve},{url:fork,inputMode:'external',puzzlinkUrl:''}).value.puzzlinkUrl,fork);
  }
  assert.ok(normalizeCalendarLinks({puzzlinkUrl:'https://pzplus.tck.mn/'}).error);
  assert.ok(normalizeCalendarLinks({puzzlinkUrl:'https://pzprxs.vercel.app/p.html?slither/3/3/000'}).error);
  assert.equal(normalizeCalendarLinks({title:'renamed'},{url:solve,inputMode:'external',penpaEditUrl:edit,penpaSolveUrl:solve,puzzlinkUrl:''}).value.penpaEditUrl,edit);
});
test('ignored errors remain explicit, match only their version and never replace required audits',()=>{
  const error={code:'missingPenpaEdit',item:'links',revision:2,message:'Missing'};
  assert.equal(annotateQualityErrors([error],[{key:'missingPenpaEdit:links',revision:1}])[0].ignored,false);
  const ignored=annotateQualityErrors([error],[{key:'missingPenpaEdit:links',revision:2,reason:'exception'}]);
  assert.equal(ignored[0].ignored,true);
  assert.equal(ignored[0].ignore.reason,'exception');
  assert.equal(getCalendarArea('pending',[],[]),'review');
  assert.equal(getCalendarArea('leftover',[],[]),'leftover');
  assert.equal(getCalendarArea('approved',[error],[]),'allocation');
  assert.equal(getCalendarArea('approved',ignored,[{code:'penpaNotAudited'}]),'allocation');
  assert.equal(getCalendarArea('approved',ignored,[]),'finished');
});
