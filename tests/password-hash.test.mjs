import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, PASSWORD_HASH_PARAMETERS } from '../password-hash.mjs';

test('password hashes are salted, versioned, and verified without storing plaintext', async () => {
  const password = '谜题账户—correct horse battery staple';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$1\$131072\$8\$1\$/);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('different password', first), false);
  assert.equal(first.includes(password), false);
  assert.equal(PASSWORD_HASH_PARAMETERS.saltBytes, 16);
  assert.equal(PASSWORD_HASH_PARAMETERS.keyBytes, 64);
});

test('password hashing rejects oversized values and unknown hash formats', async () => {
  await assert.rejects(hashPassword(''), /password must contain/);
  await assert.rejects(hashPassword('x'.repeat(PASSWORD_HASH_PARAMETERS.maxPasswordBytes + 1)), /password must contain/);
  assert.equal(await verifyPassword('password', 'sha256$legacy-hash'), false);
});

test('password KDF work queue rejects overload without throwing synchronously', async () => {
  const results=await Promise.allSettled(Array.from({length:10},(_,index)=>hashPassword(`queue test password ${index}`)));
  assert.equal(results.filter((result)=>result.status==='fulfilled').length,9);
  const rejected=results.filter((result)=>result.status==='rejected');
  assert.equal(rejected.length,1);
  assert.equal(rejected[0].reason.code,'PASSWORD_KDF_BUSY');
});
