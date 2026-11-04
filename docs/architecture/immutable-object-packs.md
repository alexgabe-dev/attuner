# Proposed immutable object packs

Status: isolated Phase 4 prototype, **not adopted**. Phase 3/production engine retains the existing individual Zstandard object format. Profiling shows durable per-object flushes dominate first capture; relaxing those flushes is not an acceptable optimization.

## Format and publication

Use a versioned immutable pack containing independent bounded Zstandard frames. An index maps raw BLAKE3 identity to pack ID, offset, compressed length and original size. Pack identity and index digest are content-verified. Preserve 64 KiB streaming, the existing raw-size caps and 8 MiB decoder-window cap. Bound pack/index working memory and target pack sizes; never buffer a whole tree or trust arbitrary offsets from remote metadata.

Write a uniquely named private pack and index, verify every original object, sync both files, promote their immutable names and sync the object directory. Only then may one SQLite transaction publish object locations and snapshot references. A crash before the transaction leaves unreferenced files; it never creates a recovery reference to unflushed bytes. A published pack is never appended to or modified.

Lookup accepts both legacy `<hash>.zst` and versioned pack locations. Every decode validates local index bounds, compressed-frame boundaries, original size and full BLAKE3. Local application continues to stage and verify the exact bytes before its existing journal/preimage protocol. The pack index cannot grant ambient filesystem access.

## Reuse and retention

Warm capture continues to hash the managed tree under the existing stability proof. Already verified immutable content is reused without compression or transfer. A new pack contains only genuinely new identities; metadata timestamps/watchers alone never prove unchanged managed bytes.

No pack compaction/deletion occurs while any immutable snapshot, preimage, operation, remote baseline or acknowledgement outbox can reference it. Initial adoption should retain all legacy objects/packs. Reference-aware GC is a separate explicit design and audit boundary.

## Adoption gates

Require legacy/new/mixed restore compatibility; bounds and corrupted index/frame tests; crash and SIGKILL at every pack/index/promotion/database boundary; interrupted recovery; disk exhaustion; concurrent creation; and complete original-byte verification after rollback. Run the same qualification independently on each enabled platform. Compare cold-CAS and warm-CAS workloads separately and measure cache-cold/WAN cases honestly. Do not adopt packs merely because a microbenchmark improves.

## Phase 4 laboratory boundary

`attuner-object-pack-lab` has no dependency from the engine, API, client or desktop. Its only public workspace constructor mints an owned temporary synthetic directory. It is Unix-only, has a separate SQLite catalog and accepts no real installation/remote paths. This deliberately avoids introducing an unqualified storage migration or weakening production capability traversal.

The prototype uses at most 2,048 independent frames per pack, a 16 MiB compressed-size target, 130 MiB hard pack cap, 128 MiB original-object cap, 512 KiB index cap, 20,000 synthetic-file cap, 64 KiB I/O buffers and an 8 MiB decoder-window limit. Pack/index/raw identities use BLAKE3. The index requires exact contiguous nonoverlapping frame bounds, unique hashes, matching object sizes and exact end-of-file. Single-frame decoding rejects concatenated frames and trailing bytes. Warm capture hashes the complete source twice and verifies existing content; it never treats timestamps as content proof or recompresses known identities.

Publication verifies each frame, flushes pack and index, promotes with no-clobber semantics, flushes the object directory and then atomically commits catalog locations/snapshot references with SQLite `synchronous=FULL`. Retrying a promoted orphan rebuilds/verifies its expected frames and compares the entire existing immutable file; an unrelated collision is retained/refused. No GC/compaction exists. The laboratory does not claim the production engine's multi-file rollback or game-state guarantees.

Seven automated parent tests cover legacy/new/mixed original-byte reads, zero-byte content, pack splitting, warm reuse, nine corruption/metadata cases, exact frame boundaries, links, cancellation, simulated ENOSPC/short writes, changing source bytes and no-clobber collision refusal. A real SIGKILL matrix stops ten child processes at scan, frame write/verify, both file flushes, both promotions, directory flush and before/after SQLite commit. It checks the old snapshot after every interruption, the new snapshot only after commit, and verified retry. The ignored child entry is invoked only by that matrix.

Adoption remains blocked on full engine/journal/rollback integration, independent filesystem/platform and hardware durability qualification, migration/retention review and controlled cold-cache/WAN evidence. See [Phase 4 performance](../operations/phase-4-performance.md).
