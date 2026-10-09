import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const SESSION_COOKIE = 'puzarchive_session';
let databaseModulePromise;

function getDatabase() {
  databaseModulePromise ||= import('./database.js');
  return databaseModulePromise;
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function getSessionUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const database = await getDatabase();
  return database.findSession(tokenHash(token));
}

export async function requireSessionUser() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  return user;
}
