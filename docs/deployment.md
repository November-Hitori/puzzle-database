# Private server deployment

The app runs on Ubuntu 24.04 and binds to `127.0.0.1:4173`. For direct private access, use an SSH local forward from a trusted computer:

```sh
ssh -F ~/.ssh/puzarchive.conf -N -L 127.0.0.1:14173:127.0.0.1:4173 puzzle-database-server
```

Create a dedicated `~/.ssh/puzarchive.conf` with the server address and alias. Point `IdentityFile` at a Linux-local private-key copy named `~/.ssh/puzarchive_id_rsa`, and `UserKnownHostsFile` at `~/.ssh/puzarchive_known_hosts`. On Linux or WSL, keep the SSH directory at mode `0700` and both files at `0600`. Compare the server's ED25519 fingerprint with one obtained from its trusted console before saving its key in this dedicated known-hosts file; keep `StrictHostKeyChecking yes` and preserve the normal SSH config and known-hosts files. On Windows, use the original key in PowerShell with an equivalent host-key check.

If SSH reports a changed host key, stop and obtain the current ED25519 fingerprint again from the trusted server console before updating the dedicated pin. Never bypass the mismatch with `StrictHostKeyChecking no`, `accept-new`, or by deleting the old pin without verification. The Linux-local key and pin remain until that Linux environment is deleted; restore them from a separately protected backup if they are lost, since their persistence is not guaranteed beyond that environment.

```sshconfig
Host puzzle-database-server
  HostName SERVER_IP
  User ubuntu
  IdentityFile ~/.ssh/puzarchive_id_rsa
  UserKnownHostsFile ~/.ssh/puzarchive_known_hosts
  StrictHostKeyChecking yes
  IdentitiesOnly yes
  BatchMode yes
```

Then open <http://127.0.0.1:14173/>. Use `127.0.0.1` in the browser: cookies are scoped by host, not port, and this host spelling keeps the deployed session separate from a local app opened at `http://localhost:4173/`.

The app runs as the dedicated `puzarchive` system user. Code and the pinned Node.js runtime are in `/opt/puzarchive`; the SQLite database and trusted member configuration are in `/var/lib/puzarchive` with owner-only permissions. The service reads `/etc/puzarchive/puzarchive.env`, binds to loopback, restarts after failures, and starts at boot. Logs are available with `sudo journalctl -u puzarchive`.

## Runtime and installation

The runtime is Node.js 22.23.3 for Linux x64, downloaded from the official Node.js distribution and checked against SHA-256 `df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de`. The app uses Node's built-in SQLite module and has no production npm dependencies.

The initial install stages an app-only copy and a consistent snapshot containing `puzarchive.sqlite` and `trusted-users.json`, then runs `deploy/install.sh` as root. The installer refuses to overwrite an existing app, runtime, or database. It installs and enables the app service and daily backup timer. For a later code update, stage and review a new release separately; do not rerun the initial installer over an existing deployment. Before activation, ensure the staged app has an empty `data/` directory owned by `root:root` with mode `0755`: startup creates this default directory even when the database paths point to `/var/lib/puzarchive`, and the service keeps app code read-only. Never copy the live database or member configuration into the app directory.

Follow the required [contribution and release workflow](contribution-workflow.md) before uploading source or testing a release on the server.

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

## Bulk rule import

The calendar workbook is private source data and is not part of the release. Prepare it locally with Python 3's standard library; the link column is required because the workbook has separate example and edit links. For the current workbook, use `AD` (the example-link column), not `AE`:

```sh
umask 077
work_dir=$(mktemp -d /tmp/puzarchive-rule-import.XXXXXX)
chmod 0700 "$work_dir"
python3 tools/prepare-rule-import.py \
  --workbook ../2027谜题日历.xlsx --link-column AD \
  --payload "$work_dir/payload.json" --report "$work_dir/report.json"
node scripts/import-rules.mjs --payload "$work_dir/payload.json"
```

Preparation scans rows 3–384, sorts numeric AF clause keys, maps the six source categories to the application's category names, and leaves English rules empty rather than translating. Blank rules, names in only one language, authors, or example links are retained as drafts; a row with neither name or an invalid category is skipped. Nonempty malformed AF data and filled unsupported links are reported. It recognizes concrete Penpa URLs on supported hosts, including the known `#m=edit|solve&p=...` fragment form; rule example URLs are capped at 4,096 characters. TinyURL requests are limited to `tinyurl.com`; redirect chains are bounded and stop at a concrete trusted Penpa URL without fetching the destination. A trusted HTTP Penpa destination is canonicalized to HTTPS without fetching it. Network-layer failures abort preparation without classifying those links as damaged; other HTTP, untrusted, or malformed destinations are reported and skipped. Keep the report and payload in the mode-`0700` temporary directory; they contain workbook content. Review the JSON report, especially skipped rows and duplicate-title conflicts, before any import. Rows sharing a normalized Chinese name are deduplicated by earliest valid source row; when Chinese is blank, English is a fallback key only among other Chinese-empty rows. Conflicting fields are reported, never merged.

