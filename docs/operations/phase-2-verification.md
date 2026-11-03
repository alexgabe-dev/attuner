# Phase 2 verification

Verified 3 November 2026 on Apple Silicon macOS using the repository-pinned Node 24.22.2, pnpm 10.33.4 and Rust 1.99.1. All managed-file integration operations used isolated synthetic temporary directories. No real installation was read, changed or deleted. No server synchronization, automatic synchronization or deployment was enabled.

## Implemented scope

The Rust engine now provides versioned fixture discovery, complete double-pass BLAKE3 manifests, deterministic changes, three-way conflicts, SQLite mappings/baselines/snapshots/journals, verified Zstandard backups, staged snapshot application and explicit restart recovery. It is independent of Tauri, React and the API. See [module boundaries and recovery procedure](../architecture/local-engine.md) and the [implementation plan](../architecture/phase-2-plan.md).

The native app adds a real local lab with create/scan/capture/verify/cancel commands, bounded file/change results and snapshot history. Apply and recovery remain Rust-library operations, exercised by tests; neither is exposed through Tauri. Remote demo and all web synchronization remain simulated. The native fixture runtime is explicitly labeled and is not real game detection.

## Automated results

| Check                                                            | Result                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `cargo test --workspace --locked`                                | 39 passed: 7 core unit, 16 foundation integration, 15 recovery integration, 1 native-host unit              |
| Ignored Rust helper entrypoints                                  | 2; intentionally invoked by parent tests as isolated subprocess harnesses, not omitted coverage             |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | Passed                                                                                                      |
| `cargo fmt --all -- --check`                                     | Passed                                                                                                      |
| `pnpm format:check`                                              | Passed                                                                                                      |
| `pnpm lint`                                                      | Passed, zero warnings                                                                                       |
| `pnpm typecheck`                                                 | Passed across workspaces and tool configuration                                                             |
| `pnpm test`                                                      | 36 passed, including TypeScript protocol fixtures, API, database migration/constraint tests and shared data |
| `pnpm build`                                                     | Next.js, Vite desktop assets, Fastify and shared packages passed                                            |
| `pnpm test:e2e`                                                  | 50 passed, 6 skipped in 24.5 seconds                                                                        |
| `pnpm --filter @attuner/desktop tauri build --debug`             | Passed; final standalone `.app` 36.68 MiB                                                                   |

The six Playwright skips are the two new native-lab browser tests on each of the three non-desktop projects. Existing responsive coverage runs at 1440, 1180, 768 and 390 pixels and includes axe accessibility checks. Browser bridge stubs test rendering and interaction only; actual Rust I/O is verified by Rust tests and native app inspection. No Windows or Linux-native test run is claimed.

## Failure and recovery evidence

| Scenario                           | Evidence / assertion                                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interrupted apply                  | Faults at 15 prepared/intent/evacuation/publication/durable-step/verification/commit boundaries; reopen, explicit rollback and repeated rollback return exact before bytes and baseline |
| Process exit without destructors   | Child exits with code 73 at seven boundaries, including after commit; incomplete work recovers, committed work retains the target                                                       |
| Hard kill                          | Three child processes are killed at publication, recovery staging and rollback evacuation; reopened journal recovers exact original manifest                                            |
| Interrupted recovery               | Cancellation at recovery intent, evacuation and installation; reopen and retry are idempotent                                                                                           |
| Insufficient space / partial write | Zero available test budget prevents mutation; injected `StorageFull` after an apply or recovery staging chunk leaves managed files unchanged and recovery can be retried                |
| Concurrent writer                  | Stale receipt refused; racing destination creation is never overwritten; unknown edits refuse rollback before other touched files change                                                |
| Failed final verification          | An unrelated new file makes apply require recovery; rollback preserves that independent addition and original baseline                                                                  |
| Corrupt backup                     | Damaged/truncated compressed objects fail verification; corrupt required preimages refuse rollback                                                                                      |
| Unsafe/incomplete tree             | Missing roots, symlinks, hard links, Unicode collisions, nonportable paths, FIFO and configured limits fail closed                                                                      |
| Scan race                          | Same-size content edit with restored mtime is detected by the second hash pass; a late addition during verification is rejected by the final inventory                                  |
| Runtime / cancellation             | Running or unknown synthetic runtime and cancellation reject operations; mid-apply runtime change requires recovery                                                                     |
| Persistence / byte preservation    | Reopen metadata, immutable snapshot SQL triggers, CRLF, binary and zero-byte files verified                                                                                             |

