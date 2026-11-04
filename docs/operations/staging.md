# Ubuntu 22.04 shared-VPS staging — approval draft

**Prepared locally; not installed or deployed. Do not execute the host commands until the user approves the reviewed bundle and host changes.** Target: the existing `pry.hu` VPS, Ubuntu 22.04.5 LTS / AMD64, 11 GiB RAM (9.3 GiB available), 4 GiB unused swap, 391 GB root filesystem / 288 GB available. These are supplied inventory values, not a remote audit. CPU count, actual filesystem, encryption/swap policy, cgroup mode, installed Nginx build and the dedicated HTTPS hostname remain unconfirmed. `pry.hu` itself is deliberately rejected as the Attuner origin. No SSH, DNS lookup of the host, deployment, package installation, service reload or real WoW access is performed by the preparation tools.

## Compatibility and isolation

Jammy supplies systemd 249. The generated units use **LoadCredential**, not the systemd-250+ encrypted-credential directive. Age-authenticated ciphertext stays under `/srv/attuner-staging/secrets`; an explicit operator unlock prepares bounded root-private tmpfs files under `/run/attuner-staging-secrets`. Systemd copies these into per-service read-only credentials. Nothing falls back to plaintext environment files. Reboot intentionally leaves Attuner locked until another operator unlock; no unrelated service depends on that unlock.

Node **24.22.2** and pnpm **10.33.4** remain project-pinned. Official Node x64 binaries require glibc >=2.28 / kernel >=4.18; Jammy's glibc 2.35 baseline satisfies the ABI. The runtime candidate must be built/tested on actual Ubuntu 22.04 x64, including better-sqlite3's native module; do not copy Mac or Ubuntu 24.04 native dependencies. Rust is not required on the VPS. Age and ACL support come from Jammy's security-maintained `age`/`acl` packages; accept current Ubuntu security revisions, not a frozen vulnerable package. Never replace `/usr/bin/node`, global pnpm, systemd, OpenSSL or the existing Nginx through this bundle.

The existing Nginx remains the only public gateway. `attuner-staging.conf` is an **http-context include**, not a replacement `nginx.conf`. It defines one explicit HTTPS hostname, uniquely named request zones/log format, server-local paths/limits and verified HTTPS to the loopback API. It does not set a default server, worker count, global logging, global body limits, port 80 redirect or certificate automation. No new proxy service, bind capability, firewall rule or port forwarding. Match the host's existing IPv4/IPv6 listener conventions after review; the initial include supplies IPv4 443 only. Do not alter the existing default virtual host.

Public TLS certificate/key paths must come from the host's approved certificate-management process. The shared Nginx **must be able to start/reload independently of Attuner's runtime credentials**, including after a reboot. Do not point its key at `/run/attuner-staging-secrets`. Review encrypted-volume/key-provider protection and swap encryption before provisioning any real secrets; unused swap is not evidence that it is encrypted. The bundle neither changes swap nor weakens TLS, file permissions or host security. Internal API certificate SAN must include `attuner-api.internal`; only its public CA is shared with Nginx/monitor.

| Isolated resource                              | Access / limit                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| API identity                                   | `attuner-api`, system user, no login; owns data/backups only                                                 |
| Dashboard identity                             | `attuner-web`, system user, no login; owns its release's `.next/cache` only                                  |
| Readiness identity                             | `attuner-monitor`, system user, no login; no data/secret access                                              |
| `/opt/attuner/releases/<commit>` and `current` | root-owned versioned code; `attuner-code` group read/execute; services cannot change code/link               |
| `/etc/attuner-staging`                         | root-owned 0750, group `attuner-code`; only public certs/non-secret settings                                 |
| `/srv/attuner-staging/data`, `backups`         | separate 0700 directories owned by `attuner-api`; SQLite/WAL/CAS and encrypted captures                      |
| `/srv/attuner-staging/secrets`                 | root 0700; authenticated `.age` ciphertext only; independent encrypted backup-key escrow required            |
| `/run/attuner-staging-secrets`                 | root 0700 tmpfs; role-ready receipt only after successful unlock; no automatic cleanup/adoption              |
| `/var/cache/attuner-staging`                   | only this site's Nginx temp files; owner is the verified existing Nginx worker user                          |
| `/var/log/attuner-staging/access.log`          | root/adm; sanitized site-only metadata; scoped rotation, no host-wide reopen                                 |
| journal namespace `attuner-staging`            | 128 MiB persistent / 32 MiB runtime budget, seven-day age limit; default journal untouched                   |
| `attuner-staging.slice`                        | aggregate CPU 50% of one core, low CPU/IO weights, MemoryHigh 2 GiB / MemoryMax 3 GiB, swap max 0, 512 tasks |

