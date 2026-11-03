# Phase 3 performance measurements

Measurements use isolated synthetic fixtures on macOS/arm64, Rust 1.99.1 release builds and SQLite 3.54.1. Both runs have a warm OS cache because the harness has just generated the files. **Cold** below means an empty content-addressed store, not an OS-cache-cold machine. No cache purge, elevated operation or real installation was used. These are single paired observations, not a statistical guarantee.

## Local snapshot capture

The dataset matches Phase 2: 10,004 files, 175,177,882 bytes (167.06 MiB), including 10,000 unique 4 KiB files and a 128 MiB file. The content is highly compressible.

| Operation                   | Instrumented baseline | Optimized | Observation                               |
| --------------------------- | --------------------: | --------: | ----------------------------------------- |
| Complete scan               |               1.312 s |   1.333 s | Two streaming hash passes retained        |
| First capture, cold CAS     |              45.658 s |  47.718 s | No cold-capture speedup claimed           |
| Unchanged capture, warm CAS |               3.758 s |   2.416 s | 35.7% lower in this pair                  |
| One-file-changed capture    |               3.750 s |   2.640 s | 29.6% lower; one object recompressed      |
| Full backup verification    |               0.460 s |   0.456 s | Original bytes checked                    |
| One-file local apply        |               5.494 s |   5.527 s | Recovery/durability protocol unchanged    |
| Maximum resident set        |             56.78 MiB | 54.36 MiB | Launcher-reported local benchmark process |

The baseline attributed 31.10 s to 10,004 object-file flushes, 1.87 s to encoding/hashing, 1.31 s to compressed-object verification, 2.61 s to its two capture scans and 0.015 s to SQLite capture. The optimized first capture still spent 33.04 s flushing objects. Flush/metadata variance dominates the cold result and explains why removing a scan did not produce a measured cold improvement.

The supplied complete scan already provides its two-pass/inventory proof. Capture now verifies or creates each immutable object, then performs one new complete two-pass scan before publishing references. It retains namespace/root validation, original-byte hashing, compressed verification, file flushes and directory sync. A creation during object reuse fails capture without publishing a snapshot. Existing crash/recovery tests remain unchanged.

Disk budgeting now reserves new-object bytes plus snapshot metadata and the existing free-space reserve. Presence is used only for budgeting; existing content is still verified before reuse. Unchanged capture encoded/flushed zero objects and reused 10,004; changing one file encoded/flushed one and reused 10,003. Source timestamps never authorize skipped managed-file hashing.

Raw paired evidence: `artifacts/phase-3-profile-instrumented-baseline*.{json,txt}` and `artifacts/phase-3-profile-optimized*.{json,txt}`. The earlier exploratory `phase-3-profile-initial` result is retained separately; its first checkpoint counts include the initial scan. Paired first-capture counts exclude that scan. Changed checkpoint counts include the immediately preceding fresh scan, while `changedCaptureMs` measures capture only.

Run the current harness:

```sh
source scripts/env.sh
cargo run --release -p attuner-sync-core --example snapshot_profile
```

## HTTPS transfer

A real Rust client enrolls against the real TLS Fastify/SQLite service. The input is one streamed 64 MiB repeated-byte object, with no whole-input allocation. Downloads use durable local prefix receipts and independently verify the complete original object before compressed import. This is TLS loopback on a warm filesystem cache, not an Internet/VPS latency simulation.

| Operation                         | Before verified range index |                 After |
| --------------------------------- | --------------------------: | --------------------: |
| Cold upload payload               |            64 MiB / 0.747 s |      64 MiB / 0.751 s |
| Warm reuse payload                |       **0 bytes** / 0.097 s | **0 bytes** / 0.095 s |
| Download with durable checkpoints |                     1.804 s |               0.413 s |
| Verified compressed import        |                     0.105 s |               0.106 s |
| CAS publication                   |                     0.097 s |               0.098 s |

Previously every 4 MiB range rehashed the entire object, producing quadratic read work for large objects. Migration 0007 retains immutable, profile-scoped chunk identities only after complete object verification. A requested range verifies the one or two intersecting chunks through one pinned handle, with a 64 KiB buffer, before returning bytes. The client still verifies the complete BLAKE3 identity. Legacy objects without the index retain full-object verification. Cross-boundary, corruption, immutability and legacy-fallback tests pass.

The native coordinator's lazy backup reader also avoids exporting/decompressing content when the server already has a verified profile pin. A restore-to-known-content integration test publishes a new revision with zero encoding, export or payload upload.

Raw evidence: `artifacts/phase-3-network-baseline.json` and `artifacts/phase-3-network-optimized.json`.

```sh
source scripts/env.sh
cargo test --release -p attuner-sync-client --test enrollment large_network_benchmark -- --ignored --exact --nocapture
```

## Remaining performance work

Cold OS-cache performance has not been measured; it requires a controlled cache/VM environment. WAN latency, 100,000-entry trees, incompressible content and sustained multi-profile load remain qualification targets. The server currently admits two transfers globally, and the foreground coordinator uses one at a time.

The 48-second cold capture is still a material product limit. The next reviewed format should use immutable object packs to amortize file creation/flush/rename cost, rather than reduce durability. See `docs/architecture/immutable-object-packs.md`. That format is designed, not adopted in Phase 3; existing individual Zstandard objects and recovery remain fully compatible.
