# Attuner architecture

Attuner is a self-hosted World of Warcraft configuration synchronization product. The desktop is React/Vite inside Tauri 2; the web dashboard is Next.js 16. Both consume `packages/ui` and framework-free fixture/view models from `packages/shared`.

`crates/sync-core` is independent from Tauri and UI frameworks. Phase 2 implements fixture discovery, complete scans, comparison, local SQLite state, verified backups and journaled application/recovery. The host exposes `get_app_info` and six narrowly scoped local lab commands; no arbitrary-path, apply/restore, filesystem, shell, HTTP, opener, process or credential plugin is exposed. See [local engine boundaries](local-engine.md).

The authoritative backend is Fastify. It owns `packages/database` (Drizzle + SQLite), and will own immutable content-addressed blobs. Next.js never opens SQLite. The demonstration UI never calls the API.

## Dependency direction

- web → ui, shared
- desktop UI → ui, shared, narrowly scoped Tauri command
- desktop native host → sync-core
- api → database, sync-protocol
- ui → shared, React, Radix Dialog and Lucide
- shared → no runtime dependencies
- sync-protocol → Zod and BLAKE3 conformance tooling

## Safety invariants

1. Published does not mean applied. A device acknowledges only after verification.
2. Offline does not mean current or empty.
3. Missing scan coverage does not mean deletion.
4. Both conflict variants remain reachable.
5. Raw file bytes define identity; timestamps only provide hints.
6. Unknown game state blocks application.
7. Independent per-file atomic replacement is not an atomic multi-file transaction.
8. No real installation is used during Phase 1, Phase 2 or automated tests.

## Server storage

The schema includes devices, profiles, memberships, snapshots, manifest rows, blobs, sessions, changes, conflicts/variants, audit events, heartbeats, separate device/web credentials, pairing requests, restore requests and temporary blob pins. Composite foreign keys prevent cross-profile snapshot references. Snapshot rows and manifest rows reject in-place updates. Migrations are applied transactionally through Drizzle and verified against an isolated fresh database and reopen.

Retention deletion, publication transactions, quotas, authentication, database workers and blob storage are not implemented yet. See `decisions.md` for sequencing.
