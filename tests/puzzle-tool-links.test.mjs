import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPuzzleToolLinks } from '../puzzle-tool-links.mjs';

test('builds puzz.link alternatives and preserves the suffix', () => {
  const links = buildPuzzleToolLinks('https://puzz.link/p?slither/6/6/abc');
  assert.deepEqual(links.map((link) => [link.id, link.url]), [
    ['puzz.link', 'https://puzz.link/p?slither/6/6/abc'],
    ['pzprxs', 'https://pzprxs.vercel.app/p?slither/6/6/abc'],
    ['pzplus', 'https://pzplus.tck.mn/p.html?slither/6/6/abc']
  ]);
});

test('builds Penpa alternatives and preserves the suffix', () => {
  const links = buildPuzzleToolLinks('https://swaroopg92.github.io/penpa-edit/?m=edit&p=abc');
  assert.deepEqual(links.map((link) => [link.id, link.url]), [
    ['penpa+', 'https://swaroopg92.github.io/penpa-edit/?m=edit&p=abc'],
    ['penpa', 'https://opt-pan.github.io/penpa-edit/?m=edit&p=abc']
  ]);
});

test('rejects unsupported sources', () => {
  assert.deepEqual(buildPuzzleToolLinks('https://evil.example/puzzle'), []);
});
