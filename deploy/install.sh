#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo 'Run this installer as root.' >&2
  exit 1
fi
if [[ $# -ne 2 ]]; then
  echo 'Usage: install.sh STAGED_APP_DIR INITIAL_DATA_DIR' >&2
  exit 2
fi

app_source=$(realpath "$1")
data_source=$(realpath "$2")
for file in server.mjs db.mjs deploy/puzarchive.service deploy/puzarchive-backup.service deploy/puzarchive-backup.timer; do
  [[ -f "$app_source/$file" ]] || { echo "Missing staged app file: $file" >&2; exit 1; }
done
for file in puzarchive.sqlite trusted-users.json; do
  [[ -f "$data_source/$file" ]] || { echo "Missing initial data file: $file" >&2; exit 1; }
done
[[ ! -e /opt/puzarchive/app && ! -e /opt/puzarchive/runtime ]] || {
  echo 'An existing /opt/puzarchive deployment was found; refusing to overwrite it.' >&2
  exit 1
}
[[ ! -e /var/lib/puzarchive/puzarchive.sqlite && ! -e /var/lib/puzarchive/trusted-users.json ]] || {
  echo 'Existing PuzArchive data was found; refusing to overwrite it.' >&2
  exit 1
}
[[ $(uname -m) == x86_64 ]] || { echo 'This runtime pin supports x86_64 only.' >&2; exit 1; }

if ! id puzarchive >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/puzarchive --shell /usr/sbin/nologin puzarchive
fi
install -d -o root -g root -m 0755 /opt/puzarchive /opt/puzarchive/app /opt/puzarchive/app/data /opt/puzarchive/runtime /opt/puzarchive/runtime/bin
install -d -o puzarchive -g puzarchive -m 0700 /var/lib/puzarchive /var/backups/puzarchive
install -d -o root -g puzarchive -m 0750 /etc/puzarchive

runtime_dir=$(mktemp -d /var/tmp/puzarchive-node.XXXXXX)
archive="$runtime_dir/node-v22.23.3-linux-x64.tar.xz"
trap 'rm -rf -- "$runtime_dir"' EXIT
curl --fail --location --silent --show-error https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-x64.tar.xz -o "$archive"
printf '%s  %s\n' df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de "$archive" | sha256sum --check --status || {
  echo 'Official Node.js archive checksum did not match.' >&2
  exit 1
}
tar -xJf "$archive" --strip-components=1 -C "$runtime_dir"
install -o root -g root -m 0755 "$runtime_dir/bin/node" /opt/puzarchive/runtime/bin/node

cp -a "$app_source/." /opt/puzarchive/app/
chown -R root:root /opt/puzarchive/app
chmod -R go-w /opt/puzarchive/app
install -o puzarchive -g puzarchive -m 0600 "$data_source/puzarchive.sqlite" /var/lib/puzarchive/puzarchive.sqlite
install -o puzarchive -g puzarchive -m 0600 "$data_source/trusted-users.json" /var/lib/puzarchive/trusted-users.json
install -o root -g puzarchive -m 0640 /dev/null /etc/puzarchive/puzarchive.env
install -o root -g root -m 0644 "$app_source/deploy/puzarchive.service" /etc/systemd/system/puzarchive.service
install -o root -g root -m 0644 "$app_source/deploy/puzarchive-backup.service" /etc/systemd/system/puzarchive-backup.service
install -o root -g root -m 0644 "$app_source/deploy/puzarchive-backup.timer" /etc/systemd/system/puzarchive-backup.timer

systemd-analyze verify /etc/systemd/system/puzarchive.service /etc/systemd/system/puzarchive-backup.service /etc/systemd/system/puzarchive-backup.timer
systemctl daemon-reload
systemctl enable --now puzarchive.service puzarchive-backup.timer
echo 'PuzArchive installed. It listens on 127.0.0.1:4173.'
