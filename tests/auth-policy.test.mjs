import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsername, validateAccountPassword, ACCOUNT_PASSWORD_POLICY, ACCOUNT_USERNAME_POLICY } from '../auth-policy.mjs';

test('username policy normalizes NFKC and compares case-insensitively', () => {
  assert.deepEqual(normalizeUsername('Ａlice_1'), { username: 'Alice_1', key: 'alice_1' });
  assert.deepEqual(normalizeUsername('林晓'), { username: '林晓', key: '林晓' });
  assert.equal(normalizeUsername('a'), null);
  assert.equal(normalizeUsername('name.with.dot'), null);
  assert.equal(normalizeUsername('x'.repeat(ACCOUNT_USERNAME_POLICY.maxCodePoints + 1)), null);
});

test('password policy counts Unicode code points and applies the UTF-8 byte ceiling', () => {
  assert.equal(validateAccountPassword('a'.repeat(7)), false);
  assert.equal(validateAccountPassword('a'.repeat(8)), true);
  assert.equal(validateAccountPassword('😀'.repeat(7)), false);
  assert.equal(validateAccountPassword('😀'.repeat(8)), true);
  assert.equal(validateAccountPassword('密码 is long enough'), true);
  assert.equal(validateAccountPassword('短密码'), false);
  assert.equal(validateAccountPassword('😀'.repeat(ACCOUNT_PASSWORD_POLICY.maxCodePoints)), true);
  assert.equal(validateAccountPassword('😀'.repeat(ACCOUNT_PASSWORD_POLICY.maxCodePoints + 1)), false);
  assert.equal(validateAccountPassword('😀'.repeat(129)), false);
  assert.equal(validateAccountPassword(null), false);
});
