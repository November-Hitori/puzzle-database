#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
upload_dir="$1"
commit="$2"
expected_sha="$3"
release="${commit:0:12}"
helpers=/usr/local/lib/puzarchive-deploy
app=/opt/puzarchive/app
runtime=/opt/puzarchive/runtime/bin/node
private_root=/var/backups/puzarchive
code_backups=/var/backups/puzarchive-code
test "$(id -u)" = 0
test -d "$app" && test ! -L "$app"
test -x "$runtime"
test "$(sha256sum "$upload_dir/release.tar" | cut -d ' ' -f 1)" = "$expected_sha"
if [ -f "$app/.release.json" ] && python3 - "$app/.release.json" "$commit" <<'PYTHON'
import json,sys
sys.exit(0 if json.load(open(sys.argv[1]))['commit']==sys.argv[2] else 1)
PYTHON
then
  systemctl is-active --quiet puzarchive
  echo "release_already_active=$commit"
  exit 0
fi
systemctl is-active --quiet puzarchive
deploy_id="$release-$(date -u +%Y%m%dT%H%M%SZ)"
stage="/opt/puzarchive/.stage-$deploy_id"
metadata="/opt/puzarchive/release-metadata/$deploy_id"
rollback="$code_backups/$deploy_id"
test ! -e "$stage" && test ! -e "$rollback"
install -d -o root -g root -m 0700 "$stage" "$stage/app" "$code_backups" "$rollback"
chmod 0755 "$stage/app"
install -d -o root -g root -m 0755 "$metadata"
install -o root -g root -m 0600 "$upload_dir/release.tar" "$stage/release.tar"
test "$(sha256sum "$stage/release.tar" | cut -d ' ' -f 1)" = "$expected_sha"
python3 "$helpers/release_archive.py" extract "$stage/release.tar" "$stage/app" "$commit"
test "$(stat -c '%u:%g:%a' "$stage/app/data")" = '0:0:755'
test -z "$(ls -A "$stage/app/data")"
tar -cf "$rollback/app-before.tar" -C /opt/puzarchive app
chmod 0600 "$rollback/app-before.tar"
tar -tf "$rollback/app-before.tar" >/dev/null
env_before=$(sha256sum /etc/puzarchive/puzarchive.env | cut -d ' ' -f 1)
members_before=$(sha256sum /var/lib/puzarchive/trusted-users.json | cut -d ' ' -f 1)
backup_state() {
  local destination="$1"
  install -d -o puzarchive -g puzarchive -m 0700 "$destination"
  sudo -u puzarchive env PUZARCHIVE_DB_PATH=/var/lib/puzarchive/puzarchive.sqlite PUZARCHIVE_USERS_PATH=/var/lib/puzarchive/trusted-users.json PUZARCHIVE_BACKUP_DIR="$destination" "$runtime" "$app/deploy/backup.mjs"
}
backup_state "$private_root/release-$deploy_id-online"
stopped=0
swapped=0
exchange() {
  python3 - "$app" "$stage/app" <<'PYTHON'
import ctypes,os,sys
libc=ctypes.CDLL(None,use_errno=True)
rc=libc.renameat2(-100,os.fsencode(sys.argv[1]),-100,os.fsencode(sys.argv[2]),2)
if rc: raise OSError(ctypes.get_errno(),'atomic app directory exchange failed')
PYTHON
}
rollback_on_error() {
  local status=$?
  trap - ERR
  if [ "$stopped" = 1 ]; then
    systemctl stop puzarchive || true
    if [ "$swapped" = 1 ]; then exchange; fi
    systemctl start puzarchive
    systemctl is-active --quiet puzarchive
    echo 'deployment_failed_code_rollback_complete=true'
    echo 'database_and_member_files_not_restored_or_overwritten=true'
  fi
  exit "$status"
}
trap rollback_on_error ERR
trap 'false' HUP INT TERM
stopped=1
systemctl stop puzarchive
# Close the final-request window while keeping the original online backup.
# The stopped-service snapshot is also made with SQLite's consistent backup API.
final_backup_root="$private_root/release-$deploy_id-preactivation"
backup_state "$final_backup_root"
mapfile -t baseline_dirs < <(find "$final_backup_root" -mindepth 1 -maxdepth 1 -type d)
test "${#baseline_dirs[@]}" = 1
baseline="${baseline_dirs[0]}"
sudo -u puzarchive "$runtime" "$app/deploy/restore-check.mjs" "$baseline"
exchange
swapped=1
systemctl start puzarchive
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:4173/ -o /dev/null 2>/dev/null; then break; fi
  sleep 0.2
done
systemctl is-active --quiet puzarchive
test "$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:4173/)" = 200
test "$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:4173/api/rules)" = 401
test "$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:4173/db.mjs)" = 404
sudo -u puzarchive "$runtime" "$helpers/preservation-check.mjs" "$baseline" /var/lib/puzarchive/puzarchive.sqlite /var/lib/puzarchive/trusted-users.json "$app"
test "$(sha256sum /etc/puzarchive/puzarchive.env | cut -d ' ' -f 1)" = "$env_before"
test "$(sha256sum /var/lib/puzarchive/trusted-users.json | cut -d ' ' -f 1)" = "$members_before"
cp "$app/.release.json" "$metadata/manifest.json"
mv "$stage/app" "$rollback/app-before"
swapped=0
stopped=0
trap - ERR
echo "deployed_commit=$commit"
echo 'service_active=true'
echo 'loopback_home_http=200'
echo 'unauthenticated_private_api_http=401'
echo 'private_source_http=404'
echo 'environment_and_member_configuration_unchanged=true'
echo "private_backup_directory=$baseline"
echo "code_rollback_directory=$rollback"
