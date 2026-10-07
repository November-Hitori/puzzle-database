# Private server deployment

The first deployment runs on Ubuntu 24.04 with the app bound to `127.0.0.1:4173`. No public listener, reverse proxy, tunnel, or firewall rule is configured. Use an SSH local forward from a trusted computer to reach it:

```sh
ssh -i /path/to/key_test.pem -N -L 127.0.0.1:14173:127.0.0.1:4173 ubuntu@SERVER_IP
```

Then open <http://127.0.0.1:14173/>. Use `127.0.0.1` in the browser: cookies are scoped by host, not port, and this host spelling keeps the deployed session separate from a local app opened at `http://localhost:4173/`. On Windows, use the original key file in PowerShell. On Linux or WSL, copy it into the Linux filesystem and restrict it to mode `0600` before connecting.

The app runs as the dedicated `puzarchive` system user. Code and the pinned Node.js runtime are in `/opt/puzarchive`; the SQLite database and trusted member configuration are in `/var/lib/puzarchive` with owner-only permissions. The service reads `/etc/puzarchive/puzarchive.env`, binds to loopback, restarts after failures, and starts at boot. Logs are available with `sudo journalctl -u puzarchive`.

## Runtime and installation

The runtime is Node.js 22.23.3 for Linux x64, downloaded from the official Node.js distribution and checked against SHA-256 `df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de`. The app uses Node's built-in SQLite module and has no production npm dependencies.

The initial install stages an app-only copy and a consistent snapshot containing `puzarchive.sqlite` and `trusted-users.json`, then runs `deploy/install.sh` as root. The installer refuses to overwrite an existing app, runtime, or database. It installs and enables the app service and daily backup timer. For a later code update, stage and review a new release separately; do not rerun the initial installer over an existing deployment. Before activation, ensure the staged app has an empty `data/` directory owned by `root:root` with mode `0755`: startup creates this default directory even when the database paths point to `/var/lib/puzarchive`, and the service keeps app code read-only. Never copy the live database or member configuration into the app directory.

## Backups and restore checks

`puzarchive-backup.timer` runs the SQLite online-backup API once daily. Each private backup is a new timestamped directory under `/var/backups/puzarchive`, containing the database, the trusted member configuration, and a creation timestamp. The backup service runs as `puzarchive`; directories are mode `0700`, files mode `0600`. Backups are not pruned automatically, so monitor disk usage and copy selected backups to a separately protected location.

Run an immediate backup with:

```sh
sudo systemctl start puzarchive-backup.service
sudo systemctl status puzarchive-backup.service
```

Check a backup without modifying it:

```sh
sudo -u puzarchive /opt/puzarchive/runtime/bin/node \
  /opt/puzarchive/app/deploy/restore-check.mjs \
  /var/backups/puzarchive/PUZARCHIVE-BACKUP-DIRECTORY
```

The check runs SQLite `integrity_check`, verifies member IDs against SQLite's trusted-user registry, and prints table counts without showing member names or invitation codes. To rehearse a restore, copy one backup into a new private temporary directory, run this check, and start an isolated app process with `PUZARCHIVE_DB_PATH` and `PUZARCHIVE_USERS_PATH` pointing into that directory on a different loopback port. Do not copy a backup over the live database while the service is running. For an actual restore, stop the service, preserve the current live files as a separate rollback copy, restore both backup files with owner `puzarchive:puzarchive` and mode `0600`, then start the service and check its health locally through SSH forwarding.

## Administration

### Membership and accounts

On the first startup with the account-auth release, the service migrates the current `/var/lib/puzarchive/trusted-users.json` into SQLite and invalidates legacy invitation-only sessions. The file must contain exactly one configured member; startup fails clearly if it contains more. The first successful registration claims that member's UUID and display name, preserving its existing puzzle, completion, and rating history. Later registrations get new identities. The shared registration code is reusable and is stored only as a hash in SQLite. After migration the JSON file is a private backup, not an account or registration-control interface; editing it no longer adds, removes, or rotates accounts or the code.

Login uses a unique username and password; no email verification is required. Usernames are NFKC-normalized and case-insensitive for uniqueness. Passwords require 12–128 Unicode characters (maximum 512 UTF-8 bytes) and are stored as salted scrypt hashes. Sessions are private HttpOnly cookies.

Run account administration locally on the server. These commands never put a registration code in shell arguments; rotation prints a newly generated shared code once, which must be conveyed privately:

```sh
sudo -u puzarchive env PUZARCHIVE_DB_PATH=/var/lib/puzarchive/puzarchive.sqlite \
  /opt/puzarchive/runtime/bin/node /opt/puzarchive/app/deploy/accounts.mjs rotate-registration-code
sudo -u puzarchive env PUZARCHIVE_DB_PATH=/var/lib/puzarchive/puzarchive.sqlite \
  /opt/puzarchive/runtime/bin/node /opt/puzarchive/app/deploy/accounts.mjs disable-registration
sudo -u puzarchive env PUZARCHIVE_DB_PATH=/var/lib/puzarchive/puzarchive.sqlite \
  /opt/puzarchive/runtime/bin/node /opt/puzarchive/app/deploy/accounts.mjs revoke-account USERNAME
```

Rotating the shared code affects only future registrations; existing account credentials and sessions are unchanged. Disabling registration stops new registrations but does not revoke existing accounts. Revoking an account disables it and deletes its sessions while preserving puzzle history. Because the shared code remains available to its holders, preventing a revoked person from creating another account also requires rotating or disabling registration. Start the service once after upgrade before running these commands so the one-time migration can establish the pending legacy identity claim.

### Rule drafts and review

Authenticated members can create and edit rule drafts. Creation requires a category and at least one Chinese or English name; all other content can be added later. The service reports missing Chinese/English names, descriptions, example links, and variant bases as quality errors. A supplied example must be a concrete supported Penpa puzzle URL; empty is allowed while drafting. Variant bases are optional for drafts but, when supplied, must refer to a different original rule.

Each rule has three independent audit groups: bilingual name, bilingual description plus variant semantics, and example URL. A group is approved only after three distinct active accounts approve the current revision. Repeated approval by the same account is idempotent. Any current-revision rejection blocks approval until that group's content is meaningfully edited; rejection suggestions are optional. Editing one group advances only its revision and preserves all earlier review events and content snapshots. Category edits do not reset audit groups, but a separate edit version prevents stale saves from overwriting concurrent changes. Quality errors and warnings are computed by the server and returned with `GET /api/rules`.

Inspect the service and loopback listener with:

```sh
sudo systemctl status puzarchive
sudo ss -ltnp '( sport = :4173 )'
```

## Temporary public HTTPS invitation testing

The temporary testing entrance uses the Lighthouse public IP `62.234.13.10` directly and a short-lived Let's Encrypt IP certificate. It does not publish invitation codes or member configuration. The application remains on `127.0.0.1:4173`; Nginx accepts browser traffic on 80/443, serves only ACME challenge files on HTTP, redirects all other HTTP paths to HTTPS, and overwrites the proxy scheme and client IP headers before forwarding. The HTTP bootstrap configuration returns 404 for every non-challenge path. Nginx presents the IP certificate as the TLS default because clients may omit SNI for an IP URL, then rejects mismatched HTTP Host values before proxying.

Before setup, allow inbound TCP 80 from the internet so Let's Encrypt HTTP-01 issuance and renewal can validate the IP. Allow TCP 443 from the intended test audience; keep TCP 4173 private and retain the existing SSH rule. After staging the current app and `deploy/` files under `/opt/puzarchive/app`, run `sudo bash /opt/puzarchive/app/deploy/setup-public-https.sh`. The script installs Nginx and a pinned Certbot 5.8 virtual environment, verifies the IP certificate flow against the ACME staging service, requests the production short-lived certificate, validates Nginx, and enables renewal checks twice daily. The custom `puzarchive-certbot.timer` calls `certbot renew`; its deploy hook validates and reloads Nginx after renewal. Inspect it with `systemctl list-timers puzarchive-certbot.timer` and `journalctl -u puzarchive-certbot.service`.

The script disables only Ubuntu's stock `sites-enabled/default` symlink when it points to the stock site, preserving that symlink under `sites-available/puzarchive-disabled-default`. It refuses to replace an existing archived path. Review other existing Nginx sites before setup because the PuzArchive site uses the default listener on ports 80 and 443. The service drop-in enables trusted proxy handling only after the Nginx config is installed; direct HTTP on loopback, including SSH-forwarded access, continues to use HTTP cookies. The backend ignores forwarding headers by default and trusts them only from loopback when explicitly enabled. Login rate limiting uses the validated single `X-Real-IP` value supplied by Nginx.

This IP certificate is short lived, so its automated renewal timer must remain active for the duration of the invitation test. After the test, remove public access by disabling the PuzArchive Nginx site and the proxy service drop-in, reload/restart the affected services, then remove the listener configuration and certificate only as part of an explicit cleanup. Existing database and trusted member files are not touched by the HTTPS setup.