The importer defaults to database-free dry-run validation. It never creates or migrates a database. Only after the release has passed the full [contribution workflow](contribution-workflow.md), independent review, and a fresh private online backup may the prepared payload be copied to a private location on the server and explicitly applied. Keep that payload mode `0600`, owned by `puzarchive`, and run the following as that service account:

```sh
sudo -u puzarchive /opt/puzarchive/runtime/bin/node \
  /opt/puzarchive/app/scripts/import-rules.mjs \
  --payload /var/lib/puzarchive/rule-import/payload.json \
  --apply --db /var/lib/puzarchive/puzarchive.sqlite
```

The apply step takes one `BEGIN IMMEDIATE` transaction, skips existing normalized Chinese names without modifying them, and inserts new rules with initial revision snapshots but no approvals or audit votes. It does not touch users, sessions, registration settings, existing rule IDs, puzzles, ratings, completions, or collections. A rerun is idempotent. Retain the private report and backup under the normal protected-data policy; do not place the workbook or payload under the public app tree or commit either to Git.

## Administration

### Membership and accounts

On the first startup with the account-auth release, the service migrates the current `/var/lib/puzarchive/trusted-users.json` into SQLite and invalidates legacy invitation-only sessions. The file must contain exactly one configured member; startup fails clearly if it contains more. The first successful registration claims that member's UUID and display name, preserving its existing puzzle, completion, and rating history. Later registrations get new identities. The shared registration code is reusable and is stored only as a hash in SQLite. After migration the JSON file is a private backup, not an account or registration-control interface; editing it no longer adds, removes, or rotates accounts or the code.

Login uses a unique username and password; no email verification is required. Usernames are NFKC-normalized and case-insensitive for uniqueness. Passwords require 8–128 Unicode characters (maximum 512 UTF-8 bytes) and are stored as salted scrypt hashes. Sessions are private HttpOnly cookies.

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

Each rule has three independent audit groups: bilingual name, Chinese description (English translation optional) plus variant semantics, and example URL plus optional example author. An absent English description does not create a missing-English quality error; the description group can still show its normal pending-audit warning until three members approve it. Changing a supplied English description still advances the description revision and requires its three approvals again. Example URLs may be up to 4,096 characters. A group is approved only after three distinct active accounts approve the current revision. Repeated approval by the same account is idempotent. Any current-revision rejection blocks approval until that group's content is meaningfully edited; rejection suggestions are optional. Editing one group advances only its revision and preserves all earlier review events and content snapshots. Category edits do not reset audit groups, but a separate edit version prevents stale saves from overwriting concurrent changes. Quality errors and warnings are computed by the server and returned with `GET /api/rules`.

Authenticated members may delete an unused rule with `DELETE /api/rules/:id`, sending the current `deleteToken` and `expectedEditVersion` from the loaded rule. The operation is atomic and returns `409` with reference counts if any puzzle in any scope or any variant still refers to it. It never cascades to those records. A stale version/token returns `409`; a successful delete removes that rule's revisions and audit events/votes only. An additive high-water ID allocator prevents normal rule/puzzle IDs and puzzle numbers from being reused after deletion or restart; response objects also include opaque `deleteToken` values as an extra guard against stale confirmation requests.

Calendar submissions use the authenticated account as their immutable uploader; the submitted-by identity is never accepted from the request body. New submissions default to year 2028. A year may be provided without a month or day; no date is invented. The optional author field defaults to the uploader's username.

Completing a calendar puzzle requires an integer difficulty from 1–6, zero to six distinct supported tags, one liking score (`-2`, `-1`, `0`, `1`, or `2`) or `veto`, and the current `expectedReviewRound`. The exact tag choices are `逻辑通顺`, `需要简单结构`, `需要复杂结构`, `需要全局观察`, `通灵`, and `美观`. Approval requires scores from at least three distinct members and an unrounded average strictly above zero. Older clients may still send `support` or `oppose`; the service maps those aliases to `2` and `-2`. A veto moves the item into the leftover list without deleting it; any trusted member may explicitly reenter it with its current round number. Reentry starts a fresh scoring round while retaining previous-round scores, evaluations, completion records, and review history. An account's overall evaluation summary uses that member's latest round only, while history shows per-round aggregates. Calendar review writes are transactional; stale-round requests return `409`.

The neutral-review migration runs once on startup: obsolete neutral ballots, their same-round evaluations, and neutral vote events are removed, while completion records and other reviews remain. Creators can edit puzzle titles and URLs with version/round checks. Optional review clearing removes all ratings and ballots and starts a new round; completion records and comments remain. Comments use a separate API and can be posted after a veto. Incomplete solvers must explicitly reveal comments and average difficulty in the interface.


