# Attuner staging operator bundle

**Prepared, not deployed.** Target: a dedicated Ubuntu 24.04 LTS x86-64 staging VPS with systemd 255+, Node 24.22.2, pnpm 10.33.4 and Nginx 1.30.6. No service, user, firewall rule, certificate or secret has been installed on the VPS or this Mac. Host provisioning/activation requires separate approval. The older development Compose file is not this staging configuration.

Use a dedicated staging hostname and synthetic accounts/installations. A practical initial target is two vCPUs, 4 GiB RAM and a local encrypted SSD volume with at least 40 GiB available; this is a starting capacity assumption to qualify, not a measured production load guarantee. The API/data/backup server targets local Unix filesystems, not Windows/network storage.

## Prepare files locally

From the repository root:

```sh
source scripts/env.sh
pnpm install --frozen-lockfile
pnpm build
node --import tsx scripts/render-staging.ts https://attuner-staging.example.com .runtime/staging-bundle-20261104
```

Replace the example hostname with the planned dedicated domain. The output directory must not exist. The renderer creates only local configuration/units/scripts/documentation, contains no secrets, and performs no remote calls or installation. Public origin/listener/path inputs are validated; HTTP origins, userinfo, queries, fragments and unsafe paths are rejected. ARM64 hosting requires an explicitly qualified runtime path/artifact instead of silently using the x86-64 default.

The bundle expects reviewed code at `/opt/attuner/current`, the pinned Node runtime below `/opt/attuner/toolchains`, and the qualified Nginx binary at `/opt/attuner/toolchains/nginx-1.30.6/sbin/nginx`. Build using the frozen lockfile and retain source/toolchain hashes. This reproduces a procedure; it does not claim identical binary bytes across different OS/OpenSSL/SDK images. CI validates the official Nginx image by its immutable OCI digest.

## Operator provisioning contract

After separate host-change approval, provision service accounts `attuner-api`, `attuner-web`, `attuner-proxy`, `attuner-monitor`; read-only root-owned code/configuration; private service-owned data/backups; and encrypted secret storage. Do not run the API/dashboard as root. Units grant only the proxy bind-to-443 capability and restrict writes, home access, devices, address families, memory/tasks, core dumps and privilege acquisition. Keep unrelated host services/configuration unchanged.

| Path                                 | Owner/access                       | Purpose                                               |
| ------------------------------------ | ---------------------------------- | ----------------------------------------------------- |
| `/etc/attuner-staging/service.env`   | root-owned, readable settings only | Generated non-secret origin/paths/limits              |
| `/etc/attuner-staging/nginx.conf`    | root-owned, proxy-readable         | Generated HTTPS/limits/log policy                     |
| `/etc/attuner-staging/api-ca.pem`    | public, read-only                  | Verify internal API TLS                               |
| `/etc/attuner-staging/api-cert.pem`  | public, read-only                  | Internal certificate with `attuner-api.internal` SAN  |
| `/etc/attuner-staging/edge-cert.pem` | public, read-only                  | Certificate/chain for the dedicated staging domain    |
| `/srv/attuner-staging/data`          | `attuner-api`, 700                 | Persistent SQLite/WAL/CAS/private maintenance scratch |
| `/srv/attuner-staging/backups`       | `attuner-api`, 700                 | Encrypted backup directories only                     |
| `/srv/attuner-staging/secrets`       | root, 700                          | Authenticated encrypted `.cred` files only            |
| `apps/web/.next/cache`               | `attuner-web`, 700                 | Dashboard cache; remaining code read-only             |

The public network needs only the approved HTTPS listener and the operator's existing administration access. API 4317 and dashboard 4318 remain loopback-only. The bundle does not open firewall ports, change SSH, request ACME certificates or create DNS records. Supply valid certificates through an approved issuer/private-CA procedure; never disable TLS checks to make staging connect.

## Encrypted secret delivery

