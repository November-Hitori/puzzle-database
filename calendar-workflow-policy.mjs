import { getPuzzleSource, isConcretePenpaPuzzleUrl, isConcretePuzzlinkPuzzleUrl, parseTrustedPuzzleUrl } from './puzzle-url.mjs';

export const CALENDAR_AREAS = Object.freeze(['review','leftover','allocation','finished']);
export function penpaUrlMode(value) {
  if (!isConcretePenpaPuzzleUrl(value)) return null;
  const url = parseTrustedPuzzleUrl(value);
  const hashParams = new URLSearchParams(url.hash.slice(1));
  if (!url.searchParams.get('p')?.trim() && !hashParams.get('p')?.trim()) return null;
  const queryMode = url.searchParams.get('m');
  const hashMode = hashParams.get('m');
  if (queryMode && hashMode && queryMode !== hashMode) return null;
  return queryMode || hashMode;
}
export function normalizeCalendarLinks(input, previous = null) {
  const linkKeys = ['penpaEditUrl','penpaSolveUrl','puzzlinkUrl'];
  const structured = linkKeys.some((key) => Object.hasOwn(input,key)) || (previous && (input.url===undefined || input.url===previous.url) && linkKeys.some((key)=>previous[key]));
  if (!structured) {
    const url = input.url === undefined ? previous?.url || '' : input.url;
    if (typeof url !== 'string' || url.length > 4096 || (url && !parseTrustedPuzzleUrl(url))) return {error:'invalid puzzle URL'};
    const source = getPuzzleSource(url);
    return {value:{url,penpaEditUrl:source==='penpa+'&&penpaUrlMode(url)==='edit'?url:'',
      penpaSolveUrl:source==='penpa+'&&penpaUrlMode(url)==='solve'?url:'',puzzlinkUrl:isConcretePuzzlinkPuzzleUrl(url)?url:''}};
  }
  const value = {};
  for (const key of ['penpaEditUrl','penpaSolveUrl','puzzlinkUrl']) {
    const raw = Object.hasOwn(input,key) ? input[key] : previous?.[key] || (key==='puzzlinkUrl'&&isConcretePuzzlinkPuzzleUrl(previous?.url)?previous.url:'');
    if (typeof raw !== 'string' || raw.length > 4096) return {error:`invalid ${key}`};
    value[key] = raw.trim();
  }
  if (value.penpaEditUrl && penpaUrlMode(value.penpaEditUrl)!=='edit') return {error:'Penpa 编辑链接必须是 m=edit 的具体题目链接'};
  if (value.penpaSolveUrl && penpaUrlMode(value.penpaSolveUrl)!=='solve') return {error:'Penpa 解题链接必须是 m=solve 的具体题目链接'};
  if (value.puzzlinkUrl && !isConcretePuzzlinkPuzzleUrl(value.puzzlinkUrl)) return {error:'puzz.link 或 fork 链接必须是受支持的具体题目链接'};
  if ((input.inputMode || previous?.inputMode || 'external')==='external' && !value.penpaSolveUrl && !value.puzzlinkUrl) return {error:'请至少提供 Penpa 解题链接或 puzz.link 链接之一'};
  value.url = value.penpaSolveUrl || value.puzzlinkUrl;
  return {value};
}
export function annotateQualityErrors(errors, ignores = []) {
  return errors.map((error) => {
    const key = error.key || `${error.code}:${error.item || 'puzzle'}`;
    const ignore = ignores.find((entry) => entry.key===key && entry.revision===error.revision);
    return {...error,key,ignored:Boolean(error.ignored||ignore),...(ignore?{ignore}: {})};
  });
}
export function getCalendarArea(reviewStatus, errors = [], warnings = []) {
  if (reviewStatus==='leftover') return 'leftover';
  if (reviewStatus!=='approved') return 'review';
  return errors.some((error)=>!error.ignored) || warnings.length ? 'allocation' : 'finished';
}
