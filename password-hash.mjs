import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_PASSWORD_BYTES = 1024;
const MAX_ACTIVE_KDFS = 1;
const MAX_QUEUED_KDFS = 8;
const SCRYPT = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
const queue = [];
let activeKdfs = 0;

function validatePassword(password) {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') < 1 || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new TypeError(`password must contain 1 to ${MAX_PASSWORD_BYTES} UTF-8 bytes`);
  }
}

function runNext() {
  if (activeKdfs >= MAX_ACTIVE_KDFS || queue.length === 0) return;
  const task = queue.shift();
  activeKdfs += 1;
  Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => {
    activeKdfs -= 1;
    runNext();
  });
}

function scheduleKdf(run) {
  return new Promise((resolve, reject) => {
    if (activeKdfs >= MAX_ACTIVE_KDFS && queue.length >= MAX_QUEUED_KDFS) {
      reject(Object.assign(new Error('password service is busy'), { code: 'PASSWORD_KDF_BUSY' }));
      return;
    }
    queue.push({ run, resolve, reject });
    runNext();
  });
}

async function derive(password, salt) {
  return scheduleKdf(() => scrypt(password, salt, KEY_LENGTH, SCRYPT));
}

/** Hash a password using the versioned scrypt format `scrypt$1$N$r$p$salt$key`. */
export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(SALT_LENGTH);
  const derived = await derive(password, salt);
  return `scrypt$1$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Compare a password with a stored hash. Unknown formats fail closed. */
export async function verifyPassword(password, encoded) {
  validatePassword(password);
  if (typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== '1'
    || parts[2] !== String(SCRYPT.N) || parts[3] !== String(SCRYPT.r) || parts[4] !== String(SCRYPT.p)
    || !/^[a-f0-9]{32}$/.test(parts[5]) || !/^[a-f0-9]{128}$/.test(parts[6])) return false;
  const expected = Buffer.from(parts[6], 'hex');
  const actual = await derive(password, Buffer.from(parts[5], 'hex'));
  return timingSafeEqual(actual, expected);
}

export const PASSWORD_HASH_PARAMETERS = Object.freeze({ ...SCRYPT, saltBytes: SALT_LENGTH, keyBytes: KEY_LENGTH, maxPasswordBytes: MAX_PASSWORD_BYTES });
