# Phase 3 local development

Only isolated synthetic installations are supported. Work is incremental; current capability flags remain authoritative. There is no production deployment configuration.

## HTTPS API

From the repository root:

```sh
source scripts/env.sh
pnpm --filter @attuner/api dev:fixture
```

This binds only `https://127.0.0.1:4317`, persists synthetic metadata in `.runtime/attuner.sqlite` and writes its **public root CA** to `.runtime/development-ca.pem`. Its temporary private key is encrypted; its random passphrase stays in memory. The certificate is deliberately not installed into system trust. Restarting this development process generates a new certificate.

```sh
curl --cacert .runtime/development-ca.pem https://127.0.0.1:4317/api/v1/health/ready
```

The normal API entry point requires `ATTUNER_TLS_KEY`, `ATTUNER_TLS_CERT`, `ATTUNER_TLS_PASSPHRASE` and `ATTUNER_TOKEN_DELIVERY_KEY` (32 random bytes encoded as base64). Set `ATTUNER_PUBLIC_ORIGIN` to the externally reachable root HTTPS origin. The key must be encrypted PKCS#8. Supply secrets through a process secret provider, never a checked-in environment file or command argument. The listener has no HTTP credential fallback. Local test CAs are explicitly supplied to individual clients and do not modify global trust stores.

Backend state uses the database worker. Migrations are applied before readiness. Existing pre-Phase-3 snapshots remain immutable but do not gain blob access unless their actual stored content is verified. New publication requires scoped verified blob references and a complete snapshot seal.

Full enrollment/synchronization launch instructions will be added as the dependent milestones complete. The existing web/desktop remote demo remains labeled until live controllers are implemented.

## Administrator and device security

In a separate interactive terminal, from the repository root:

```sh
source scripts/env.sh
pnpm --filter @attuner/api admin bootstrap owner
```

This prompts for a hidden password and bootstraps the sole administrator exactly once. There is no default password or public registration. `admin reset owner` is an explicit local recovery operation: it invalidates sessions and revokes owned devices. The API and CLI use the same app-owned `.runtime/attuner.sqlite` by default. Use the same absolute `ATTUNER_DATA_DIR` when overriding it.

Passwords use Argon2id (64 MiB, three passes). Web sessions use eight-hour Secure/HttpOnly/SameSite=Strict cookies, origin and CSRF checks; device approval and revocation require password confirmation within five minutes. Device enrollment uses an external browser authorization code, S256 PKCE, random state and a P-256 proof key. Device grants intersect current profile memberships. Access tokens last five minutes, rotating refresh tokens thirty days within a ninety-day family. Every proof is URI/method/time/token bound, nonce challenged and replay checked.

Lost token replies have a five-minute encrypted delivery window, bound to the original idempotency key and device proof. Production must retain the delivery key in its secret provider across restarts; rotating it invalidates outstanding delivery caches. The fixture process intentionally uses an ephemeral in-memory key, so a restart can require enrollment again. Credentials are hashed in SQLite; cached delivery responses are AES-256-GCM encrypted. Native private keys, PKCE state and tokens use Keychain on macOS and Credential Manager on Windows, without file fallback.

The framework-independent native client is covered by a real certificate-verified HTTPS enrollment/recovery test. The test-only stdio fixture is not registered in the server runtime. Browser enrollment pages and Tauri command wiring remain the M8 integration work; current application screens do not yet expose connected account management.
