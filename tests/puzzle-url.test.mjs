import test from 'node:test';
import assert from 'node:assert/strict';
import { getPuzzleSource, hasConcretePuzzlePayload, isConcretePenpaPuzzleUrl, parseTrustedPuzzleUrl } from '../puzzle-url.mjs';

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

test('accepts only concrete supported Penpa examples without credentials or non-default ports',()=>{
  assert.equal(isConcretePenpaPuzzleUrl('https://penpa-edit.com/?m=edit&p=example'),true);
  assert.equal(isConcretePenpaPuzzleUrl('https://opt-pan.github.io/penpa-edit/?m=edit&p=example'),true);
  assert.equal(isConcretePenpaPuzzleUrl('https://swaroopg92.github.io/penpa-edit/#m=edit&p=encodedPuzzleData'),true);
  assert.equal(isConcretePenpaPuzzleUrl('https://swaroopg92.github.io/penpa-edit/#m=solve&p=encodedPuzzleData'),true);
  assert.equal(isConcretePenpaPuzzleUrl('https://swaroopg92.github.io/penpa-edit/#m=edit&p=%20'),false);
  assert.equal(isConcretePenpaPuzzleUrl('https://swaroopg92.github.io/penpa-edit/#section'),false);
  assert.equal(isConcretePenpaPuzzleUrl('https://penpa-edit.com.evil.example/penpa-edit/#m=edit&p=encodedPuzzleData'),false);
  assert.equal(isConcretePenpaPuzzleUrl('https://user:pass@swaroopg92.github.io/penpa-edit/#m=edit&p=data'),false);
  assert.equal(isConcretePenpaPuzzleUrl('https://swaroopg92.github.io:8443/penpa-edit/#m=edit&p=data'),false);
  assert.equal(isConcretePenpaPuzzleUrl(''),false);
  assert.equal(isConcretePenpaPuzzleUrl('javascript:alert(1)'),false);
  assert.equal(isConcretePenpaPuzzleUrl('https://penpa-edit.com/'),false);
  assert.equal(isConcretePenpaPuzzleUrl('https://penpa-edit.com.evil.example/?m=edit&p=1'),false);
  assert.equal(isConcretePenpaPuzzleUrl('https://user:pass@penpa-edit.com/?m=edit&p=1'),false);
  assert.equal(isConcretePenpaPuzzleUrl('https://penpa-edit.com:8443/?m=edit&p=1'),false);
  assert.equal(isConcretePenpaPuzzleUrl('https://puzz.link/p?slither/6/6/abc'),false);
});