Calendar workflow exposes a separate `calendarArea`: `review`, `leftover`, `allocation`, or `finished`. Review status stays in the existing `calendarStatus` field. At least three distinct liking scores with an unrounded average strictly above zero move a puzzle to allocation; missing Penpa edit/solve URLs and rule errors are quality errors. An unassigned date, fewer than three drawing-audit approvals, and incomplete rule audits are warnings. Only approved puzzles without unignored errors or warnings reach the finished area. Explicit quality-error ignores are versioned, attributed, reversible, and do not replace required audits. Trust validation of URLs and date-collision checks cannot be ignored.

Submission fields are `penpaEditUrl`, `penpaSolveUrl`, and `puzzlinkUrl`; new external submissions require at least one solve URL. Penpa URLs must have their corresponding `m=edit` / `m=solve` mode. Known legacy links are copied into matching fields without changing their original URL or IDs. Existing suggested dates stay suggestions. Authenticated members may reserve or release an `assignedDate` using the assignment endpoint, with puzzle version and round checks; only the uploader may edit links or titles. Reservations are unique and cleared when voting returns a puzzle to review or leftover, when the uploader clears review history, or when its calendar year changes.

Drawing-audit votes are pinned both to the Penpa link revision and to the provided specification text in `docs/penpa.md`. Changing either requires three new approvals; old decisions remain in history. The bundled specification's whitespace-only reformat preserves its earlier audit revision; wording changes still require new approvals, and custom specification paths keep exact-content hashing. Ensure `calendar-workflow-policy.mjs`, `penpa-guidelines.mjs`, `calendar-review-migration.mjs`, `calendar-score-migration.mjs`, and `docs/penpa.md` are included in release packages. The parent-workspace specification takes precedence locally; deployed applications use the packaged file. Tests can override the path with `PUZARCHIVE_PENPA_GUIDELINES_PATH`.

Legacy calendar ratings are copied once into round-one difficulty evaluations (using the prior logic score); the old rating rows and completion timestamps remain unchanged. The migration does not invent ballots, historical events, or notifications. Old ballots and evaluations remain part of the recorded history if an account is later disabled. New uploader notifications are delivered to the authenticated account's system inbox when its calendar item is approved or vetoed; there is no private-chat feature. Rule notifications go only to a new rule's known creator, or a creator proven by its initial name revision; imported legacy rules with unknown creators remain system-owned and do not get reassigned. English rule descriptions are optional and their absence is neither an error nor a warning, though supplying English text still makes it part of the audited description revision.

The inbox and calendar puzzle lists display ten entries per page and support direct page-number navigation. The current page renders independently of background queries. `GET /api/calendar/page` applies area, personal completion, date sorting, month and optional `q` filters before loading detailed records for the requested page. Searches match exact puzzle numbers (optionally prefixed with `#`) or literal title text and fetch only the requested ten-item page. Lists without a search prefetch the next page. The completed-month calendar receives a complete lightweight date index when no search is active; searches display a paginated result list. Existing full-list calendar endpoints remain compatible with older clients. Inbox read and tag filters apply before paging; explicit `offset` requests include the filtered total for direct jumps, while legacy `before` cursor requests retain their response format. Changing filters or refreshing discards cached pages.

Only the uploader may delete a calendar puzzle with `DELETE /api/calendar/puzzles/:number`, sending the `deleteToken` from the currently loaded puzzle. The operation atomically removes that puzzle and its ratings, per-round evaluations and votes, completion records, tags, and collection links; inbox notifications remain as recipient-owned snapshots. Other accounts, unrelated puzzles, and rule records are unaffected. A stale token returns `409`; an unknown/non-calendar number returns `404`.

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

## Legacy account display normalization

The production identity check established that `Trusted Member` and `Sigmit64` are the same account: the legacy configured member ID is the claimed `Sigmit64` account ID. No account merge is needed. The legacy JSON remains a backup; it does not control the current display name.

After an independently accepted release and a fresh private online backup, the explicitly requested display repair may run as the service account:

```sh
sudo -u puzarchive env PUZARCHIVE_DB_PATH=/var/lib/puzarchive/puzarchive.sqlite \
  PUZARCHIVE_USERS_PATH=/var/lib/puzarchive/trusted-users.json \
  /opt/puzarchive/runtime/bin/node deploy/normalize-legacy-member-name.mjs
```

This isolated command uses the existing database, rechecks that the configured legacy ID and canonical `Sigmit64` username match the sole old display alias, and updates only that account's `name`. It is idempotent, leaves credentials, sessions, IDs and all business records untouched, and refuses distinct or ambiguous accounts rather than merging them. It emits only booleans and counts. Future self-service renames use authenticated `PATCH /api/account/username`; shared allocation-stage Penpa edits use `PATCH /api/calendar/puzzles/:number/penpa-links`, with puzzle version and review-round guards.
