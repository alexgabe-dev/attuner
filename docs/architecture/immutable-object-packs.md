# Proposed immutable object packs

Status: design only. Phase 3 retains the existing individual Zstandard object format. Profiling shows durable per-object flushes dominate first capture; relaxing those flushes is not an acceptable optimization.

## Format and publication

Use a versioned immutable pack containing independent bounded Zstandard frames. An index maps raw BLAKE3 identity to pack ID, offset, compressed length and original size. Pack identity and index digest are content-verified. Preserve 64 KiB streaming, the existing raw-size caps and 8 MiB decoder-window cap. Bound pack/index working memory and target pack sizes; never buffer a whole tree or trust arbitrary offsets from remote metadata.

Write a uniquely named private pack and index, verify every original object, sync both files, promote their immutable names and sync the object directory. Only then may one SQLite transaction publish object locations and snapshot references. A crash before the transaction leaves unreferenced files; it never creates a recovery reference to unflushed bytes. A published pack is never appended to or modified.

Lookup accepts both legacy `<hash>.zst` and versioned pack locations. Every decode validates local index bounds, compressed-frame boundaries, original size and full BLAKE3. Local application continues to stage and verify the exact bytes before its existing journal/preimage protocol. The pack index cannot grant ambient filesystem access.

## Reuse and retention

Warm capture continues to hash the managed tree under the existing stability proof. Already verified immutable content is reused without compression or transfer. A new pack contains only genuinely new identities; metadata timestamps/watchers alone never prove unchanged managed bytes.

No pack compaction/deletion occurs while any immutable snapshot, preimage, operation, remote baseline or acknowledgement outbox can reference it. Initial adoption should retain all legacy objects/packs. Reference-aware GC is a separate explicit design and audit boundary.

## Adoption gates

Require legacy/new/mixed restore compatibility; bounds and corrupted index/frame tests; crash and SIGKILL at every pack/index/promotion/database boundary; interrupted recovery; disk exhaustion; concurrent creation; and complete original-byte verification after rollback. Run the same qualification independently on each enabled platform. Compare cold-CAS and warm-CAS workloads separately and measure cache-cold/WAN cases honestly. Do not adopt packs merely because a microbenchmark improves.
