# Phase 2 implementation plan

Scope is approved local synchronization-engine work only. No real installation discovery, background activity, network synchronization or deployment.

## Modules

- `protocol`: preserve wire manifest types and shared conformance; strengthen shared path checks together where required.
- `error` / `control`: typed errors, cancellation, explicit fixture game-state guard, progress, fault-injection seam.
- `workspace` / `adapter`: minted private temporary workspaces, no arbitrary game roots; versioned fixture descriptors, capability-scoped I/O, exclusion of links/reparse points/hard links/special files.
- `scan`: bounded streaming BLAKE3, pre/post stability checks, sorted inventory, complete scan receipts and coverage-bound comparisons.
- `compare`: deterministic explicit add/modify/delete and three-way conflict results; no Lua execution/merging.
- `store`: bundled patched SQLite with foreign keys and FULL durability; installation mappings, immutable snapshots, baseline, operation state and steps.
- `backup`: streaming Zstandard CAS, size/window limits, raw-byte verification and durable promotion.
- `apply`: preflight space, operation lock, staging, verified backup preimages, durable per-step intent, conditional replacement, final verification and baseline acknowledgement.
- `recovery`: recover from journaled before/after hashes; preflight recovery before mutating anything; refuse unexpected third-party bytes and preserve all backups.

Dependencies: Serde, BLAKE3, unicode-normalization plus Unicode case folding, cap-std/cap-fs-ext for capability I/O, bundled rusqlite, Zstandard, tempfile, thiserror, tracing, fs2 for space queries; Tokio only at the host boundary if needed. Do not introduce a service or framework dependency into sync-core.

## Milestones and acceptance

1. Sandbox + adapters + stable scans + comparison: protocol conformance, complete coverage, link/path/collision rejection, deterministic changes, cancellation and fail-closed runtime state.
2. SQLite + backups: reopen persistence, immutable snapshot/baseline transactions, streaming raw-byte verification, corrupt/truncated backup rejection.
3. Apply/recover: same-volume staging, preimages verified before mutation, durable intent, atomic per-file replacement where supported, rollback, explicit conflicts on concurrent edits, no baseline advance on partial operation.
4. Fault testing + benchmarks: deterministic space/I/O/verification failures, interruption at each mutation boundary, genuine subprocess termination and reopen, large-file/small-file throughput and memory observations.
5. Native local lab: session-scoped fixture operations only, bounded result payloads, off-main-thread work, scan/changes/history/backup verification/cancellation. Existing web remote demo remains distinct.

## Risks and limits

An uncooperative writer can race checks; do not equate an Attuner lock with a game launch interlock. Only fixture adapters are writable. Process-state enforcement is a continuously checked fixture capability, not a claim of real WoW detection. A multi-file operation is journaled and recoverable, not globally atomic. Root and internal-store path tampering must fail closed. OS power-loss guarantees and Windows replacement/locking behavior require native platform verification. Synthetic workspaces remain isolated in private temporary directories and may be purged by the OS; they are not production backup destinations.

Implementation proceeds in this order, running relevant checks after each milestone. Significant scope or safety changes must be documented before use.

## Platform qualification and measured optimization

Durable directory syncing is required before destructive application. The current implementation is qualified on this macOS Unix filesystem; Windows fixture writes fail closed until a native durability implementation is tested. Unix integration tests are explicitly gated; wire/protocol tests remain portable. Do not present Windows native engine writes as supported.

The first 10,004-file measurement showed per-object directory flush overhead. Object contents still receive individual `sync_all`; CAS directory entries will be flushed once at each snapshot/apply preparation boundary, before any SQLite reference or managed mutation. This batches metadata durability without weakening the recovery ordering.
