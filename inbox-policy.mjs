export const INBOX_TAGS = Object.freeze([
  Object.freeze({id:'star',label:'星标'}),
  Object.freeze({id:'flag',label:'旗帜'}),
  Object.freeze({id:'bookmark',label:'书签'}),
  Object.freeze({id:'heart',label:'喜爱'})
]);
export const INBOX_TAG_IDS = Object.freeze(INBOX_TAGS.map((tag)=>tag.id));
export const INBOX_READ_FILTERS = Object.freeze(['all','read','unread']);
export const INBOX_TAG_FILTERS = Object.freeze(['all','tagged','untagged']);

export function normalizeInboxTagInput(input) {
  if (!input || typeof input!=='object' || Array.isArray(input)
    || Object.keys(input).some((key)=>key!=='tags') || !Array.isArray(input.tags)
    || input.tags.some((tag)=>!INBOX_TAG_IDS.includes(tag))) return {error:'invalid inbox tags'};
  const selected=new Set(input.tags);
  // Store a set in the same order used by the icon picker; repeated IDs are harmless.
  return {value:{tags:INBOX_TAG_IDS.filter((tag)=>selected.has(tag))}};
}
