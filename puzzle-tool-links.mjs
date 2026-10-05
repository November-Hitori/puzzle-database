import { getPuzzleSource, parseTrustedPuzzleUrl } from './puzzle-url.mjs';

const TOOLS = new Map([
  ['penpaV2', { prefix: 'https://opt-pan.github.io/pedit-v2/', name: 'Penpa-edit v2' }],
  ['penpa', { prefix: 'https://opt-pan.github.io/penpa-edit/', name: 'Penpa-edit V3' }],
  ['penpa+', { prefix: 'https://swaroopg92.github.io/penpa-edit/', name: 'Penpa+' }],
  ['puzz.link', { prefix: 'https://puzz.link/p?', name: 'puzz.link' }],
  ['pzv3', { prefix: 'http://pzv.jp/p.html?', name: 'pzv3' }],
  ['pzprxs', { prefix: 'https://pzprxs.vercel.app/p?', name: 'pzprxs' }],
  ['pzplus', { prefix: 'https://pzplus.tck.mn/p.html?', name: 'pzplus' }]
]);

const ALTERNATIVE_ORDER = {
  penpaV2: ['penpaV2', 'penpa', 'penpa+'],
  penpa: ['penpa', 'penpa+'],
  'penpa+': ['penpa+', 'penpa'],
  'puzz.link': ['puzz.link', 'pzprxs', 'pzplus'],
  pzv3: ['pzv3', 'pzprxs', 'pzplus'],
  pzprxs: ['pzprxs', 'pzplus'],
  pzplus: ['pzplus', 'pzprxs']
};

function detectSource(href) {
  for (const [id, tool] of TOOLS) {
    if (href.startsWith(tool.prefix)) {
      return { id, tool, suffix: href.slice(tool.prefix.length) };
    }
  }
  return null;
}

export function buildPuzzleToolLinks(value) {
  const url = parseTrustedPuzzleUrl(value);
  if (!url) return [];
  const href = url.href;
  const source = detectSource(href);

  if (!source) {
    const sourceId = getPuzzleSource(href) || 'original';
    const name = sourceId === 'original' ? '原链接' : sourceId;
    return [{ id: sourceId, name, url: href, isOriginal: true }];
  }

  const ids = ALTERNATIVE_ORDER[source.id] || [source.id];
  const links = [];
  for (const id of ids) {
    const tool = TOOLS.get(id);
    if (!tool) continue;
    links.push({ id, name: tool.name, url: `${tool.prefix}${source.suffix}`, isOriginal: href === `${tool.prefix}${source.suffix}` });
  }

  if (!links.some((link) => link.url === href)) {
    links.unshift({ id: 'original', name: '原链接', url: href, isOriginal: true });
  }
  return links;
}
