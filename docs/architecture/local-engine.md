# Phase 2 local engine

This implementation operates exclusively in minted `attuner-lab-*` directories directly under the canonical OS temporary directory. Discovery recognizes an explicit `attuner-synthetic` descriptor, not a WoW installation layout. No public native command accepts a filesystem path. No real installation was inspected or changed during implementation or tests.

## Boundaries

`crates/sync-core` depends on filesystem, hashing, compression, Unicode, SQLite, serialization, error and tracing libraries. It has no Tauri, React, HTTP or async-runtime dependency. Tauri owns scheduling and presentation; comparison and durability decisions remain in Rust.

| Module              | Responsibility                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `protocol`          | Existing manifest wire types, BLAKE3 vectors and portable path rules; unchanged TypeScript conformance                   |
| `workspace`         | Private temp roots, marker/identity validation, capability-relative no-follow I/O, same-volume checks and operation lock |
| `adapter`           | Strict versioned fixture descriptor; v1 `ProfileData`/`Extensions`, v2 `Configuration`/`Modules` mappings                |
| `control`, `error`  | Typed failures, cooperative cancellation, continuously checked synthetic runtime state and structured checkpoints        |
| `scan`              | Bounded inventory, streaming byte hashes, stability checks and private complete-scan receipts                            |
| `compare`           | Sorted add/modify/delete and three-way conflict decisions, including modification/deletion and addon-group conflicts     |
| `store`             | SQLite migration, installation mappings, scans, immutable snapshots, baseline and journal state                          |
| `backup`            | Checksum-enabled Zstandard CAS, bounded decompression, BLAKE3 verification and staging                                   |
| `engine`            | Coordinated public operations and resource preflight                                                                     |
| `apply`, `recovery` | Durable intent, preimages, no-clobber publication and explicit resumable rollback                                        |

## Scanning and comparison

All configured roots must exist and be readable. The scanner inventories supported entries, hashes files using a 64 KiB buffer, checks file identity/size/mtime, repeats the inventory, hashes every file again, and checks the final inventory. It rejects a changed tree rather than emitting a partial manifest. Complete receipts are constructed only by the scanner and bind the workspace and adapter coverage. Snapshot capture and application revalidate their receipts. A missing root therefore cannot be interpreted as a series of deletions.

Default limits are 1 GiB per file, 4 GiB total, 100,000 entries, depth 64 and a 16 MiB disk reserve. File bytes are streamed; manifest metadata is retained up to these configured bounds. This is a stability check, not a filesystem-wide atomic snapshot or a substitute for excluding the game writer.

Absolute paths, traversal, nonportable/reserved names, non-NFC names, conservative NFKC case-fold collisions, symlinks, hard links, cross-device directories and unsupported entries fail closed. Directory segments are opened without following links. Windows reparse checks exist in the shared I/O boundary, but Windows operations remain disabled and are not qualified by these Unix tests.

Three-way comparison considers baseline/local/remote manifests without performing network I/O. One-sided changes can merge; different concurrent bytes and modification/deletion combinations are explicit conflicts. Different concurrent changes in one addon group conservatively require review. Conflicted output has no silently usable merged manifest. Lua is never parsed, executed or merged.

## Persistence and backups

The independent Rust SQLite store uses bundled SQLite 3.54.1, WAL, `synchronous=FULL`, foreign keys and schema version 1. Snapshot manifests carry a digest and SQL triggers prevent snapshot update/deletion. Local baseline changes and completed operation state are transactional. This store is separate from the Phase 1 server database.

Objects use the original-byte BLAKE3 digest as their name. Zstandard level 3 includes a checksum. Compression checks the source size/hash, flushes each object and verifies the compressed result before private CAS promotion. Staging writes to private temporary names and publishes only complete verified files, so a crash during recovery staging can be retried. The object directory is synced before publishing any snapshot or prepared-operation reference in SQLite. Verification caps compressed input, decompressor window (8 MiB) and output length, then checks the original digest. Empty files, binary bytes and CRLF are preserved.

Space preflight uses actual filesystem availability, with a test-only lower budget. It is conservative and cannot reserve disk blocks against other writers; real I/O errors still propagate. Orphan objects/stages and quarantine contents are retained. Retention, garbage collection and a storage quota are deferred.

## Application ordering

`Engine::apply_snapshot(target_id, expected_scan, control)` accepts an existing local snapshot. It does not accept arbitrary remote bytes or resolve a comparison conflict.

1. Acquire the workspace lock; refuse unresolved operations, unsafe runtime state, stale scans, unsupported topology and insufficient space.
2. Verify target objects, back up all preimages and fully stage the new bytes. Flush objects/stages before journaling a prepared operation.
3. Persist per-step intent before moving the existing file to private quarantine. Verify the evacuated preimage.
4. Publish the staged file with a hard link that fails if a competing destination exists. Remove the internal alias and sync affected directories. Deletion retains its verified preimage and quarantined original.
5. Mark each durable step, rescan the entire installation, and verify exact target content. Commit a new immutable snapshot, baseline and operation status together.

Multi-file application is recoverable, not globally atomic. Cancellation or runtime changes after preparation leave a recovery-required operation; no further ordinary scan/capture/apply is allowed until explicit recovery. A committed operation is not rolled back by calling recovery.

## Reopening and recovery

The library can reopen a marked temporary workspace using `Engine::reopen`. Inspect `operations()` and call `recover(operation_id, control)` for an incomplete operation. The native UI deliberately exposes neither path-based reopen nor apply/recover yet.

Recovery validates the journal against its before/target manifests and verifies all required preimage backups before changing managed files. It refuses any affected path containing unrecognized external bytes, rather than overwriting that edit or partially rolling back other paths. It recognizes a crash-created publication alias only through its recorded file identity. Rollback proceeds in reverse order with durable intent, retains displaced applied bytes in quarantine, restores verified preimages without clobbering new destinations, and records completion. Repeating recovery after interruption or completion is safe. Successful rollback leaves the original baseline unchanged.

When recovery refuses an external edit or corrupt backup, preserve the entire lab and its `state` directory. There is no force-overwrite or discard-recovery operation. An operator must inspect and preserve external edits, repair the recovery material from a trusted copy if available, and retry. Do not delete the journal or change a status row to bypass the guard.

## Host and platform limits

The six Tauri commands are status, create, scan, capture, verify and cancel. Blocking work runs off the UI thread; cancellation has a separate lock. Responses contain at most 100 files/changes and 20 snapshots. All remote dashboard operations remain simulated. No apply/restore, arbitrary path, filesystem plugin, shell plugin or network command was added.

Native lab state lasts for one application session; the library's reopen/recovery persistence is covered by automated tests. Lab directories remain temporary, can outlive the app and may be purged by the OS. They are not production backup storage.

Current qualification is macOS/Unix. Non-Unix fixture creation/application/recovery fails closed because durable directory syncing has no qualified implementation. Windows junction/durability tests and Linux native runs remain required. Ordinary file permissions are handled, but ACLs, xattrs, sparse extents and ownership preservation are outside the byte-preservation contract. File/directory topology replacement is refused.

Cancellation is cooperative between chunks/checkpoints and cannot interrupt an OS call already in progress. The fixture runtime guard is not process detection or a real game-launch interlock. Private permissions, capability-relative access and identity checks reduce accidental escape; this is not a security boundary against a privileged or malicious same-user process editing the private store. There is no hardware power-loss campaign, encryption at rest, backup replication or protection from loss of the entire volume. Real-installation support must remain disabled until those boundaries are designed and verified.
