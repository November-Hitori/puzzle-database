const USERNAME_MIN_CODE_POINTS = 2;
const USERNAME_MAX_CODE_POINTS = 32;
const PASSWORD_MIN_CODE_POINTS = 12;
const PASSWORD_MAX_CODE_POINTS = 128;
const PASSWORD_MAX_UTF8_BYTES = 512;

export function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const username = value.normalize('NFKC');
  const length = [...username].length;
  if (length < USERNAME_MIN_CODE_POINTS || length > USERNAME_MAX_CODE_POINTS || !/^[\p{L}\p{N}_-]+$/u.test(username)) return null;
  return { username, key: username.toLowerCase() };
}

export function validateAccountPassword(value) {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  return length >= PASSWORD_MIN_CODE_POINTS && length <= PASSWORD_MAX_CODE_POINTS
    && new TextEncoder().encode(value).length <= PASSWORD_MAX_UTF8_BYTES;
}

export const ACCOUNT_PASSWORD_POLICY = Object.freeze({
  minCodePoints: PASSWORD_MIN_CODE_POINTS,
  maxCodePoints: PASSWORD_MAX_CODE_POINTS,
  maxUtf8Bytes: PASSWORD_MAX_UTF8_BYTES
});

export const ACCOUNT_USERNAME_POLICY = Object.freeze({
  minCodePoints: USERNAME_MIN_CODE_POINTS,
  maxCodePoints: USERNAME_MAX_CODE_POINTS,
  allowedCharacters: 'Unicode letters and numbers, underscore, hyphen'
});
