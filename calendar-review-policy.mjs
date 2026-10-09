export const CALENDAR_REVIEW_TAGS = Object.freeze([
  '逻辑通顺',
  '需要简单结构',
  '需要复杂结构',
  '需要全局观察',
  '通灵',
  '美观'
]);

export const CALENDAR_LIKING_SCORES = Object.freeze([-2,-1,0,1,2]);
export const CALENDAR_REVIEW_VOTES = Object.freeze([...CALENDAR_LIKING_SCORES,'veto']);
export const CALENDAR_MINIMUM_SCORE_COUNT = 3;

export function normalizeCalendarVote(vote) {
  // Older clients may still submit the former choices; they now mean ±2.
  if (vote==='support') return 2;
  if (vote==='oppose') return -2;
  return CALENDAR_REVIEW_VOTES.includes(vote)?vote:null;
}
export function calendarVoteValue(row) {
  if (row.vote==='veto') return 'veto';
  if (CALENDAR_LIKING_SCORES.includes(row.score)) return row.score;
  return ({support:2,oppose:-2,neutral:0})[row.vote]??null;
}
export function storedCalendarVote(value) {
  return value==='veto'?'veto':value>0?'support':value<0?'oppose':'neutral';
}
export function summarizeCalendarVotes(values=[]) {
  const scores=Object.fromEntries(CALENDAR_LIKING_SCORES.map(score=>[score,0]));
  let scoredCount=0,totalScore=0,veto=0,support=0,oppose=0;
  for (const value of values) {
    if (value==='veto') { veto++;continue; }
    if (!CALENDAR_LIKING_SCORES.includes(value)) continue;
    scores[value]++;scoredCount++;totalScore+=value;
    if (value>0) support++;else if(value<0) oppose++;
  }
  return {scores,scoredCount,totalScore,averageScore:scoredCount?totalScore/scoredCount:null,veto,
    support,oppose,netSupport:support-oppose};
}

export function normalizeCalendarReviewInput(input) {
  if (!input || !Number.isInteger(input.difficulty) || input.difficulty < 1 || input.difficulty > 6) return {error:'difficulty'};
  if (!Array.isArray(input.tags) || input.tags.length > CALENDAR_REVIEW_TAGS.length
    || input.tags.some((tag)=>!CALENDAR_REVIEW_TAGS.includes(tag))
    || new Set(input.tags).size !== input.tags.length) return {error:'tags'};
  const vote=normalizeCalendarVote(input.vote);
  if (vote===null) return {error:'vote'};
  if (!Number.isSafeInteger(input.expectedReviewRound) || input.expectedReviewRound < 1) return {error:'round'};
  const selectedTags=new Set(input.tags);
  return {value:{difficulty:input.difficulty,tags:CALENDAR_REVIEW_TAGS.filter((tag)=>selectedTags.has(tag)),vote,expectedReviewRound:input.expectedReviewRound}};
}

export function getCalendarReviewStatus({scoredCount=0,totalScore=0,veto=0}) {
  if (veto > 0) return 'leftover';
  return scoredCount>=CALENDAR_MINIMUM_SCORE_COUNT&&totalScore>0?'approved':'pending';
}
