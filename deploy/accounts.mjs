import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { normalizeUsername } from '../auth-policy.mjs';

if (!process.env.PUZARCHIVE_DB_PATH || !fs.existsSync(process.env.PUZARCHIVE_DB_PATH)) {
  console.error('Set PUZARCHIVE_DB_PATH to an existing application database before managing accounts.');
  process.exit(1);
}
const { authBootstrapComplete, disableRegistrationGate, revokeAccount, setRegistrationGate } = await import('../db.mjs');

const [command,...args]=process.argv.slice(2);
const hash=(value)=>createHash('sha256').update(value).digest('hex');

function usage() {
  console.error('Usage: accounts.mjs rotate-registration-code | disable-registration | revoke-account USERNAME');
  process.exitCode=2;
}

if (command==='rotate-registration-code' && args.length===0) {
  if (!authBootstrapComplete()) {
    console.error('Start puzarchive.service once to finish the legacy account migration before managing registration.');
    process.exitCode=1;
  } else {
  const code=randomBytes(32).toString('base64url');
  setRegistrationGate(hash(code));
  console.log(`Shared registration code (show once): ${code}`);
  console.log('The previous code is no longer accepted; existing accounts and sessions are unchanged.');
  }
} else if (command==='disable-registration' && args.length===0) {
  if (!authBootstrapComplete()) {
    console.error('Start puzarchive.service once to finish the legacy account migration before managing registration.');
    process.exitCode=1;
  } else console.log(disableRegistrationGate()?'New registrations disabled.':'Registration gate was not found.');
} else if (command==='revoke-account' && args.length===1) {
  const username=normalizeUsername(args[0]);
  if (!username) usage();
  else console.log(revokeAccount(username.key)?'Account disabled; puzzle history was preserved.':'Account was not found.');
} else usage();
