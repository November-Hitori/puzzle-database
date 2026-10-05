import test from 'node:test';
import assert from 'node:assert/strict';
import { getPuzzleSource, hasConcretePuzzlePayload, parseTrustedPuzzleUrl } from '../puzzle-url.mjs';

test('accepts supported puzzle tool URLs', () => {
  assert.equal(parseTrustedPuzzleUrl('https://puzz.link/p?slither/')?.hostname, 'puzz.link');
  assert.equal(parseTrustedPuzzleUrl('https://pzprxs.vercel.app/p?slither/')?.hostname, 'pzprxs.vercel.app');
  assert.equal(parseTrustedPuzzleUrl('https://pzplus.tck.mn/p.html?slither/')?.hostname, 'pzplus.tck.mn');
  assert.equal(parseTrustedPuzzleUrl('http://pzv.jp/p.html?slither/')?.hostname, 'pzv.jp');
  assert.equal(parseTrustedPuzzleUrl('https://swaroopg92.github.io/penpa-edit/')?.hostname, 'swaroopg92.github.io');
  assert.equal(parseTrustedPuzzleUrl('https://opt-pan.github.io/pedit-v2/')?.hostname, 'opt-pan.github.io');
});

test('rejects insecure, lookalike, credential and wrong-path URLs', () => {
  assert.equal(parseTrustedPuzzleUrl('http://puzz.link/'), null);
  assert.equal(parseTrustedPuzzleUrl('https://evilpuzz.link/'), null);
  assert.equal(parseTrustedPuzzleUrl('https://puzz.link.evil.example/'), null);
  assert.equal(parseTrustedPuzzleUrl('https://user:pass@puzz.link/'), null);
  assert.equal(parseTrustedPuzzleUrl('https://evilpenpa.example/'), null);
  assert.equal(parseTrustedPuzzleUrl('https://swaroopg92.github.io/not-penpa/'), null);
});

test('classifies the trusted source', () => {
  assert.equal(getPuzzleSource('https://puzz.link/p?slither/'), 'puzz.link');
  assert.equal(getPuzzleSource('https://pzprxs.vercel.app/p?slither/'), 'pzprxs');
  assert.equal(getPuzzleSource('https://swaroopg92.github.io/penpa-edit/'), 'penpa+');
});

test('detects concrete puzzle payloads for iframe rendering', () => {
  assert.equal(hasConcretePuzzlePayload('https://puzz.link/'), false);
  assert.equal(hasConcretePuzzlePayload('https://puzz.link/p?mannequin/6/6/abc'), true);
  assert.equal(hasConcretePuzzlePayload('https://pzprxs.vercel.app/p?slither/6/6/'), true);
  assert.equal(hasConcretePuzzlePayload('https://swaroopg92.github.io/penpa-edit/'), false);
  assert.equal(hasConcretePuzzlePayload('https://swaroopg92.github.io/penpa-edit/?m=edit&p=abc'), true);
});
