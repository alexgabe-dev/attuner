# Attuner

**World of Warcraft Configuration Sync**

Your WoW setup. Everywhere.

Phase 2 adds a framework-independent Rust local engine: complete scans, three-way comparison, SQLite metadata, verified Zstandard snapshots, journaled application and restart recovery. **Only isolated synthetic temporary workspaces are supported.** No real WoW installation, background sync or server sync is connected.

## Run locally on Apple Silicon

```sh
sh scripts/bootstrap-macos.sh
source scripts/env.sh
pnpm install --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:3000. The foundation API is on http://127.0.0.1:4317/api/v1.

In another terminal from this directory:

```sh
source scripts/env.sh
pnpm dev:desktop
```

Alternatively build and open the standalone native app:

```sh
pnpm --filter @attuner/desktop tauri build --debug
open target/debug/bundle/macos/Attuner.app
```

## What works

- In the native app, choose **Overview → Local engine → Create fixture workspace**, then **Scan fixture files**, **Capture snapshot** and **Verify backups**. Files, changes and snapshot history come from actual local Rust operations.
- Versioned synthetic adapters, double-pass streaming BLAKE3 scans, portable paths and conservative Unicode/case collision checks.
- SQLite installation mappings, complete scans, immutable snapshots, baseline and durable operation journals.
- Content-verified compressed backups, explicit local snapshot application and idempotent recovery in the Rust library. Apply/recovery are deliberately absent from the UI command surface.
- Fault tests covering concurrent edits, interrupted writes, insufficient space, corruption, subprocess crashes and hard kills.
- Eight navigable views across web and desktop.
- Five selectable scenarios: synchronized, pending, offline, conflict and error.
- Activity/addon filters, event/device dialogs and keyboard command menu.
- Snapshot selection, fixture diff, revision swap, search and unified/split modes.
- Session-only conflict resolution, preference save/discard and cancelable demo progress.
- Responsive drawer, focus handling and reduced-motion behavior.
- Real Fastify health/capability endpoints, SQLite migrations and constraints.
- Shared Zod/Serde manifest conformance and BLAKE3 hash vectors.
- Narrow native fixture commands and original app icon.

## What is mocked or deferred

The **Remote demo** and web dashboard remain fictional: profile/device/addon/activity records, remote revisions, pairing and conflict choices are simulations. Demo sync changes only in-memory UI state. The **Local engine** view clearly labels its real synthetic data. Its fixture guard is not real game detection; native lab sessions cannot currently reattach after an app restart. Core reopen/recovery is tested independently. Temporary labs may be purged by the OS and are not production backup destinations.

Durable local engine operations are qualified on the tested macOS filesystem. Windows operations fail closed until native durability/reparse-point validation is implemented and tested. No authentication, real adapters, process interlock, remote blob storage, SSE, tray or credentials integration exists.

## Structure and verification

`apps/{desktop,web,api}`, `packages/{ui,shared,sync-protocol,database}`, `crates/sync-core`, `fixtures`, `infrastructure`, `docs`.

See [development commands](docs/operations/development.md), [local engine architecture and recovery](docs/architecture/local-engine.md), [Phase 2 plan](docs/architecture/phase-2-plan.md), [Phase 2 verification](docs/operations/phase-2-verification.md), and [Phase 3 proposal](docs/architecture/phase-3-plan.md).

Foundation references: [architecture](docs/architecture/overview.md), [scope decisions](docs/architecture/decisions.md), [protocol](docs/protocol/v1.md), [design system](docs/design/system.md), [Phase 1 verification](docs/operations/verification.md).
