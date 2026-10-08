import test from 'node:test';
import assert from 'node:assert/strict';
import { CALENDAR_REVIEW_TAGS, getCalendarReviewStatus, normalizeCalendarReviewInput } from '../calendar-review-policy.mjs';

test('calendar reviews require a bounded difficulty, unique supported tags, vote, and round',()=>{
  const valid=normalizeCalendarReviewInput({difficulty:6,tags:['美观','逻辑通顺'],vote:'support',expectedReviewRound:2,userId:'forged'});
  assert.deepEqual(valid.value,{difficulty:6,tags:['逻辑通顺','美观'],vote:'support',expectedReviewRound:2});
  assert.equal(normalizeCalendarReviewInput({difficulty:0,tags:[],vote:'support',expectedReviewRound:1}).error,'difficulty');
  assert.equal(normalizeCalendarReviewInput({difficulty:6.5,tags:[],vote:'support',expectedReviewRound:1}).error,'difficulty');
  assert.equal(normalizeCalendarReviewInput({difficulty:6,tags:['美观','美观'],vote:'support',expectedReviewRound:1}).error,'tags');
  assert.equal(normalizeCalendarReviewInput({difficulty:6,tags:['not-a-tag'],vote:'support',expectedReviewRound:1}).error,'tags');
  assert.equal(normalizeCalendarReviewInput({difficulty:6,tags:[],vote:'unknown',expectedReviewRound:1}).error,'vote');
  assert.equal(normalizeCalendarReviewInput({difficulty:6,tags:[],vote:'support',expectedReviewRound:0}).error,'round');
  assert.equal(normalizeCalendarReviewInput({difficulty:6,tags:[],vote:'neutral',expectedReviewRound:1}).error,'vote');
  assert.equal(CALENDAR_REVIEW_TAGS.length,6);
});

test('calendar state uses net support and any veto always sends the item to leftovers',()=>{
  assert.equal(getCalendarReviewStatus({support:4,oppose:1}), 'approved');
  assert.equal(getCalendarReviewStatus({support:3,oppose:1}), 'pending');
  assert.equal(getCalendarReviewStatus({support:20,oppose:0,veto:1}), 'leftover');
});
