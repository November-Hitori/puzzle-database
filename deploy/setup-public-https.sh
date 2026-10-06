#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo 'Run this setup as root.' >&2
  exit 1
fi
if [[ $# -ne 0 ]]; then
  echo 'Usage: setup-public-https.sh' >&2
  exit 2
fi

app_dir=/opt/puzarchive/app
certbot_dir=/opt/puzarchive/certbot-venv
acme_dir=/var/www/puzarchive-acme
site=/etc/nginx/sites-available/puzarchive
source_dir="$app_dir/deploy"
ip=62.234.13.10

[[ -f "$source_dir/nginx-http-acme.conf" && -f "$source_dir/nginx-public-https.conf" ]] || {
  echo "Missing public HTTPS templates under $source_dir." >&2
  exit 1
}
[[ -x /opt/puzarchive/runtime/bin/node && -f /etc/puzarchive/puzarchive.env ]] || {
  echo 'Existing PuzArchive runtime and configuration were not found.' >&2
  exit 1
}

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx python3-venv
install -d -o root -g root -m 0755 "$acme_dir"
install -d -o root -g root -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled
if [[ -e "$site" && ! -f "$site" ]]; then
  echo "Refusing to replace non-file nginx site path: $site" >&2
  exit 1
fi
if [[ ! -e "$certbot_dir/bin/certbot" ]]; then
  python3 -m venv "$certbot_dir"
  "$certbot_dir/bin/pip" install --disable-pip-version-check 'certbot==5.8.0'
fi
if ! "$certbot_dir/bin/certbot" --version 2>&1 | grep -Eq 'certbot ([6-9]|[1-9][0-9]+)\.|certbot 5\.(4|[5-9]|[1-9][0-9]+)(\.|$)'; then
  echo 'Certbot 5.4 or newer is required for IP certificates; refusing to continue.' >&2
  exit 1
fi

# Ubuntu's stock nginx site is installed enabled on a fresh host. Preserve its symlink
# under sites-available and disable it only when it is the unmodified stock target.
default_site=/etc/nginx/sites-enabled/default
if [[ -L "$default_site" && $(readlink -f "$default_site") == /etc/nginx/sites-available/default ]]; then
  archived_default=/etc/nginx/sites-available/puzarchive-disabled-default
  [[ ! -e "$archived_default" ]] || { echo "Refusing to overwrite $archived_default." >&2; exit 1; }
  mv "$default_site" "$archived_default"
fi

# Temporarily serve only ACME challenge files over HTTP; all other paths return 404.
install -o root -g root -m 0644 "$source_dir/nginx-http-acme.conf" "$site"
ln -sfn "$site" /etc/nginx/sites-enabled/puzarchive
nginx -t
systemctl enable --now nginx
systemctl reload nginx

# Validate reachability against Let's Encrypt staging before requesting the live short-lived IP certificate.
"$certbot_dir/bin/certbot" certonly --dry-run --non-interactive --agree-tos --register-unsafely-without-email \
  --webroot -w "$acme_dir" --ip-address "$ip" --preferred-profile shortlived
"$certbot_dir/bin/certbot" certonly --non-interactive --agree-tos --register-unsafely-without-email \
  --webroot -w "$acme_dir" --ip-address "$ip" --preferred-profile shortlived

install -o root -g root -m 0644 "$source_dir/nginx-public-https.conf" "$site"
nginx -t
systemctl reload nginx

install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy
install -o root -g root -m 0755 "$source_dir/reload-nginx-after-certbot.sh" /etc/letsencrypt/renewal-hooks/deploy/puzarchive-nginx

install -o root -g root -m 0644 "$source_dir/puzarchive-certbot.service" /etc/systemd/system/puzarchive-certbot.service
install -o root -g root -m 0644 "$source_dir/puzarchive-certbot.timer" /etc/systemd/system/puzarchive-certbot.timer
systemd-analyze verify /etc/systemd/system/puzarchive-certbot.service /etc/systemd/system/puzarchive-certbot.timer
install -d -o root -g root -m 0755 /etc/systemd/system/puzarchive.service.d
install -o root -g root -m 0644 "$source_dir/puzarchive-proxy.conf" /etc/systemd/system/puzarchive.service.d/public-proxy.conf
systemctl daemon-reload
systemctl restart puzarchive.service
systemctl enable --now puzarchive-certbot.timer

echo "Temporary HTTPS invitation entrance configured at https://$ip/"