Service-specific memory/task/fd/core/sandbox limits remain. The initial half-core budget is conservative while CPU count/shared load is unknown; measure before increasing it. Cgroup v2 is a prerequisite for the swap/memory controls; do not change the host's boot/cgroup configuration automatically. Readiness and API admission retain **10 GiB physical free space**, and manual backup/restore also honor that reserve. This is not a disk reservation: other applications can consume free space concurrently. Per-profile quota remains 10 GiB, transfers retain existing bounds, and no GC/retention deletion exists. A separate data volume/project quota is an optional future operator decision, not applied here.

## Prepare and review locally

```sh
source scripts/env.sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec tsx scripts/render-staging.ts https://attuner-staging.example.com .runtime/jammy-review \
  --api-port 4317 --web-port 4318 \
  --certificate /etc/attuner-staging/edge-cert.pem --key /etc/attuner-staging/edge-key.pem
python3 -B scripts/test-jammy-unlock.py
pnpm test:staging -- --shared-host
```

The example domain is **not selected or registered**. Replace it only after the user chooses a dedicated hostname, then regenerate into a new directory. Ports and public TLS paths are configurable and validated; choose two unused loopback ports from the host inventory. The output must not exist. Inspect `manifest.json`: target Jammy/x86-64/systemd 249, shared Nginx, source/dirty status, file digests, `activationApproved:false`, `containsSecrets:false`, `deployed:false`. Rendering does not connect anywhere.

The `staging-jammy` CI job uses an actual Ubuntu 22.04 runner. It downloads/extracts security-maintained Jammy Nginx/age DEBs into its own checkout **without installation, package hooks or service activation**, exercises real age authentication/tampering, tests actual systemd credential ACLs with a public non-secret marker, runs migrations/tests/builds, validates unit directives using `/bin/true` in a private probe copy, and checks the shared-host include through real API/dashboard HTTPS requests plus an unrelated synthetic site. These are separately reported from actual VPS activation. The diagnostic probe's transient systemd unit is not an Attuner service.

The `attuner-staging-jammy-candidate` artifact contains the rendered configuration and a Linux runtime archive, SHA-256 receipt and source commit. It is an unsigned development candidate, not a production release or authorization. Download only from a passing trusted repository/run, retain its exact source commit, and verify its hashes. Runtime archive includes Linux native dependencies, API build, Next production output and required workspace packages. It contains no application database, secrets, `.runtime`, browser session or host configuration. No build runs on the shared VPS. Artifacts expire after 14 days.

## Installation commands — only after explicit approval

These are **operator instructions for later approval**, not actions already performed. Halt on a failed check. Do not use this procedure to repair or upgrade existing applications.

### 1. Read-only inventory and approval inputs

Run locally on the VPS through the operator's existing access method, after approval:

```sh
cat /etc/os-release
uname -m
nproc
free -h
df -hT / /srv
findmnt -no FSTYPE /sys/fs/cgroup
findmnt -no FSTYPE /run
swapon --show
nginx -v
nginx -V
systemd --version
ss -ltn '( sport = :4317 or sport = :4318 )'
systemctl is-active nginx
sudo nginx -t
```

Require Ubuntu 22.04 AMD64, systemd >=249, tmpfs `/run`, cgroup2fs, a local supported Unix filesystem and unused chosen ports. Privately inspect existing Nginx include placement, worker identity, TLS provider and exact/wildcard/regex server-name conflicts; do not publish `nginx -T` output because existing configuration may contain secrets. Confirm the new host is included under `http {}`. Record baseline health checks for each existing site and Nginx configuration backups through the host's normal operator procedure. Do not create DNS/certificates, switch listeners, install packages or change any existing service during inventory.

