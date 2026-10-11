# CI/CD

`Sigmit64/puzzle-database` is the production release repository. Accepted upstream changes are synchronized into its `main`; trusted collaborators may merge directly, without a required PR or extra GitHub human approval. The upstream repository also runs CI but cannot trigger this deployment job. Next.js preview branches are not production releases.

Pull requests and pushes to `main` run Node and Python tests, real desktop Chromium acceptance, a deterministic source-only package, and a non-root preflight with read-only code, temporary SQLite/member configuration, and trusted-proxy checks. Actions are pinned to commit SHAs. PR jobs have read-only repository access and no deployment secrets. Direct pushes to `main` trigger the same automated release pipeline.

The production `main` branch accepts trusted collaborator pushes and does not require a PR, required-check gate, or additional GitHub human approval. Branch protection remains enabled with admin enforcement to deny force-pushes and branch deletion; PR and required-check rules are unset. Local tests, package preflight, and independent review are optional quality checks for trusted contributors, not merge prerequisites. On a push, CI/CD still runs its automated tests, browser acceptance, source packaging and preflight before deployment; the gateway backs up state, verifies preservation and health, and rolls back code on failure. No additional deployment approval is required. Production jobs are serialized and do not cancel a running deployment. A `workflow_dispatch` on `main` retries a release; the server skips an already active commit.

The `production` environment permits only `main` and contains two encrypted secrets: `PUZARCHIVE_DEPLOY_KEY` (a dedicated Ed25519 key) and `PUZARCHIVE_KNOWN_HOSTS` (the previously verified server pin). This key permits only a forced SSH deployment command, with forwarding and interactive sessions disabled. It is separate from the operator's SSH key. Neither key material nor real application state belongs in Git or artifacts.

The deployment sender logs sanitized SSH milestones and progress writing to its local SSH input pipe. These byte counts do not confirm that the server has received the archive. SSH uses `ServerAliveInterval=15` and `ServerAliveCountMax=3`; sanitized counters record incoming global control replies and channel window adjustments. Control replies, including a normal type 82 reply, demonstrate SSH responsiveness and do not confirm that the deployment gateway is reading input. If writing makes no progress for 120 seconds, the sender fails and stops its local SSH process; control replies do not reset this deadline. After closing the complete input, it waits for the remote release result within the twenty-minute job limit. Canceling an Actions job does not prove that the remote release process has stopped.

The server's root-owned gateway receives and verifies the complete bounded release before acquiring its deployment lock. Receiving requires progress within 120 seconds and completion within 900 seconds, allowing a source release containing the locally hosted web fonts to finish over a slower connection; incomplete or canceled uploads cannot start a release. It verifies the digest, commit, per-file source manifest, paths, ownership and modes. If another release holds the lock, the validated upload fails immediately instead of joining a queue. The release subprocess inherits the lock and writes its output to a private log. Once that subprocess starts, a gateway cancellation or disconnected SSH output does not release the lock before the release finishes or rolls back; the subprocess also retains the lock if the gateway is killed. Killing the gateway with SIGKILL leaves its private incoming directory available to the release; only remove that directory after its release has ended.

The gateway uses root-owned deployment tools outside the released app. The release creates private online and preactivation SQLite backups plus a code rollback copy, atomically exchanges the app directory, starts the service, and compares all old database fields and member configuration in memory. The checks emit aggregate counts and booleans only. A failure rolls back code while retaining the current database. Current tooling permits additive schema markers and increasing ID floors; intentional modifications to historical rows need an explicit preservation policy that describes the expected changes.

The app environment, membership settings, registration gate, Nginx and certificates are retained. Production checks use read-only anonymous requests; test registrations, ratings and audits occur only in temporary fixtures. Gateway updates are installed separately by the operator; a release cannot replace root-owned gateway tools itself.

Local commands, from the application repository:

```sh
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
npm run test:browser  # browser environment variables: see README
python3 deploy/release_archive.py pack /tmp/puzarchive-release.tar
bash deploy/preflight.sh /tmp/puzarchive-release.tar /absolute/path/to/node
```

The Linux preflight uses isolated user/mount namespaces. GitHub-hosted runners use `PUZARCHIVE_PREFLIGHT_USE_SUDO=true` to create the mount namespace and then drop to the runner's unprivileged UID.

To initialize or update the gateway, run `sudo bash deploy/install-ci-gateway.sh /private/path/to/dedicated-public-key.pub` from the accepted app tree, then populate the environment secrets through GitHub's encrypted secrets API. Preserve the original dedicated known-host pin; never use `ssh-keyscan` or bypass a host-key mismatch during a release.

These timeout and lock protections take effect only after the operator installs the updated root-owned gateway. Older gateways acquire the lock before reading input and can remain blocked after an Actions cancellation. To investigate an old stalled upload, inspect `lslocks` and the holder's `ps` wait channel and `pstree` without printing command arguments. Stop confirmed lock waiters first. Only stop the holder after confirming that it is still waiting on input and has no release subprocess. If a release subprocess exists, keep its lock in place while investigating the release. Do not remove the lock file: existing processes would keep locking the old inode while new deployments use the replacement.
