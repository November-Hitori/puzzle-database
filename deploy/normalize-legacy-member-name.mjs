import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {normalizeLegacyMemberName} from '../legacy-member-name.mjs';
const dbPath=process.env.PUZARCHIVE_DB_PATH;
const configPath=process.env.PUZARCHIVE_USERS_PATH;
let database;
try {
  if (!dbPath||!configPath||!fs.existsSync(dbPath)) throw new Error('existing database and legacy member configuration required');
  const members=JSON.parse(fs.readFileSync(configPath,'utf8'));
  if (!Array.isArray(members)||members.length!==1) throw new Error('ambiguous legacy identity');
  database=new DatabaseSync(dbPath);
  const result=normalizeLegacyMemberName(database,members[0].id);
  if (result.error) {console.log('legacy_identity_normalization_refused=true');process.exitCode=1;}
  else console.log(`same_identity_verified=${result.sameIdentity}\nlegacy_display_names_updated=${result.updated}\naccount_ids_and_histories_retained=true`);
} catch {console.log('legacy_identity_normalization_failed=true');process.exitCode=1;}
finally {try{database?.close();}catch{}}