Review `apt-get -s install --no-install-recommends age acl` with the operator. If either dependency is missing, installing it is a separately reviewed host change; **do not install Nginx or run a distribution upgrade**. Exact approved command, if needed: `sudo apt-get install --no-install-recommends age acl`. Verify `/usr/bin/age` and `/usr/bin/getfacl` are trusted root-owned distribution binaries. Existing TLS-management, encrypted storage/swap, CPU allocation, accounts/path collisions, backups/escrow and the final hostname are approval prerequisites.

### 2. New accounts/directories only

Stop if any proposed account, group, directory, unit, journal configuration, logrotate configuration or Nginx include already exists; inspect it rather than adopting/chowning it. The following assume every Attuner-owned path is new:

```sh
sudo groupadd --system attuner-code
for account in attuner-api attuner-web attuner-monitor; do
  sudo useradd --system --user-group --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin --groups attuner-code "$account"
done
sudo install -d -o root -g attuner-code -m 0750 /opt/attuner /opt/attuner/releases /opt/attuner/toolchains /etc/attuner-staging
sudo install -d -o root -g root -m 0755 /srv/attuner-staging
sudo install -d -o root -g root -m 0700 /srv/attuner-staging/secrets
sudo install -d -o attuner-api -g attuner-api -m 0700 /srv/attuner-staging/data /srv/attuner-staging/backups
sudo install -d -o root -g adm -m 0750 /var/log/attuner-staging
```

