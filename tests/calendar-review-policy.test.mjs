import test from 'node:test';
import assert from 'node:assert/strict';
import {CALENDAR_REVIEW_TAGS,getCalendarReviewStatus,normalizeCalendarReviewInput,summarizeCalendarVotes} from '../calendar-review-policy.mjs';

test('calendar reviews require a bounded difficulty, unique supported tags, vote, and round',()=>{
  const valid=normalizeCalendarReviewInput({difficulty:6,tags:['美观','逻辑通顺'],vote:'support',expectedReviewRound:2,userId:'forged'});
  assert.deepEqual(valid.value,{difficulty:6,tags:['逻辑通顺','美观'],vote:2,expectedReviewRound:2});
  assert.equal(normalizeCalendarReviewInput({difficulty:0,tags:[],vote:'support',expectedReviewRound:1}).error,'difficulty');
  assert.equal(normalizeCalendarReviewInput({difficulty:6.5,tags:[],vote:'support',expectedReviewRound:1}).error,'difficulty');
  assert.equal(normalizeCalendarReviewInput({difficulty:6,tags:['美观','美观'],vote:'support',expectedReviewRound:1}).error,'tags');
  assert.equal(normalizeCalendarReviewInput({difficulty:6,tags:['not-a-tag'],vote:'support',expectedReviewRound:1}).error,'tags');
  assert.equal(normalizeCalendarReviewInput({difficulty:6,tags:[],vote:'unknown',expectedReviewRound:1}).error,'vote');
  assert.equal(normalizeCalendarReviewInput({difficulty:6,tags:[],vote:'support',expectedReviewRound:0}).error,'round');
  assert.equal(normalizeCalendarReviewInput({difficulty:6,tags:[],vote:'neutral',expectedReviewRound:1}).error,'vote');
  assert.equal(CALENDAR_REVIEW_TAGS.length,6);
});

test('liking approval needs three distinct scoring rows and an exactly positive average; veto overrides',()=>{
  for (const [values,status] of [[[2,2],'pending'],[[2,0,-2],'pending'],[[0,0,0],'pending'],[[2,-1,0],'approved'],[[2,-2,-1],'pending'],[[1,0,0],'approved'],[[2,2,2,'veto'],'leftover']]) {
    assert.equal(getCalendarReviewStatus(summarizeCalendarVotes(values)),status);
  }
  assert.equal(getCalendarReviewStatus({scoredCount:1000,totalScore:1}),'approved');
  for (const vote of [-2,-1,0,1,2,'veto']) assert.equal(normalizeCalendarReviewInput({difficulty:3,tags:[],vote,expectedReviewRound:1}).value.vote,vote);
  for (const vote of [-3,3,1.5,false,'0']) assert.equal(normalizeCalendarReviewInput({difficulty:3,tags:[],vote,expectedReviewRound:1}).error,'vote');
});
