# Phase 3 local development

Only isolated synthetic installations are supported. Work is incremental; current capability flags remain authoritative. There is no production deployment configuration.

## HTTPS API

From the repository root:

```sh
source scripts/env.sh
pnpm --filter @attuner/api dev:fixture
```

This binds only `https://127.0.0.1:4317`, persists synthetic metadata in `.runtime/attuner.sqlite` and writes its **public certificate** to `.runtime/development-ca.pem`. Its temporary private key is encrypted; its random passphrase stays in memory. The certificate is deliberately not installed into system trust. Restarting this development process generates a new certificate.

```sh
curl --cacert .runtime/development-ca.pem https://127.0.0.1:4317/api/v1/health/ready
```

The normal API entry point requires `ATTUNER_TLS_KEY`, `ATTUNER_TLS_CERT` and `ATTUNER_TLS_PASSPHRASE`. The key must be encrypted PKCS#8. Supply secrets through a process secret provider, never a checked-in environment file or command argument. The listener has no HTTP credential fallback. Local test CAs are explicitly supplied to individual clients and do not modify global trust stores.

Backend state uses the database worker. Migrations are applied before readiness. Existing pre-Phase-3 snapshots remain immutable but do not gain blob access unless their actual stored content is verified. New publication requires scoped verified blob references and a complete snapshot seal.

Full enrollment/synchronization launch instructions will be added as the dependent milestones complete. The existing web/desktop remote demo remains labeled until live controllers are implemented.
