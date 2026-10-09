export const CALENDAR_REVIEW_TAGS = Object.freeze([
  '逻辑通顺',
  '需要简单结构',
  '需要复杂结构',
  '需要全局观察',
  '通灵',
  '美观'
]);

export const CALENDAR_REVIEW_VOTES = Object.freeze(['support','neutral','oppose','veto']);
export const CALENDAR_APPROVAL_NET_SUPPORT = 3;

export function normalizeCalendarReviewInput(input) {
  if (!input || !Number.isInteger(input.difficulty) || input.difficulty < 1 || input.difficulty > 6) return {error:'difficulty'};
  if (!Array.isArray(input.tags) || input.tags.length > CALENDAR_REVIEW_TAGS.length
    || input.tags.some((tag)=>!CALENDAR_REVIEW_TAGS.includes(tag))
    || new Set(input.tags).size !== input.tags.length) return {error:'tags'};
  if (!CALENDAR_REVIEW_VOTES.includes(input.vote)) return {error:'vote'};
  if (!Number.isSafeInteger(input.expectedReviewRound) || input.expectedReviewRound < 1) return {error:'round'};
  const selectedTags=new Set(input.tags);
  return {value:{difficulty:input.difficulty,tags:CALENDAR_REVIEW_TAGS.filter((tag)=>selectedTags.has(tag)),vote:input.vote,expectedReviewRound:input.expectedReviewRound}};
}

export function getCalendarReviewStatus({support=0,oppose=0,veto=0}) {
  if (veto > 0) return 'leftover';
  return support - oppose >= CALENDAR_APPROVAL_NET_SUPPORT ? 'approved' : 'pending';
}