The API receives fixed credential IDs `api-tls-key` (encrypted PKCS#8), `api-tls-passphrase` and `token-delivery-key` (32 raw bytes). The gateway receives separate `edge-tls-key`/`edge-tls-passphrase`. The manual backup service receives only `backup.key` (32 raw bytes). The dashboard and monitor receive none. Missing/unsafe/wrong-sized credentials fail startup; when `$CREDENTIALS_DIRECTORY` is present the API cannot fall back to environment secrets. Files must be regular/single-link and either private service-owned entries or systemd's exact root-owned/read-only service-user ACL layout. The latter requires `/usr/bin/getfacl` from the distribution's trusted `acl` package (prepared Ubuntu 24.04 baseline `2.3.2-1build1.1`); a missing/unsafe reader fails closed, with no automatic installation.

Systemd 255 [prefers named service-user ACLs](https://github.com/systemd/systemd/blob/v255/src/core/exec-credential.c) over changing credential ownership. The loader therefore checks both file and directory ACLs: exactly root owner plus the one current service UID, read-only file access/traverse-only directory permissions, no group/other/default/extra-user grants and stable identity/metadata. It does not simply allow group-readable files, which would confuse the ACL mask with a group grant. Do not change systemd ownership/ACLs to satisfy the application. A hosted Linux probe uses one UUID-scoped transient, non-networked unit and a **public non-secret marker** to exercise this layout; it does not start Attuner services or provision/decrypt a real credential.

Use `systemd-creds encrypt --name=<credential-id> <source-or-stdin> <name>.cred` on the intended host, with its authenticated host/TPM key. Supply secret input from the approved secret manager or a hidden-input prompt through a pipe; do not create plaintext `.env`/persistent passphrase files. For example, an operator can pipe `systemd-ask-password` into `systemd-creds encrypt --name=api-tls-passphrase - /srv/attuner-staging/secrets/api-tls-passphrase.cred`. Do not echo secrets, enable shell tracing, use null-key encryption or embed secret plaintext `SetCredential=` values. The CI probe's public marker is never used for authentication and is not a substitute for encrypted provisioning.

Provision the backup key from an independently recoverable encrypted secret manager, not solely a host-bound `.cred` file. Systemd credential encryption can bind to the original host/TPM; copying ciphertext to another VPS is not a recovery procedure. Keep offline encrypted key recovery under independent access control. Rotate the token-delivery key after a server restore, following [the recovery procedure](server-backup-restore.md). Signing/updater keys belong to the separate distribution environment and never to this VPS.

Actual systemd encrypted-credential provisioning, service activation and hostname/certificate qualification remain operator-run gates. Project tests exercise the private runtime loader and real TLS, not a claim that a VPS/TPM has been configured.

## Activation and inspection — only after host approval

Review generated files, install units/configuration with their intended ownership/executable modes, and validate the actual target system with `systemd-analyze verify` and Nginx's configuration test before enabling anything. Bootstrap the sole administrator with hidden input using [development administration](phase-3-development.md); no public registration exists. Preserve the public origin exactly: it binds CSRF and DPoP proofs across the TLS gateway.

Start the reviewed API/dashboard/gateway units explicitly. Check their logs/status and the certificate-verified `/api/v1/health/live`, `/api/v1/health/ready`, `/api/v1/capabilities`. Readiness fails if SQLite or writable object storage/reserve is unavailable. Existing transfer limits remain 4 MiB chunks, 1 GiB files, 4 GiB manifests' referenced trees, 16 MiB canonical manifests, two active transfer leases and a 10 GiB default per-profile content quota. Staging reserves 512 MiB physical free space. Kernel ENOSPC still fails closed; a free-space check is not a volume reservation.

Request logs contain only generated IDs, static route classes/templates, allowlisted methods, status and timing. They omit IPs, parameters, query strings, headers, cookies, DPoP, passwords, configuration contents and raw errors. Nginx raw error logging is disabled to prevent accidental URI disclosure; use sanitized status logs and service exit status, then reproduce failures with synthetic fixtures. SQLite audit trails remain the durable authorization/publication record. No external analytics/crash upload/alert message is enabled.

Optional monitor timers are supplied **disabled**. After approval, an operator may enable `attuner-staging-monitor.timer` and `attuner-staging-backup-monitor.timer`. The first performs certificate-verified loopback readiness checks; the second checks bounded backup inventories/catalog hashes and receipt freshness (24-hour default). Failure is a nonzero service status plus structured local journal output. Connect an external alert destination only after explicit user approval. Fresh receipts do not prove decryptability; run actual restore drills. Incomplete retained captures intentionally cause an alert and require investigation, not automatic deletion.

## Explicit backup and restore drills

`attuner-staging-backup@<capture-name>.service` stops/conflicts with the API before using the inherited backup key descriptor. It does not automatically restart the API or schedule backups; the operator reviews the outcome and resumes the service. No backup timer or retention/GC task is enabled. Use a unique alphanumeric/underscore/hyphen capture name.

Restore into a new isolated root following [encrypted server backup/restore](server-backup-restore.md). Keep the original service untouched, rotate delivery secrets, explicitly recover the administrator and re-enroll devices. Verify three clients, immutable revisions/content/audit history, outages, interrupted transfers, stale revisions and rollback refusal before considering staging qualified. Never reset local revision high-water marks to make an older backup appear current.

## Local/CI qualification

With an existing Nginx binary, the pinned project tools and built dashboard:

```sh
source scripts/env.sh
pnpm build
pnpm test:staging
```

Linux hosted CI uses `pnpm test:staging -- --docker` with the digest-pinned official image, no privileges/capabilities, an owned temporary bind mount and loopback-only listeners. This does not install/start systemd services or contact a VPS. On macOS the checker uses the pre-existing local Nginx and records its actual version; no package installation is performed.

The checker runs configuration validation, verified TLS on both hops, secure-cookie login, three scoped authenticated protocol devices, immutable revisions/DPoP, bad-origin/oversized/rate-limit rejection, unknown API CA refusal, real Next.js browser login/screenshot, healthy/outage monitors and sanitized proxy-log inspection. A private FIFO carries only the synthetic gateway passphrase in kernel memory. It cleans up only its own children/temporary fixtures and never changes global Nginx configuration or OS/browser trust stores.

Native Rust recovery and physical Windows 11 qualification remain separate suites. A passing local/container gateway test is not signed distribution, deployed systemd credential qualification, geographic WAN performance or hardware durability evidence.
