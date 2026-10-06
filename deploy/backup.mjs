import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

const sourcePath = path.resolve(process.env.PUZARCHIVE_DB_PATH || 'data/puzarchive.sqlite');
const usersPath = path.resolve(process.env.PUZARCHIVE_USERS_PATH || 'data/trusted-users.json');
const backupRoot = path.resolve(process.env.PUZARCHIVE_BACKUP_DIR || 'backups');
const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z');
const outputDir = path.join(backupRoot, `puzarchive-${timestamp}`);

if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new Error(`Database not found: ${sourcePath}`);
if (!fs.existsSync(usersPath) || !fs.statSync(usersPath).isFile()) throw new Error(`Trusted member configuration not found: ${usersPath}`);
fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(outputDir, { mode: 0o700 });
try {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, path.join(outputDir, 'puzarchive.sqlite'));
  } finally {
    source.close();
  }
  fs.copyFileSync(usersPath, path.join(outputDir, 'trusted-users.json'), fs.constants.COPYFILE_EXCL);
  fs.chmodSync(path.join(outputDir, 'puzarchive.sqlite'), 0o600);
  fs.chmodSync(path.join(outputDir, 'trusted-users.json'), 0o600);
  fs.writeFileSync(path.join(outputDir, 'created-at.txt'), `${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`Created private backup: ${outputDir}`);
} catch (error) {
  fs.rmSync(outputDir, { recursive: true, force: true });
  throw error;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The top-level work above intentionally makes this file a direct backup command.
}
