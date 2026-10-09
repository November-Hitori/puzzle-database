# CI/CD

`Sigmit64/puzzle-database` is the production release repository. Accepted upstream changes are merged and synchronized into its `main`; the upstream repository also runs CI but cannot trigger this deployment job. Next.js preview branches are not production releases.

Pull requests and pushes to `main` run Node and Python tests, real desktop Chromium acceptance, a deterministic source-only package, and a non-root preflight with read-only code, temporary SQLite/member configuration, and trusted-proxy checks. Actions are pinned to commit SHAs. PR jobs have read-only repository access and no deployment secrets.

The production `main` branch requires an independent PR approval and the `Tests, browser and release preflight` check. Codex changes also retain the independent reviewer required by [the contribution workflow](contribution-workflow.md). After a reviewed merge, the same verified artifact deploys automatically; no additional deployment approval is required. Production jobs are serialized and do not cancel a running deployment. A `workflow_dispatch` on `main` retries a release; the server skips an already active commit.

The `production` environment permits only `main` and contains two encrypted secrets: `PUZARCHIVE_DEPLOY_KEY` (a dedicated Ed25519 key) and `PUZARCHIVE_KNOWN_HOSTS` (the previously verified server pin). This key permits only a forced SSH deployment command, with forwarding and interactive sessions disabled. It is separate from the operator's SSH key. Neither key material nor real application state belongs in Git or artifacts.

The server's root-owned gateway accepts a bounded archive, verifies its digest, commit, per-file source manifest, paths, ownership and modes, then obtains a deployment lock. It uses root-owned deployment tools outside the released app. It creates private online and preactivation SQLite backups plus a code rollback copy, atomically exchanges the app directory, starts the service, and compares all old database fields and member configuration in memory. The checks emit aggregate counts and booleans only. A failure rolls back code while retaining the current database. Current tooling permits additive schema markers and increasing ID floors; intentional modifications to historical rows need a separately reviewed preservation policy before deployment.

The app environment, membership settings, registration gate, Nginx and certificates are retained. Production checks use read-only anonymous requests; test registrations, ratings and audits occur only in temporary fixtures. Gateway updates require an independently reviewed operator installation; a release cannot replace root-owned gateway tools itself.

Local commands, from the application repository:

```sh
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
npm run test:browser  # browser environment variables: see README
python3 deploy/release_archive.py pack /tmp/puzarchive-release.tar
bash deploy/preflight.sh /tmp/puzarchive-release.tar /absolute/path/to/node
```

The Linux preflight uses isolated user/mount namespaces. GitHub-hosted runners use `PUZARCHIVE_PREFLIGHT_USE_SUDO=true` to create the mount namespace and then drop to the runner's unprivileged UID.

To initialize or update the gateway only after the complete release gates, run `sudo bash deploy/install-ci-gateway.sh /private/path/to/dedicated-public-key.pub` from the accepted app tree, then populate the environment secrets through GitHub's encrypted secrets API. Preserve the original dedicated known-host pin; never use `ssh-keyscan` or bypass a host-key mismatch during a release.