Provision the private pinned Node directory `/opt/attuner/toolchains/node-v24.22.2-linux-x64` from the official release, verifying signed SHASUMS with the independently verified Node release keys. Do not pipe downloads into a root shell or replace the system Node. Follow [Node's release verification procedure](https://github.com/nodejs/node#verifying-binaries); no key fingerprint is invented by this bundle. Confirm the installed private binary prints `v24.22.2`.

Download and extract the reviewed artifact to a new operator-owned directory. The CI ZIP preserves `.runtime/` and `artifacts/` subdirectories; locate the three `attuner-staging-jammy-runtime.*` files under `.runtime`, and run the following from that folder (the rendered configuration is its `jammy-bundle` subfolder). From there:

```sh
sha256sum -c attuner-staging-jammy-runtime.tar.gz.sha256
ATTUNER_RELEASE=$(cat attuner-staging-jammy-runtime.source)
case "$ATTUNER_RELEASE" in *[!0-9a-f]*|'') exit 1;; esac
test "${#ATTUNER_RELEASE}" -eq 40
sudo mkdir -m 0750 "/opt/attuner/releases/$ATTUNER_RELEASE"
sudo tar --no-same-owner --no-same-permissions -xzf attuner-staging-jammy-runtime.tar.gz -C "/opt/attuner/releases/$ATTUNER_RELEASE"
sudo chown -R root:attuner-code "/opt/attuner/releases/$ATTUNER_RELEASE"
sudo chmod -R g+rX,o-rwx "/opt/attuner/releases/$ATTUNER_RELEASE"
sudo chmod 0750 "/opt/attuner/releases/$ATTUNER_RELEASE"/infrastructure/staging/run-*.sh
sudo install -d -o attuner-web -g attuner-web -m 0700 "/opt/attuner/releases/$ATTUNER_RELEASE/apps/web/.next/cache"
sudo ln -s "/opt/attuner/releases/$ATTUNER_RELEASE" /opt/attuner/current
```

The source must match the chosen passing CI run; a checksum from an untrusted archive does not authenticate its publisher. All extraction/chown applies only to the newly created Attuner release. Install public API CA/certificate and the approved existing-host-managed edge certificate/key references. Do not generate a public certificate or export a production private key through chat. The renderer can reference existing managed TLS paths instead of copying them.

### 3. Install reviewed non-secret configuration (no activation)

From the rendered bundle folder, after verifying every manifest digest:

```sh
sudo install -o root -g attuner-code -m 0640 service.env /etc/attuner-staging/service.env
sudo install -o root -g root -m 0644 attuner-staging-*.service attuner-staging-*.timer attuner-staging.slice /etc/systemd/system/
sudo install -o root -g root -m 0644 journald-attuner-staging.conf /etc/systemd/journald@attuner-staging.conf
sudo install -o root -g root -m 0644 attuner-staging.logrotate /etc/logrotate.d/attuner-staging
sudo systemd-analyze verify /etc/systemd/system/attuner-staging-*.service /etc/systemd/system/attuner-staging-*.timer /etc/systemd/system/attuner-staging.slice
sudo systemctl daemon-reload
```

Do not enable units or reload/restart Nginx yet. Set the new `/var/cache/attuner-staging` directory owner to the **verified existing Nginx worker user/group**, mode 0700; never change ownership of existing Nginx directories. Example only if the inventory confirms `www-data:www-data`: `sudo install -d -o www-data -g www-data -m 0700 /var/cache/attuner-staging`. Check logrotate in debug-only mode: `sudo logrotate --debug /etc/logrotate.d/attuner-staging`. Copytruncate affects only Attuner's access log, does not signal shared Nginx, and may lose request-log lines in a rotation race; transactional SQLite audit history is independent. The daily host logrotate scheduler can permit growth beyond 20 MiB between invocations; these are operational budgets, not hard filesystem quotas.

### 4. Encrypted provisioning and explicit first start

Provision these authenticated ciphertext files as root 0600 inside the new private secrets directory:

- `api-tls-key.age`: the **encrypted PKCS#8** internal API key (never an unencrypted private-key file).
- `api-tls-passphrase.age`: hidden-input passphrase for that key, maximum 1024 bytes.
- `token-delivery-key.age`: exactly 32 random raw bytes.
- `backup.key.age`: exactly 32 raw bytes, independently recoverable from the approved encrypted secret manager. Host-only ciphertext is not sufficient escrow.

Use Jammy age's passphrase mode, which reads its encryption password from the terminal, not an argument/environment variable. Enter a nonempty strong encryption passphrase; do not leave it blank, since age 1.0 prints an autogenerated passphrase to stderr in that case. Examples for the new server token key and a TLS passphrase (each age output path must be absent):

```sh
sudo sh -c 'umask 077; openssl rand 32 | /usr/bin/age -p -o /srv/attuner-staging/secrets/token-delivery-key.age'
sudo sh -c 'umask 077; systemd-ask-password "Internal API TLS passphrase:" | /usr/bin/age -p -o /srv/attuner-staging/secrets/api-tls-passphrase.age'
```

Supply `api-tls-key.age` from the already encrypted PKCS#8 key using `sudo age -p -o /srv/attuner-staging/secrets/api-tls-key.age /approved/path/internal-encrypted-key.pem`. Escrow/provision the backup key through the approved secret manager pipe, never through a plaintext persistent file or shell literal. Disable shell tracing; never use `SetCredential` for authentication material. Operator input/age processing requires an actual terminal. The helper accepts only the fixed `api` or `backup` role, requires root/Linux/tmpfs/trusted age, checks private single-link bounded ciphertext, authenticates every role entry, refuses existing runtime output and preserves failed private stages for investigation. It never starts a service or changes permissions to make a secret readable.

```sh
sudo python3 -B /opt/attuner/current/infrastructure/staging/unlock-credentials.py api
sudo -u attuner-api env NODE_ENV=production ATTUNER_DATA_DIR=/srv/attuner-staging/data \
  /opt/attuner/toolchains/node-v24.22.2-linux-x64/bin/node \
  /opt/attuner/current/apps/api/dist/apps/api/src/admin.js bootstrap owner
sudo systemctl start attuner-staging-api.service attuner-staging-web.service
sudo systemctl status attuner-staging-api.service attuner-staging-web.service --no-pager
sudo systemctl start attuner-staging-monitor.service
sudo journalctl --namespace=attuner-staging -u attuner-staging-api.service -u attuner-staging-monitor.service --no-pager
```

Bootstrap only once with hidden password input; no default/public account exists. Verify actual cgroup limits with `systemctl show attuner-staging.slice -p CPUQuotaPerSecUSec -p MemoryHigh -p MemoryMax -p MemorySwapMax -p TasksMax`. Check certificate-verified loopback readiness before exposing the virtual host. The web/API must bind only to the chosen loopback ports. Rebooted/locked services skip startup until an explicit unlock; no automatic secret recovery/fallback.

### 5. Add just the new HTTPS site

Only after the dedicated DNS/certificate/listener review and existing-site baseline checks:

```sh
sudo python3 -c '
import os, sys
content = sys.stdin.buffer.read(65537)
if not content or len(content) > 65536:
    raise SystemExit("Unexpected include size")
fd = os.open("/etc/nginx/conf.d/attuner-staging.conf", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
with os.fdopen(fd, "wb") as output:
    output.write(content)
    output.flush()
    os.fsync(output.fileno())
' < attuner-staging.conf
sudo nginx -t
sudo systemctl reload nginx
```

The create-new operation refuses any existing file, directory or symlink, including concurrent creation; it never overwrites a Nginx configuration. The stated include path must already be included in the existing host's `http {}`. If it is not, stop and review a host-specific change; do not edit `nginx.conf` or enable a second include automatically. Never run `restart nginx` or install/replace Nginx for this procedure. If `nginx -t` fails, remove only the new verified Attuner file before proceeding; the running Nginx keeps its prior configuration. A successful syntax test does not prove every existing site works: recheck their baseline health immediately after a graceful reload. Verify the chosen Attuner origin, secure-cookie login, three synthetic devices/revisions, bad-origin/size/rate rejection, certificate trust, explicit conflicts and outages. No real game files or automatic apply.

After manual review, optional readiness and backup-freshness timers can be started/enabled **only for Attuner**. No backup timer exists. `attuner-staging-backup@<unique-name>.service` stops/conflicts with the API, uses an explicitly unlocked backup role and does not restart it. Run the freshness monitor after a successful encrypted backup, inspect its status and then resume the API explicitly. Receipt freshness checks catalogs/age, not decryptability. Run clean-root restore/three-client drills using [the recovery guide](server-backup-restore.md). Incomplete captures alert and remain retained; never delete them to manufacture a pass. Alerts stay local until an external destination is separately approved.

## Rollback and secret locking

Record the new include's SHA-256 and previous `current` link before activation. To roll back first exposure, verify `/etc/nginx/conf.d/attuner-staging.conf` still matches the installed reviewed hash, then remove **only that new include**. Run `sudo nginx -t`; only if it passes, `sudo systemctl reload nginx` and recheck existing-site health. Never restore the entire old Nginx tree over unrelated edits or restart it to force a rollback.

Stop/disable only `attuner-staging-monitor.timer` and `attuner-staging-backup-monitor.timer` if enabled. Stop Attuner's API/web and any explicitly identified active backup instance; never use wildcard stop/kill commands against unrelated services. Inspect unit states before locking secrets. After verifying encrypted source/escrow recovery, unlink only the selected role's known runtime files and ready receipt (`api-tls-key`, `api-tls-passphrase`, `token-delivery-key`, `api.ready` or `backup.key`, `backup.ready`) under `/run/attuner-staging-secrets`. Do not print secret contents, recursively remove unknown partial stages or change ACLs. Unknown leftovers require private investigation. API/web/backup must be inactive during rotation/locking; absence of a receipt is a locked state, not a retry authorization.

For a later code upgrade: stop Attuner after a verified encrypted backup; retain the prior release/link and migration record; switch only Attuner's `current` symlink atomically to a reviewed new release. Roll back the link only if database schema compatibility is demonstrated. **Never run old code against a newer migrated database.** Otherwise restore into a separate clean data directory, perform required account/session/device revocation and re-enrollment, and reconcile clients without resetting high-water marks. Do not overwrite the current database or delete CAS/backups. Removing Attuner unit/config files is optional after they are inactive and their installed hashes are verified; never remove accounts, shared groups, host packages, other sites, data or encrypted backups automatically.

## Verification boundaries

Local render, unit/security tests, actual local Nginx rehearsal, actual Ubuntu 22.04 CI and actual VPS approval/activation are separate gates. Native Windows/Keychain/signing remain separate Phase 4 work. The host's existing Nginx package version, certificates, encrypted provisioning, log namespace, aggregate cgroup enforcement, DNS and operator rollback must be checked on the approved VPS later; no such result is claimed by this bundle.

Sources: [Jammy systemd](https://packages.ubuntu.com/jammy-updates/systemd), [systemd 249 credentials](https://github.com/systemd/systemd/blob/v249/man/systemd.exec.xml), [systemd 249 resource controls](https://github.com/systemd/systemd/blob/v249/man/systemd.resource-control.xml), [Jammy age](https://packages.ubuntu.com/jammy/age), [Jammy maintained Nginx](https://packages.ubuntu.com/jammy/nginx), [Node 24 ABI](https://github.com/nodejs/node/blob/v24.22.2/BUILDING.md), [Nginx server names](https://nginx.org/en/docs/http/server_names.html). Distribution security patch status and exact installed revisions must be reviewed before host approval.
