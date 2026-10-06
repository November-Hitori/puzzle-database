# Private server deployment

The first deployment runs on Ubuntu 24.04 with the app bound to `127.0.0.1:4173`. No public listener, reverse proxy, tunnel, or firewall rule is configured. Use an SSH local forward from a trusted computer to reach it:

```sh
ssh -i /path/to/key_test.pem -N -L 127.0.0.1:14173:127.0.0.1:4173 ubuntu@SERVER_IP
```

Then open <http://127.0.0.1:14173/>. Use `127.0.0.1` in the browser: cookies are scoped by host, not port, and this host spelling keeps the deployed session separate from a local app opened at `http://localhost:4173/`. On Windows, use the original key file in PowerShell. On Linux or WSL, copy it into the Linux filesystem and restrict it to mode `0600` before connecting.

The app runs as the dedicated `puzarchive` system user. Code and the pinned Node.js runtime are in `/opt/puzarchive`; the SQLite database and trusted member configuration are in `/var/lib/puzarchive` with owner-only permissions. The service reads `/etc/puzarchive/puzarchive.env`, binds to loopback, restarts after failures, and starts at boot. Logs are available with `sudo journalctl -u puzarchive`.

## Runtime and installation

The runtime is Node.js 22.23.3 for Linux x64, downloaded from the official Node.js distribution and checked against SHA-256 `df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de`. The app uses Node's built-in SQLite module and has no production npm dependencies.

The initial install stages an app-only copy and a consistent snapshot containing `puzarchive.sqlite` and `trusted-users.json`, then runs `deploy/install.sh` as root. The installer refuses to overwrite an existing app, runtime, or database. It installs and enables the app service and daily backup timer. For a later code update, stage and review a new release separately; do not rerun the initial installer over an existing deployment.

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

The first member login uses the same trusted member identity and invitation code as the migrated local archive. The secret member configuration is at `/var/lib/puzarchive/trusted-users.json`; do not print it, add it to a shell command, or commit it. Add, remove, or rotate members by editing that file with a secure editor and restarting `puzarchive.service`; removal or rotation invalidates existing sessions.

Inspect the service and loopback listener with:

```sh
sudo systemctl status puzarchive
sudo ss -ltnp '( sport = :4173 )'
```

This deployment deliberately has no public browser URL. Public access would need a separate decision about a domain, TLS, and applicable registration requirements.
