#!/usr/bin/env bash
set -euo pipefail
archive="$1"
runtime="$2"
python3 "$(dirname -- "$0")/release_archive.py" verify "$archive"
preflight_dir=$(mktemp -d /tmp/puzarchive-release-preflight.XXXXXX)
cleanup() {
  if [ "${PUZARCHIVE_PREFLIGHT_USE_SUDO:-false}" = true ]; then
    sudo -n rm -rf -- "$preflight_dir"
  else
    rm -rf -- "$preflight_dir"
  fi
}
trap cleanup EXIT
mkdir -m 0755 "$preflight_dir/app"
mkdir -m 0700 "$preflight_dir/state"
tar -xf "$archive" -C "$preflight_dir/app"
if [ "${PUZARCHIVE_PREFLIGHT_USE_SUDO:-false}" = true ]; then
  namespace=(sudo -n unshare --mount --fork)
  export PUZARCHIVE_PREFLIGHT_UID="$(id -u)" PUZARCHIVE_PREFLIGHT_GID="$(id -g)"
else
  namespace=(unshare --user --map-root-user --mount --fork)
fi
"${namespace[@]}" bash -s -- "$preflight_dir" "$runtime" "${PUZARCHIVE_PREFLIGHT_UID:-}" "${PUZARCHIVE_PREFLIGHT_GID:-}" <<'NAMESPACE'
set -euo pipefail
preflight_dir="$1"
runtime="$2"
if [ "$3" ]; then
  export PUZARCHIVE_PREFLIGHT_UID="$3" PUZARCHIVE_PREFLIGHT_GID="$4"
fi
mount --make-rprivate /
chown -R 0:0 "$preflight_dir/app"
test "$(stat -c '%u:%g:%a' "$preflight_dir/app/data")" = '0:0:755'
test -z "$(ls -A "$preflight_dir/app/data")"
mount --bind "$preflight_dir/app" "$preflight_dir/app"
mount -o remount,bind,ro "$preflight_dir/app"
if [ "${PUZARCHIVE_PREFLIGHT_UID:-}" ]; then
  chown "$PUZARCHIVE_PREFLIGHT_UID:$PUZARCHIVE_PREFLIGHT_GID" "$preflight_dir/state"
  unprivileged=(setpriv --reuid "$PUZARCHIVE_PREFLIGHT_UID" --regid "$PUZARCHIVE_PREFLIGHT_GID" --clear-groups)
else
  unprivileged=(unshare --user --map-user=1000 --map-group=1000 --fork)
fi
"${unprivileged[@]}" bash -s -- "$preflight_dir" "$runtime" <<'UNPRIVILEGED'
set -euo pipefail
preflight_dir="$1"
runtime="$2"
test "$(id -u)" != 0
test "$(awk '/^CapEff:/ {print $2}' /proc/self/status)" = 0000000000000000
export PUZARCHIVE_DB_PATH="$preflight_dir/state/fixture.sqlite"
export PUZARCHIVE_USERS_PATH="$preflight_dir/state/trusted-users.json"
export PUZARCHIVE_TRUST_LOOPBACK_PROXY=true
export PREFLIGHT_APP="$preflight_dir/app"
export HOST=127.0.0.1 PORT=0
"$runtime" --input-type=module <<'JAVASCRIPT'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const app=process.env.PREFLIGHT_APP;
assert.notEqual(process.getuid(),0);
assert.throws(()=>fs.writeFileSync(`${app}/data/not-allowed.txt`,'fixture'));
assert.throws(()=>fs.appendFileSync(`${app}/server.mjs`,'fixture'));
const {createServer}=await import(pathToFileURL(`${app}/server.mjs`));
const {database}=await import(pathToFileURL(`${app}/db.mjs`));
const server=createServer();
try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const base=`http://127.0.0.1:${server.address().port}`;
  for(const [route,status] of [['/',200],['/api/rules',401],['/db.mjs',404],['/docs/penpa.md',404],['/data/trusted-users.json',404],['/calendar-workflow-policy.mjs',200]]) {
    assert.equal((await fetch(base+route)).status,status,route);
  }
  for (const weight of ['regular','medium','bold']) {
    const fontPath=`assets/fonts/alibaba-puhuiti-${weight}.woff2`;
    const font=await fetch(`${base}/${fontPath}`);
    assert.equal(font.status,200,fontPath);
    assert.equal(font.headers.get('content-type'),'font/woff2');
    const bytes=Buffer.from(await font.arrayBuffer());
    assert.equal(bytes.subarray(0,4).toString(),'wOF2');
    assert.deepEqual(bytes,fs.readFileSync(`${app}/${fontPath}`));
  }
  assert.equal((await fetch(base+'/assets/fonts/other.woff2')).status,404);
  const member=JSON.parse(fs.readFileSync(process.env.PUZARCHIVE_USERS_PATH,'utf8'))[0];
  const response=await fetch(base+'/api/register',{method:'POST',headers:{'content-type':'application/json',origin:base.replace('http:','https:'),'x-forwarded-proto':'https','x-real-ip':'192.0.2.5'},body:JSON.stringify({username:'fixture-preflight',password:'only-temporary-fixture-password',inviteCode:member.accessCode})});
  assert.equal(response.status,201);
  const cookie=response.headers.get('set-cookie');
  assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(cookie,/Secure/);
  const rules=await fetch(base+'/api/rules',{headers:{cookie:cookie.split(';')[0]}});
  assert.equal(rules.status,200);
  const guidelines=await fetch(base+'/api/penpa-guidelines',{headers:{cookie:cookie.split(';')[0]}});
  assert.equal(guidelines.status,200);
  const specification=await guidelines.json();
  assert.equal(specification.available,true);assert.ok(specification.text.length>100);
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length,0);
  assert.equal(fs.statSync(process.env.PUZARCHIVE_USERS_PATH).mode&0o777,0o600);
  console.log('preflight_nonroot=true\npreflight_capabilities=none\npreflight_code_read_only=true\npreflight_empty_data_owner_mode=0:0:755\npreflight_home_and_auth_boundaries=true\npreflight_proxy_secure_cookie=true\npreflight_packaged_penpa_guidelines=true\npreflight_packaged_local_fonts=true\npreflight_sqlite_integrity_ok=true\npreflight_foreign_key_violations=0');
} finally {await new Promise(resolve=>server.close(resolve));database.close();}
JAVASCRIPT
UNPRIVILEGED
NAMESPACE
