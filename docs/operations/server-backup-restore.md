# Encrypted server backup and restore

This is an operator maintenance procedure, not a deployment or a real-installation integration. Automated drills use isolated synthetic directories only. The API blob server and maintenance CLI target qualified local Unix filesystems; Windows is a client platform.

## Preconditions

- Stop the API and any account administration/migration process. The CLI additionally holds a real SQLite IMMEDIATE writer lock throughout capture; it does not copy a live database/WAL with ordinary `cp`.
- Use private directories owned by the service user (mode 700) on encrypted-at-rest service/restore volumes. Choose a new backup/restore directory; existing destinations are never overwritten or adopted.
- Retain the exact source commit/toolchain/database migration version. Restore requires the exact recognized schema and validates it without applying migrations first. Upgrade only after a successful restore drill with the matching binary.
- Supply a separately managed 32-byte **raw binary** backup key through a dedicated inherited descriptor. Never put the key value in arguments, environment values, repository files, logs or the backup directory. Back up the key through an independent encrypted secret-manager recovery procedure; losing it makes these backups unrecoverable.
- Recover or replace HTTPS material under the existing trusted CA. Use a new token-delivery key after restore. Data backups do not include TLS/signing/backup/token-delivery secrets.

The staging systemd configuration will deliver an encrypted-at-rest `backup.key` credential into `$CREDENTIALS_DIRECTORY` (private runtime memory filesystem). An equivalent secret manager can supply a pipe. Invoke Node directly so an intermediate package-manager child does not discard descriptor 3. Do not use a plaintext persistent key file as a workaround.

## Capture

From the checked-out Attuner root with the pinned toolchain and dependencies installed:

```sh
source scripts/env.sh
ATTUNER_DATA_DIR=/srv/attuner-staging/data \
  node --import tsx apps/api/src/maintenance.ts \
  backup /srv/attuner-staging/backups/capture-2026-11-04 \
  --key-fd 3 3< "$CREDENTIALS_DIRECTORY/backup.key"
```

These `/srv` paths describe a future operator-managed staging service; the agent has not created or deployed them. Use the service account and its configured paths, not root or a real game directory. The tool prints only operation ID, counts and verification digests. SIGINT/SIGTERM cancel at bounded I/O checkpoints. Do not wrap the command in shell tracing.

The result contains `0.sealed`, numbered authenticated encrypted object/chunk files, `catalog.sealed` and a final create-new `receipt.json`. The catalog binds database content, reference order, file hashes/sizes, server UUID, profile heads, immutable snapshot digests and audit cutoff/digest. AES-256-GCM binds each entry to this backup UUID and logical storage reference; swapping entries/backups or changing a ciphertext fails verification. A receipt alone is not sufficient: restoration verifies the authenticated catalog and every entry.

Only verified profile objects and receipted upload chunks referenced by the database are included. Active unreceipted temporary files and unreachable orphans remain untouched in the source; this is not garbage collection. Snapshot publication, upload receipts, audit history, account records and source-device job metadata share one SQLite capture point. The captured audit history includes capture intent; the source's later seal event and the final receipt describe archive publication separately.

SQLite's backup API temporarily writes an owned plaintext database capture and catalog inside `data/.maintenance/capture-*`, protected by the private encrypted service volume. Normal successful completion removes only that operation's scratch directory. Failed/killed captures retain their private scratch and incomplete encrypted destination for operator inspection. Do not treat them as backups, automatically adopt them or delete them through a retention script. Retry capture into a new directory after investigating the failure.

## Clean restore

Keep the existing service/data/backup untouched. Choose a fresh restore root with sufficient space:

```sh
source scripts/env.sh
node --import tsx apps/api/src/maintenance.ts \
  restore /srv/attuner-staging/backups/capture-2026-11-04 \
  /srv/attuner-staging/restore-drill-2026-11-04 \
  --key-fd 3 3< "$CREDENTIALS_DIRECTORY/backup.key"
```

The tool creates `restore-intent.json` before writing plaintext and `restore-ready.json` only after all authentication/content/database/audit checks and durable writes succeed. The API and administrator CLI refuse an intent without its matching ready receipt. Interrupted/corrupt output remains blocked and retained; retry into another new root. No partial-root repair, automatic file removal or inferred adoption is implemented.

Successful restoration preserves server UUID, profile IDs, immutable revisions, source audit bytes and local-client recovery independence. It **revokes all captured device credentials/devices, invalidates web sessions, disables all accounts and denies pending enrollments** atomically with its restore event. An old backup must never resurrect access revoked since capture. No old password or device key is automatically re-enabled.

Before reconnecting, recover exactly one administrator using hidden terminal input:

```sh
source scripts/env.sh
ATTUNER_DATA_DIR=/srv/attuner-staging/restore-drill-2026-11-04 \
  pnpm --filter @attuner/api admin reset owner
```

Use a new password. That explicit local action enables only the selected administrator; other accounts remain disabled until separately reviewed. Configure the restored service with HTTPS and a freshly generated token-delivery key delivered through the encrypted secret provider. Start only an isolated restore-drill listener, log in, review membership/device history and explicitly enroll new device keys. Existing local snapshots, backups, baselines and revision high-water marks remain intact. The native client never silently erases its saved credential; forgetting/re-enrollment is a separate explicit action.

If the recovered server is older than a client's observed revision, synchronization must fail closed. Prefer a newer verified backup. Do not reset client high-water marks, edit snapshot IDs/revisions or forge missing history. Recovering lost post-backup lineage requires a separate reviewed operator procedure/new profile, not automatic rollback acceptance. A new server UUID is also refused, including on an already-open Rust connection; no later authenticated request is sent through that rejected connection.

## Verification and failure evidence

```sh
source scripts/env.sh
pnpm exec vitest run apps/api/src/maintenance
cargo test -p attuner-sync-client --test enrollment three_native_clients_reconnect_after_encrypted_restore_and_refuse_regression --locked
```

The server suite covers original bytes/empty and multi-chunk files, AEAD context/key/tamper/size rejection, links/no-clobber, consistent SQLite locking, clean encrypted restore, immutable manifest/audit checks, three protocol-client re-enrollments, missing/corrupt/truncated data, real failed SQLite audit writes, injected disk exhaustion/cancellation, retained incomplete outputs and actual SIGKILL before/after backup/restore publication. It never fills a disk or resets hardware.

The separate Rust integration test uses three actual native clients and three independent engines: capture two different server revisions; restore the newest into a clean root; reject old credentials; explicitly recover/re-enroll with a rotated delivery key; reconnect; restore the older revision and refuse regression without changing local bytes/baselines; then reject a changed server UUID and further authenticated requests. This test currently runs against an isolated local Unix HTTPS server; it is not a Windows 11/staging deployment qualification claim.

A successful local restore is not an off-site retention, hardware durability or production readiness proof. Keep encrypted copies and key recovery under independent access controls, alert on stale/missing receipts and disk reserve, exercise operator recovery regularly, and retain reports. No automatic retention/GC is provided.
