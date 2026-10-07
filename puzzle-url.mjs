const PUZZLE_URL_RULES = [
  { host: 'puzz.link', allowSubdomains: true },
  { host: 'pzv.jp', allowHttp: true },
  { host: 'pzprxs.vercel.app' },
  { host: 'pzplus.tck.mn' },
  { host: 'penpa-edit.com', allowSubdomains: true },
  { host: 'opt-pan.github.io', pathPrefix: '/pedit-v2' },
  { host: 'opt-pan.github.io', pathPrefix: '/penpa-edit' },
  { host: 'swaroopg92.github.io', pathPrefix: '/penpa-edit' }
];

export const TRUSTED_PUZZLE_FRAME_SOURCES = [
  'https://puzz.link',
  'https://*.puzz.link',
  'http://pzv.jp',
  'https://pzv.jp',
  'https://pzprxs.vercel.app',
  'https://pzplus.tck.mn',
  'https://opt-pan.github.io',
  'https://swaroopg92.github.io',
  'https://penpa-edit.com',
  'https://*.penpa-edit.com'
];

function normalizedHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.$/, '');
}

export function parseTrustedPuzzleUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return null;
    const host = normalizedHost(url.hostname);
    const pathname = url.pathname.toLowerCase();
    const trusted = PUZZLE_URL_RULES.some((rule) => {
      const protocolAllowed = url.protocol === 'https:' || (rule.allowHttp && url.protocol === 'http:');
      if (!protocolAllowed) return false;
      const hostMatches = host === rule.host || (rule.allowSubdomains && host.endsWith(`.${rule.host}`));
      if (!hostMatches) return false;
      if (rule.pathPrefix) return pathname === rule.pathPrefix || pathname.startsWith(`${rule.pathPrefix}/`);
      return true;
    });
    return trusted ? url : null;
  } catch {
    return null;
  }
}

export function isTrustedPuzzleUrl(value) {
  return parseTrustedPuzzleUrl(value) !== null;
}

export function hasConcretePuzzlePayload(value) {
  const url = parseTrustedPuzzleUrl(value);
  if (!url) return false;
  const source = getPuzzleSource(url.href);
  const pathname = url.pathname.toLowerCase();
  const hasQuery = url.search.length > 1;
  if (source === 'puzz.link') return pathname === '/p' && hasQuery;
  if (source === 'pzv3') return pathname === '/p.html' && hasQuery;
  if (source === 'pzprxs') return pathname === '/p' && hasQuery;
  if (source === 'pzplus') return pathname === '/p.html' && hasQuery;
  return hasQuery || (pathname !== '/' && pathname !== '/penpa-edit/' && pathname !== '/pedit-v2/');
}

export function isConcretePenpaPuzzleUrl(value) {
  const url=parseTrustedPuzzleUrl(value);
  return Boolean(url && !url.port && getPuzzleSource(url.href)==='penpa+' && hasConcretePuzzlePayload(url.href));
}

export function getPuzzleSource(value) {
  const url = parseTrustedPuzzleUrl(value);
  if (!url) return '';
  const host = normalizedHost(url.hostname);
  if (host === 'puzz.link' || host.endsWith('.puzz.link')) return 'puzz.link';
  if (host === 'pzv.jp') return 'pzv3';
  if (host === 'pzprxs.vercel.app') return 'pzprxs';
  if (host === 'pzplus.tck.mn') return 'pzplus';
  return 'penpa+';
}