Tests are in [foundation.rs](../../crates/sync-core/tests/foundation.rs), [recovery.rs](../../crates/sync-core/tests/recovery.rs) and [native lab host](../../apps/desktop/src-tauri/src/lab.rs). Failure hooks inject deterministic errors; they do not simulate every hardware fault. SIGKILL is an actual process termination, but no physical power-loss test or real full-volume exhaustion was performed.

## Performance

Release build, one warm-cache run on the development Mac. The fixture contains 10,000 distinct 4 KiB files, one 128 MiB file and three seed files: **10,004 files / 175,177,882 bytes (167.06 MiB)**. Scan hashes all bytes twice with a 64 KiB buffer. Logical scan throughput counts fixture bytes once, not physical reads.

| Operation                                                    |                     Measured |
| ------------------------------------------------------------ | ---------------------------: |
| Complete scan                                                |                  1,188.74 ms |
| Logical scan throughput                                      |                 140.54 MiB/s |
| Durable snapshot capture                                     |                 48,058.80 ms |
| Verify all compressed backups                                |                    512.54 ms |
| Apply one small changed file, including full-tree validation |                  5,016.55 ms |
| Process maximum RSS                                          | 56,950,784 bytes (54.31 MiB) |
| Whole benchmark elapsed, including fixture provisioning      |                      62.13 s |

Snapshot creation remains expensive for thousands of distinct small files because each object is flushed and verified. Directory-entry flushing is batched before publishing database references; individual object durability remains required. The initial measurement was 85.16 seconds for capture; this is a useful local observation, not a controlled statistical comparison. No cross-machine or cold-cache performance claim is made.

Raw evidence: [final metrics](../../artifacts/phase-2-benchmark.json), [resource measurements](../../artifacts/phase-2-benchmark-resources.txt), [initial metrics](../../artifacts/phase-2-benchmark-initial.json). Reproduce only in the synthetic workspace:

```sh
source scripts/env.sh
cargo build -p attuner-sync-core --example fixture_benchmark --release
/usr/bin/time -l target/release/examples/fixture_benchmark
```

The benchmark removes only its own freshly minted temporary fixture after closing the engine.

## Rendered native verification

The final packaged app was launched and inspected through the macOS accessibility tree and actual screenshots. The workflow created a fresh lab, scanned 3 files / 154 bytes, displayed 3 additions, captured snapshot #1, showed zero baseline changes, verified all 3 compressed objects and displayed stored history. Typography, alignment, truncation, state labels and table density follow the existing shared design system. The native UI was not redesigned.

- [Native complete scan](../../artifacts/phase-2-native-scan.png)
- [Native snapshot history and verified backup](../../artifacts/phase-2-native-history.png)

The responsive web UI remains the existing remote demo; its regression checks passed. Native cancellation and resource bounds also have Rust coverage; tiny three-file manual operations finish too quickly to demonstrate a visible cancellation race.

## Remaining limitations and security concerns

- Only minted synthetic workspaces and two versioned synthetic adapters are supported. There is no real game process interlock, installation picker or production backup directory.
- Windows durable operations fail closed. Windows junction/native recovery qualification and Linux-native verification remain outstanding.
- Same-user malicious modification of private state and privileged attackers are outside the current boundary. Multi-file application is recoverable, not atomically visible as one transaction.
- Filesystem flushes and SQLite FULL ordering are tested through process crashes, not physical power loss. A lost volume loses local backups. Backups are not encrypted or replicated.
- ACLs/xattrs/ownership and file-to-directory topology changes are not supported. File bytes are preserved exactly.
- Native lab sessions do not reattach after app restart, although library reopen/recovery is tested. Temp directories may be OS-purged. No retention/GC/quota management exists yet.
- Snapshot capture has substantial small-file durability overhead; cancellation is cooperative and cannot interrupt a blocked OS call.
- No public deployment, signing/notarization, remote authentication or production synchronization is included.

The recommended next scope is [Phase 3 synthetic-client backend synchronization](../architecture/phase-3-plan.md), with immutable revisions, verified blobs, authorization, idempotency and explicit conflict review. Real installation integration should remain disabled.
