# Attuner

**World of Warcraft Configuration Sync** · Your WoW setup. Everywhere.

Phase 3 connects the independent Rust engine to an authenticated HTTPS Fastify service: scoped devices, verified resumable blobs, immutable revisions, compare-and-swap publication, explicit three-way review, transactional local application and recovery. The Tauri desktop and Next.js dashboard share the Attuner design system.

**Synthetic installations only.** No real WoW access, automatic synchronization or production deployment. Windows filesystem application remains disabled pending independent native durability qualification.

## Launch locally

Use separate terminals from the repository root, in order:

```sh
source scripts/env.sh
pnpm install --frozen-lockfile
ATTUNER_PUBLIC_ORIGIN=https://127.0.0.1:4318 pnpm --filter @attuner/api dev:fixture
```

```sh
source scripts/env.sh
pnpm --filter @attuner/api admin bootstrap owner
```

Bootstrap once using the hidden password prompt; existing installations use their existing account. No default password or public registration exists.

```sh
source scripts/env.sh
pnpm --filter @attuner/web dev:connected
```

Open **https://127.0.0.1:4318**, sign in and create a synthetic profile. Then:

```sh
source scripts/env.sh
pnpm dev:desktop
```

Connect the desktop to the same HTTPS origin, supplying the **public** `.runtime/dashboard-ca.pem` in its custom CA field. Approve explicit device/profile permissions in the browser. macOS supports app-owned fixture creation, scan, review, publication, separately approved application, receipts and verified backup history. Credentials stay in the OS secure store; local recovery works offline.

See [complete launch/certificate/secure-store instructions](docs/operations/phase-3-development.md). The project pins Node 24.22.2, pnpm 10.33.4 and Rust 1.99.1. On a new Apple Silicon development machine, inspect and run `sh scripts/bootstrap-macos.sh` for project-local tools; elevated/system prerequisites require owner approval.

## Verification and limits

- [Phase 3 verification, screenshots and remaining gates](docs/operations/phase-3-verification.md)
- [Cold/warm capture and transfer measurements](docs/operations/phase-3-performance.md)
- [Standalone physical Windows 11 qualification](docs/operations/windows-11-qualification.md)
- [Approved architecture](docs/architecture/phase-3-plan.md), [API](docs/architecture/phase-3-api.md), [local safety/recovery](docs/architecture/local-engine.md), [milestone ledger](docs/operations/phase-3-progress.md)
- [Recommended Phase 4 qualification and hardening](docs/architecture/phase-4-recommendation.md)

```sh
source scripts/env.sh
pnpm verify
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
pnpm --filter @attuner/desktop tauri build --debug
```

Stop other dev listeners before `pnpm verify`; its connected check mints isolated temporary services, credentials and synthetic objects. It never writes browser traces or credential storage-state files. The three real Rust client/recovery tests are separate from the web protocol-fixture driver.

Connected UI data is real service metadata about synthetic fixtures. The retained design scenarios are explicitly simulated: run `pnpm dev:web` and open `http://127.0.0.1:3000/?demo=1`. The desktop browser preview uses `pnpm dev:desktop:browser` and `http://127.0.0.1:1420/?demo=1`; native commands are disabled there. Demo interactions do not contact the sync server.

The server is trusted with plaintext configuration content; this is not end-to-end encryption. Real game interlocks/adapters, signed release qualification, Windows apply, automatic cleanup and production operational hardening remain out of scope. Phase 1/2 history remains documented in [foundation verification](docs/operations/verification.md) and [local-engine verification](docs/operations/phase-2-verification.md).

## Workspace

`apps/{desktop,web,api}`, `packages/{ui,shared,sync-protocol,database}`, `crates/{sync-core,sync-client}`, `fixtures`, `infrastructure`, `docs`.
