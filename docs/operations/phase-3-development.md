# Phase 3 local development

Only isolated synthetic installations are supported. No production deployment, real WoW discovery, unattended synchronization or unattended application is enabled. The default UI uses real authenticated services; the retained visual demo is explicitly selected with `?demo=1`.

## Launch the connected workspace

From the repository root, use separate terminals in this order. `scripts/env.sh` selects the project-pinned Node 24.22.2, pnpm 10.33.4 and Rust 1.99.1.

```sh
source scripts/env.sh
pnpm install --frozen-lockfile
ATTUNER_PUBLIC_ORIGIN=https://127.0.0.1:4318 pnpm --filter @attuner/api dev:fixture
```

The synthetic API binds only `https://127.0.0.1:4317`. Its database and blobs live in the ignored `.runtime` directory. A public CA is written to `.runtime/development-ca.pem`; the temporary private key is encrypted, and its random passphrase stays in memory. This does not install a trusted system certificate.

Bootstrap the administrator once in a second terminal:

```sh
source scripts/env.sh
pnpm --filter @attuner/api admin bootstrap owner
```

Enter a password at the hidden interactive prompt. There is no default password or public registration. If an administrator already exists, sign in with that account. `admin reset <username>` is an explicit local recovery command that invalidates sessions and revokes its devices; do not use it as routine startup. API and CLI must use the same absolute `ATTUNER_DATA_DIR` when overriding `.runtime`.

Start the HTTPS dashboard in a third terminal:

```sh
source scripts/env.sh
pnpm --filter @attuner/web dev:connected
```

Open `https://127.0.0.1:4318`. This loopback development gateway serves Next.js and forwards only `/api/v1/` to the fixed HTTPS API, validating its public CA. It preserves a single external origin for Secure cookies, CSRF and native DPoP proofs. A production reverse proxy is not provided. The gateway writes its public CA to `.runtime/dashboard-ca.pem`. Local browser certificate decisions are manual; inspect the certificate before trusting a development connection. No script changes browser or system trust settings.

Sign in, create a synthetic profile, then launch the native app in a fourth terminal:

```sh
source scripts/env.sh
pnpm dev:desktop
```

In **Connect device**, use `https://127.0.0.1:4318`. Expand **Custom certificate authority** and paste the exact contents of `.runtime/dashboard-ca.pem` (public certificate only). Approve the requested device and explicit profile permissions in the browser, then choose **Return to Attuner**. Credentials, PKCE material and callback codes stay in Keychain on macOS or Credential Manager on Windows. No renderer filesystem, generic HTTP, generic opener or callback-event capability is granted.

On macOS, select **Create fixture → Compare changes**. Review the initial setup choice, approve publication, then separately review and approve local application. **Send receipt** acknowledges the durable local commit; it never asserts that later edits are absent. **Snapshots → Verify backup** checks real preserved bytes. **Local recovery** on the connection screen works without the API or device credentials. Every local directory is minted by the core under Attuner’s app-owned synthetic registry; the UI accepts IDs, never directory paths. Windows file operations remain disabled pending its independent durability gate.

All operations are foreground actions. Refresh reads current metadata; it does not start synchronization. Job progress is reported source-device state and actual durable transfer bytes, not continuous device/game presence. The web dashboard can propose conflict choices but cannot publish or apply local changes. A source device must independently validate any proposal against fresh local files and the current head.

Restarting the development API or gateway regenerates its local certificate. Restart the gateway after an API restart and supply the current dashboard CA to the desktop. Do not bypass a server-ID mismatch: verify that the server was intentionally replaced, then explicitly forget the old local connection and revoke its old device grant where available.

## API-only and labeled demo commands

```sh
source scripts/env.sh
curl --cacert .runtime/development-ca.pem https://127.0.0.1:4317/api/v1/health/ready
pnpm dev:web
```

`pnpm dev:web` serves the labeled design demo at `http://127.0.0.1:3000/?demo=1`. Its HTTP entry page hides credential fields and the request layer refuses authentication or data requests without HTTPS; use the HTTPS command above for accounts. The desktop browser preview is `pnpm dev:desktop:browser`, followed by `http://127.0.0.1:1420/?demo=1`; native operations are visibly disabled. These demos do not contact the synchronization server or mint credentials.

The normal API entry point requires `ATTUNER_TLS_KEY`, `ATTUNER_TLS_CERT`, `ATTUNER_TLS_PASSPHRASE`, `ATTUNER_TOKEN_DELIVERY_KEY` (32 random bytes encoded as base64), and an externally correct `ATTUNER_PUBLIC_ORIGIN`. Supply secrets through a process secret provider, never checked-in files or command arguments. TLS private keys must be encrypted PKCS#8. SQLite mutations use the bounded FULL-WAL worker; all physical blob verification precedes the short CAS transaction.

## Repeatable isolated qualification

Stop development listeners on 4317/4318 and the web dev process before this command:

```sh
source scripts/env.sh
pnpm test:connected
```

It mints its own temporary API database, encrypted TLS keys, random in-memory account password, authenticated protocol clients and verified remote objects. It starts the real HTTPS dashboard, exercises login, profile creation, three scoped devices, two immutable revisions, modification/deletion conflict proposals, text previews, password-confirmed revocation, navigation and WCAG checks at 1440/768/390 pixels. It writes only synthetic screenshots and a credential-free report to `artifacts/phase-3/`, then closes its child process and removes only its own temporary server directory. Browser traces and credential storage-state files are never written. The browser harness accepts only its isolated development certificate; separate HTTPS/native tests verify rejection of untrusted certificates.

For interactive native qualification, `pnpm exec tsx scripts/check-connected-ui.ts --keep-open` retains that isolated service. Its public CA is copied to `.runtime/qualification-ca.pem`. The terminal commands are `approve` (approve the pending fixture enrollment through the real web UI and return the one-time callback to macOS Launch Services), `capture` (update web screenshots), and `stop`. Passwords, tokens and callback URIs are never printed. Revoke/disconnect the disposable native device before stopping; local recovery snapshots remain retained. This test helper is not an API runtime route or deployment feature.

## macOS secure-store verification

The debug bundle is ad-hoc signed, without a stable Developer ID. Test one built binary through enrollment, quit/reopen, reconnect and explicit sign-out before rebuilding it. A rebuild can change code identity. Do not disable Keychain security, change global ACLs, allow all applications, or introduce a file fallback.

```sh
source scripts/env.sh
cargo test -p attuner-sync-client native_os_secret_round_trip_has_no_file_fallback
pnpm --filter @attuner/desktop tauri build --debug
codesign -dv --verbose=2 target/debug/bundle/macos/Attuner.app
```

The credential test creates and removes only its own random `app.attuner.desktop.tests` entry. The app’s connection status distinguishes certificate verification from opening secure storage. If a prompt appears, the owner handles it locally; never copy the macOS password into a report. If no prompt appears and the connection remains pending, record the stage and duration, quit the app, keep the same binary, and retry against the same verified server. Inspect only Attuner’s own entry in Keychain Access if needed, without revealing its secret or modifying access permissions. **Forget saved connection** removes only that origin/server-ID entry, works offline and explicitly does not claim server revocation.

During M8, enrollment, reopening the stored credential, local application, backup verification and revocation all succeeded. A suspected prompt was not confirmed: the user saw none, a process sample showed no blocked Security-framework call, and reconnection completed. No Keychain ACL was changed and no stale entry was deleted to force success. Stable signed-release qualification remains future work.
